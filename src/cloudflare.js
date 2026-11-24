// Creates and removes the Cloudflare routes and preview DNS records for a domain.
// The token needs Zone Read, Workers Routes Edit and DNS Edit on the managed zones only.

export const DNS_COMMENT = 'Managed by maintenance-manager';
const API = 'https://api.cloudflare.com/client/v4';

export class CloudflareError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

export function cloudflareConfigured(env) {
  return typeof env.CLOUDFLARE_API_TOKEN === 'string' && env.CLOUDFLARE_API_TOKEN.length > 0
    && typeof env.WORKER_NAME === 'string' && Array.isArray(env.ZONES) && env.ZONES.length > 0;
}

// Returns the configured zone that contains every hostname, preferring the longest match.
export function zoneFor(env, hostnames) {
  const zones = [...(env.ZONES ?? [])].sort((a, b) => b.length - a.length);
  const inZone = (host, zone) => host === zone || host.endsWith(`.${zone}`);
  return zones.find((zone) => hostnames.every((host) => inZone(host, zone))) ?? null;
}

export const routePatterns = (domain) => [domain.hostname, ...(domain.aliases ?? []), ...(domain.preview ? [domain.preview] : [])]
  .map((host) => `${host}/*`);

const zoneIds = new Map();

export class CloudflareApi {
  constructor(env) {
    this.token = env.CLOUDFLARE_API_TOKEN;
    this.script = env.WORKER_NAME;
    // Tests bind a fake API; production uses the public endpoint.
    this.fetcher = env.CLOUDFLARE_API ?? globalThis;
  }

  async call(method, path, body) {
    let response;
    try {
      response = await this.fetcher.fetch(`${API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new CloudflareError('Cloudflare could not be reached. Try again.');
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.success) {
      const detail = payload?.errors?.map((item) => item.message).join(' ') || `HTTP ${response.status}`;
      const hint = response.status === 403 || response.status === 401
        ? ' Check that the API token has Zone Read, Workers Routes Edit and DNS Edit for this zone.'
        : '';
      throw new CloudflareError(`Cloudflare: ${detail}.${hint}`);
    }
    return payload.result;
  }

  async zoneId(name) {
    if (zoneIds.has(name)) return zoneIds.get(name);
    const zones = await this.call('GET', `/zones?name=${encodeURIComponent(name)}`);
    const id = zones?.[0]?.id;
    if (!id) throw new CloudflareError(`Cloudflare: the token cannot see the zone ${name}.`);
    zoneIds.set(name, id);
    return id;
  }

  listRoutes(zoneId) {
    return this.call('GET', `/zones/${zoneId}/workers/routes`);
  }

  async listDns(zoneId, name) {
    return this.call('GET', `/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}&per_page=100`);
  }

  // Reports which of a domain's route patterns are missing or point at another Worker.
  async status(zone, domains) {
    const routes = await this.listRoutes(await this.zoneId(zone));
    return Object.fromEntries(domains.map((domain) => {
      const missing = routePatterns(domain).filter((pattern) => !routes.some((route) => route.pattern === pattern && route.script === this.script));
      return [domain.hostname, { connected: missing.length === 0, missing }];
    }));
  }

  // Creates whatever is missing. Undoes its own changes if a later step fails.
  async connect(zone, domain) {
    const zoneId = await this.zoneId(zone);
    const routes = await this.listRoutes(zoneId);
    const patterns = routePatterns(domain);
    for (const pattern of patterns) {
      const existing = routes.find((route) => route.pattern === pattern);
      if (existing && existing.script !== this.script) {
        throw new CloudflareError(`The route ${pattern} already runs ${existing.script ? `the Worker ${existing.script}` : 'no Worker'}. Remove it in Cloudflare first.`, 409);
      }
    }

    const warnings = [];
    for (const host of [domain.hostname, ...(domain.aliases ?? [])]) {
      const records = await this.listDns(zoneId, host);
      if (!records.length) {
        warnings.push(`No DNS record was found for ${host}. If the app Worker does not have it as a custom domain, requests will not reach it.`);
      }
    }

    const created = [];
    try {
      if (domain.preview && !(await this.listDns(zoneId, domain.preview)).length) {
        try {
          // 100:: is Cloudflare's placeholder address for hostnames served only by Workers.
          const record = await this.call('POST', `/zones/${zoneId}/dns_records`, {
            type: 'AAAA', name: domain.preview, content: '100::', proxied: true, comment: DNS_COMMENT,
          });
          created.push(() => this.call('DELETE', `/zones/${zoneId}/dns_records/${record.id}`));
        } catch (error) {
          // A Worker custom domain owns the name already, which is enough for the route.
          if (!/already exists/i.test(error.message)) throw error;
        }
      }
      for (const pattern of patterns) {
        if (routes.some((route) => route.pattern === pattern)) continue;
        const route = await this.call('POST', `/zones/${zoneId}/workers/routes`, { pattern, script: this.script });
        created.push(() => this.call('DELETE', `/zones/${zoneId}/workers/routes/${route.id}`));
      }
    } catch (error) {
      for (const undo of created.reverse()) await undo().catch(() => {});
      throw error;
    }
    return { warnings };
  }

  // Deletes only this Worker's routes and DNS records it created. Safe to repeat.
  async disconnect(zone, domain) {
    const zoneId = await this.zoneId(zone);
    const patterns = new Set(routePatterns(domain));
    const routes = await this.listRoutes(zoneId);
    for (const route of routes) {
      if (patterns.has(route.pattern) && route.script === this.script) {
        await this.call('DELETE', `/zones/${zoneId}/workers/routes/${route.id}`);
      }
    }
    const warnings = [];
    if (domain.preview) {
      const records = await this.listDns(zoneId, domain.preview);
      for (const record of records.filter((item) => item.comment === DNS_COMMENT)) {
        await this.call('DELETE', `/zones/${zoneId}/dns_records/${record.id}`);
      }
      if (records.some((item) => item.comment !== DNS_COMMENT)) {
        warnings.push(`${domain.preview} still has a DNS record that this dashboard did not create, such as a Worker custom domain. Remove it in Cloudflare if it is no longer needed.`);
      }
    }
    return { warnings };
  }
}
