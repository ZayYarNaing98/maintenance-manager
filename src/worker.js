export { DomainPolicy } from './domain-policy.js';
export { DomainRegistry } from './domain-registry.js';
import { CloudflareApi, CloudflareError, cloudflareConfigured, zoneFor } from './cloudflare.js';
import { formatAddress, parseClientIp, parseRange, rangeContains, suggestedRange } from './ip.js';
import { MIN_PASSWORD_LENGTH, validateAllowlist, validateLogin, validateNewDomain, validatePatch } from './policy.js';

const noStore = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const adminAssets = new Map([['/', '/index.html'], ['/dashboard.js', '/dashboard.js'], ['/dashboard.css', '/dashboard.css'], ['/theme.js', '/theme.js']]);
const textEncoder = new TextEncoder();

const json = (value, status = 200) => Response.json(value, { status, headers: noStore });
const error = (message, status) => json({ error: message }, status);

function challenge(realm) {
  return new Response('Authentication required.', {
    status: 401,
    headers: { ...noStore, 'WWW-Authenticate': `Basic realm="${realm}", charset="UTF-8"` },
  });
}

async function matchesSecret(candidate, secret) {
  if (typeof secret !== 'string' || !secret || !candidate || candidate.length > 8192) return false;
  const [actual, expected] = await Promise.all(
    [candidate, secret].map((value) => crypto.subtle.digest('SHA-256', textEncoder.encode(value))),
  );
  return crypto.subtle.timingSafeEqual(actual, expected);
}

function basicCredentials(header) {
  const match = /^Basic ([A-Za-z0-9+/=]+)$/i.exec(header ?? '');
  if (!match || match[1].length > 8192) return null;
  try {
    const bytes = Uint8Array.from(atob(match[1]), (character) => character.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function validBasicSecret(value) {
  return typeof value === 'string' && /^[^:\r\n]+:[^\r\n]+$/.test(value);
}

const toBase64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromBase64 = (text) => Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
const loginDigest = (salt, credentials) => crypto.subtle.digest(
  'SHA-256',
  new Uint8Array([...salt, ...textEncoder.encode(credentials)]),
);

async function createLogin({ username, password }) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return {
    username,
    salt: toBase64(salt),
    hash: toBase64(await loginDigest(salt, `${username}:${password}`)),
    updatedAt: new Date().toISOString(),
  };
}

// A login saved in the dashboard replaces the domain's deploy-time secret.
function loginSource(env, domain, policy) {
  if (policy.login) return 'dashboard';
  return validBasicSecret(env[domain.credential]) ? 'secret' : 'none';
}

async function hasAccess(env, domain, policy, header) {
  const credentials = basicCredentials(header);
  if (!policy.login) return matchesSecret(credentials, env[domain.credential]);
  if (!credentials || credentials.length > 8192) return false;
  const actual = await loginDigest(fromBase64(policy.login.salt), credentials);
  return crypto.subtle.timingSafeEqual(actual, fromBase64(policy.login.hash));
}

// Parsed allowlists, reused while a domain's policy revision is unchanged.
const allowlistCache = new Map();

function clientAllowed(request, domain, policy) {
  if (!policy.allowlist?.length) return false;
  // Cloudflare sets this header to the visitor's address and overwrites any client-sent value.
  const client = parseClientIp(request.headers.get('CF-Connecting-IP'));
  if (!client) return false;
  let cached = allowlistCache.get(domain.hostname);
  if (cached?.revision !== policy.revision) {
    cached = { revision: policy.revision, ranges: policy.allowlist.map((entry) => parseRange(entry.cidr)).filter(Boolean) };
    allowlistCache.set(domain.hostname, cached);
  }
  return cached.ranges.some((range) => rangeContains(range, client));
}

function expectedRevision(request) {
  const match = request.headers.get('If-Match');
  if (match === null) return null;
  return /^"\d{1,15}"$/.test(match) ? Number(match.slice(1, -1)) : undefined;
}

function publicPolicy(env, domain, policy) {
  const { login, ...rest } = policy;
  return {
    ...rest,
    login: login ? { username: login.username, updatedAt: login.updatedAt } : null,
    loginSource: loginSource(env, domain, policy),
  };
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function maintenancePage(request, policy) {
  const headers = new Headers({
    ...noStore,
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  });
  if (policy.retryAfterAt && Date.parse(policy.retryAfterAt) > Date.now()) {
    headers.set('Retry-After', new Date(policy.retryAfterAt).toUTCString());
  }
  const body = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Scheduled maintenance</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f7f5;color:#162a24;font:1rem/1.6 system-ui,sans-serif}
main{width:min(36rem,calc(100% - 3rem));padding-block:3rem}h1{font-size:clamp(2rem,7vw,3.5rem);line-height:1.05;margin:0 0 1rem}p{white-space:pre-wrap;overflow-wrap:anywhere}
</style><main><h1>Scheduled maintenance</h1><p>${escapeHtml(policy.maintenanceMessage)}</p></main></html>`;
  return new Response(request.method === 'HEAD' ? null : body, { status: 503, headers });
}

// The managed domains, cached briefly so each request does not wait on the registry.
const REGISTRY_TTL_MS = 5000;
let registryCache = null;
const registryObject = (env) => env.REGISTRY.get(env.REGISTRY.idFromName('registry'));

async function managedDomains(env) {
  if (registryCache && Date.now() - registryCache.at < REGISTRY_TTL_MS) return registryCache.domains;
  const domains = await registryObject(env).list(env.DOMAINS ?? []);
  registryCache = { at: Date.now(), domains };
  return domains;
}

const rememberDomains = (domains) => { registryCache = { at: Date.now(), domains }; };
const hostnamesOf = (domain) => [domain.hostname, ...(domain.aliases ?? []), ...(domain.preview ? [domain.preview] : [])];

// App Workers the manager can forward to. APPS names them; without it, use the seeded bindings.
function availableApps(env) {
  const apps = env.APPS ?? [...new Set((env.DOMAINS ?? []).map((entry) => entry.service).filter(Boolean))]
    .map((binding) => ({ binding, worker: binding }));
  return apps.filter((app) => typeof env[app.binding]?.fetch === 'function');
}

function publicDomain(env, { hostname, preview = null, aliases = [], service = null }) {
  const app = (env.APPS ?? []).find((item) => item.binding === service);
  return { hostname, preview, aliases, service, worker: app?.worker ?? service };
}

function policyObject(env, domain) {
  return env.POLICIES.get(env.POLICIES.idFromName(domain.hostname));
}

async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') ?? '')) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) {
        await reader.cancel();
        return null;
      }
      body += decoder.decode(value, { stream: true });
    }
    return JSON.parse(body + decoder.decode());
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

async function serveAdmin(request, env, url) {
  const { pathname } = url;
  const domains = await managedDomains(env);
  const forPath = (suffix) => domains.find((entry) => pathname === `/api/domains/${entry.hostname}${suffix}`);
  const domain = forPath('');
  const loginDomain = forPath('/login');
  const allowDomain = forPath('/allowlist');
  const connectDomain = forPath('/connect');
  const authorization = request.headers.get('Authorization');
  const release = request.method === 'PATCH' && domain && env.RELEASE_DOMAIN === domain.hostname
    && authorization?.startsWith('Bearer ')
    && await matchesSecret(authorization.slice(7), env.RELEASE_TOKEN);

  let actor = 'deployment';
  if (!release) {
    if (!validBasicSecret(env.ADMIN_BASIC)) return error('Admin credentials are unavailable.', 503);
    const credentials = basicCredentials(authorization);
    if (!await matchesSecret(credentials, env.ADMIN_BASIC)) return challenge('Maintenance administration');
    actor = credentials.slice(0, credentials.indexOf(':'));
  }

  const writing = (request.method === 'PATCH' && domain) || (request.method === 'PUT' && (loginDomain || allowDomain))
    || (request.method === 'DELETE' && domain) || (request.method === 'POST' && (connectDomain || pathname === '/api/domains'));
  if (writing) {
    const origin = request.headers.get('Origin');
    if ((origin !== null && origin !== url.origin) || request.headers.get('Sec-Fetch-Site') === 'cross-site') {
      return error('Cross-origin updates are unavailable.', 403);
    }
  }

  if (request.method === 'POST' && pathname === '/api/domains') {
    if (!cloudflareConfigured(env)) return error('Set the CLOUDFLARE_API_TOKEN secret to add domains from the dashboard.', 503);
    const result = validateNewDomain(await readJson(request), availableApps(env).map((app) => app.binding));
    if (result.error) return error(result.error, 400);
    const entry = result.entry;
    const hosts = hostnamesOf(entry);
    if (hosts.includes(env.ADMIN_HOST)) return error(`${env.ADMIN_HOST} is the dashboard's own hostname.`, 409);
    const used = new Set(domains.flatMap(hostnamesOf));
    const clash = hosts.find((host) => used.has(host));
    if (clash) return error(`${clash} is already used by a listed domain.`, 409);
    const zone = zoneFor(env, hosts);
    if (!zone) return error(`Every hostname must be in one zone: ${env.ZONES.join(', ')}.`, 400);
    const api = new CloudflareApi(env);
    const { warnings } = await api.connect(zone, entry);
    const saved = await registryObject(env).add(entry, [env.ADMIN_HOST]);
    if (saved.conflict) {
      await api.disconnect(zone, entry).catch(() => {});
      return error(`${saved.conflict} is already used by a listed domain.`, 409);
    }
    rememberDomains(saved.domains);
    return json({ domain: publicDomain(env, entry), warnings }, 201);
  }

  if (request.method === 'DELETE' && domain) {
    if (!cloudflareConfigured(env)) return error('Set the CLOUDFLARE_API_TOKEN secret to remove domains from the dashboard.', 503);
    if (env.RELEASE_DOMAIN === domain.hostname) {
      return error(`${domain.hostname} is the release domain for CI. Change RELEASE_DOMAIN before removing it.`, 409);
    }
    const zone = zoneFor(env, hostnamesOf(domain));
    const { warnings } = zone
      ? await new CloudflareApi(env).disconnect(zone, domain)
      : { warnings: ['This domain is outside the configured zones, so no routes were changed.'] };
    const saved = await registryObject(env).remove(domain.hostname);
    rememberDomains(saved.domains);
    // Settings and history stay in the domain's policy, so adding it again restores them.
    return json({ removed: domain.hostname, warnings });
  }

  if (request.method === 'POST' && connectDomain) {
    if (!cloudflareConfigured(env)) return error('Set the CLOUDFLARE_API_TOKEN secret to connect domains.', 503);
    const zone = zoneFor(env, hostnamesOf(connectDomain));
    if (!zone) return error(`Every hostname must be in one zone: ${env.ZONES.join(', ')}.`, 400);
    return json(await new CloudflareApi(env).connect(zone, connectDomain));
  }

  if (request.method === 'PUT' && loginDomain) {
    const login = validateLogin(await readJson(request));
    if (!login) {
      return error(`Send a username without a colon and a password of at least ${MIN_PASSWORD_LENGTH} characters.`, 400);
    }
    const result = await policyObject(env, loginDomain).setLogin(await createLogin(login), actor);
    return json(publicPolicy(env, loginDomain, result.policy));
  }

  if (request.method === 'PUT' && allowDomain) {
    const result = validateAllowlist(await readJson(request));
    if (result.error) return error(result.error, 400);
    const revision = expectedRevision(request);
    if (revision === undefined) return error('Invalid policy revision.', 400);
    const saved = await policyObject(env, allowDomain).setAllowlist(result.entries, actor, revision);
    if (saved.conflict) return error('This domain was updated elsewhere. Reload it before saving.', 412);
    return json(publicPolicy(env, allowDomain, saved.policy));
  }

  if (request.method === 'PATCH' && domain) {
    const patch = validatePatch(await readJson(request));
    if (!patch) return error('Send a JSON policy update with valid fields.', 400);
    if (release && (Object.keys(patch).length !== 1 || !Object.hasOwn(patch, 'maintenanceEnabled'))) {
      return error('The deployment identity can only set maintenance mode.', 403);
    }
    const stub = policyObject(env, domain);
    if (patch.basicAuthEnabled && loginSource(env, domain, await stub.getPolicy()) === 'none') {
      return error('Set a preview login before enabling Basic Auth.', 409);
    }
    const revision = expectedRevision(request);
    if (revision === undefined) return error('Invalid policy revision.', 400);
    const result = await stub.update(patch, actor, revision);
    if (result.conflict) return error('This policy was updated. Reload the domain before saving.', 412);
    return json(publicPolicy(env, domain, result.policy));
  }

  if (request.method === 'GET') {
    if (pathname === '/api/client-ip') {
      const client = parseClientIp(request.headers.get('CF-Connecting-IP'));
      return json(client ? { ip: formatAddress(client), suggested: suggestedRange(client) } : { ip: null, suggested: null });
    }
    if (pathname === '/api/domains') return json(domains.map((entry) => publicDomain(env, entry)));
    if (pathname === '/api/apps') {
      return json({ apps: availableApps(env), cloudflare: cloudflareConfigured(env), zones: env.ZONES ?? [] });
    }
    if (pathname === '/api/route-status') {
      if (!cloudflareConfigured(env)) return json({ configured: false, domains: {} });
      const api = new CloudflareApi(env);
      const status = {};
      for (const zone of env.ZONES) {
        const inZone = domains.filter((entry) => zoneFor(env, hostnamesOf(entry)) === zone);
        if (inZone.length) Object.assign(status, await api.status(zone, inZone));
      }
      return json({ configured: true, domains: status });
    }
    if (domain) return json(publicPolicy(env, domain, await policyObject(env, domain).getPolicy()));
    const auditDomain = forPath('/audit');
    if (auditDomain) return json(await policyObject(env, auditDomain).getAudit());
  }

  const asset = adminAssets.get(pathname);
  if (asset && ['GET', 'HEAD'].includes(request.method)) {
    const response = await env.ASSETS.fetch(new Request(new URL(asset, url), { method: request.method }));
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(noStore)) headers.set(key, value);
    headers.set('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    headers.set('Referrer-Policy', 'no-referrer');
    return new Response(response.body, { status: response.status, headers });
  }
  if (domain) return new Response('Method not allowed.', { status: 405, headers: { ...noStore, Allow: 'GET, PATCH, DELETE' } });
  if (connectDomain) return new Response('Method not allowed.', { status: 405, headers: { ...noStore, Allow: 'POST' } });
  if (loginDomain || allowDomain) return new Response('Method not allowed.', { status: 405, headers: { ...noStore, Allow: 'PUT' } });
  return error('Route not found.', 404);
}

async function serveDomain(request, env, url, domain) {
  const preview = url.hostname === domain.preview;
  const policy = await policyObject(env, domain).getPolicy();
  // An unmanaged domain passes straight through; its preview stays protected.
  const bypass = !preview && policy.managed === false;
  // Allowed IPs reach the public hostname as if it were open. The preview still needs its login.
  const open = bypass || (!preview && clientAllowed(request, domain, policy));
  if (!open && !preview && policy.maintenanceEnabled) return maintenancePage(request, policy);

  const protectedRequest = !open && (preview || policy.basicAuthEnabled);
  const headers = new Headers(request.headers);
  if (protectedRequest) {
    if (loginSource(env, domain, policy) === 'none') return error('Domain credentials are unavailable.', 503);
    if (!await hasAccess(env, domain, policy, headers.get('Authorization'))) {
      return challenge(preview ? 'Protected preview' : 'Protected site');
    }
    headers.delete('Authorization');
    headers.set('Cache-Control', 'no-store');
  }

  if (domain.demo && domain.hostname.endsWith('.localhost')) {
    return new Response(request.method === 'HEAD' ? null : 'Demo application is online.\n', {
      headers: { 'Content-Type': 'text/plain; charset=utf-8', ...noStore },
    });
  }

  const service = env[domain.service];
  if (!service?.fetch) return error('The application binding is unavailable.', 503);
  const upstreamUrl = new URL(url);
  // Aliases reach the app under their own hostname; the preview borrows the primary one.
  if (preview) upstreamUrl.hostname = domain.hostname;
  const upstream = await service.fetch(new Request(new Request(upstreamUrl, request), { headers, redirect: 'manual' }));
  if (!protectedRequest || upstream.webSocket) return upstream;
  const protectedResponse = new Response(upstream.body, upstream);
  protectedResponse.headers.set('Cache-Control', 'private, no-store');
  const location = upstream.headers.get('Location');
  if (preview && location && upstream.status >= 300 && upstream.status < 400) {
    try {
      const target = new URL(location, upstreamUrl);
      if (target.origin === upstreamUrl.origin) {
        target.host = url.host;
        protectedResponse.headers.set('Location', target.href);
      }
    } catch {
      // Preserve malformed or unsupported upstream redirects for the client.
    }
  }
  return protectedResponse;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const local = url.hostname === 'localhost' || url.hostname.endsWith('.localhost');
    if (url.protocol !== 'https:' && !local) {
      url.protocol = 'https:';
      return Response.redirect(url, 308);
    }
    try {
      if (url.hostname === env.ADMIN_HOST) return await serveAdmin(request, env, url);
      const domain = (await managedDomains(env)).find((entry) => hostnamesOf(entry).includes(url.hostname));
      if (domain) return await serveDomain(request, env, url, domain);
      return error('Domain not managed.', 404);
    } catch (failure) {
      if (failure instanceof CloudflareError) return error(failure.message, failure.status);
      return error('The maintenance service is temporarily unavailable.', 503);
    }
  },
};
