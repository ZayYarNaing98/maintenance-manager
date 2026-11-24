import { MIN_PREFIX, formatRange, parseRange } from './ip.js';

export const DEFAULT_POLICY = Object.freeze({
  managed: true,
  maintenanceEnabled: false,
  basicAuthEnabled: false,
  maintenanceMessage: 'We are performing scheduled maintenance. Please check back soon.',
  retryAfterAt: null,
  allowlist: Object.freeze([]),
  revision: 0,
});

const fields = ['managed', 'maintenanceEnabled', 'basicAuthEnabled', 'maintenanceMessage', 'retryAfterAt'];

export function validatePatch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (!keys.length || keys.some((key) => !fields.includes(key))) return null;

  for (const key of ['managed', 'maintenanceEnabled', 'basicAuthEnabled']) {
    if (Object.hasOwn(value, key) && typeof value[key] !== 'boolean') return null;
  }
  if (Object.hasOwn(value, 'maintenanceMessage')) {
    const message = value.maintenanceMessage;
    if (typeof message !== 'string' || !message.trim() || message.length > 500) return null;
    value.maintenanceMessage = message.trim();
  }
  if (Object.hasOwn(value, 'retryAfterAt') && value.retryAfterAt !== null) {
    const date = value.retryAfterAt;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(date)) return null;
    const time = Date.parse(date);
    if (!Number.isFinite(time) || new Date(time).toISOString() !== date) return null;
  }
  return value;
}

export const MIN_PASSWORD_LENGTH = 16;

// Preview logins set from the dashboard. Passwords must be long, so a salted
// SHA-256 digest is enough and keeps each request well inside the CPU limit.
export function validateLogin(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('username') || !keys.includes('password')) return null;
  const { username, password } = value;
  if (typeof username !== 'string' || !/^[^:\p{Cc}]{1,64}$/u.test(username)) return null;
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH || password.length > 256) return null;
  if (/\p{Cc}/u.test(password)) return null;
  return { username, password };
}

export const MAX_ALLOWED_IPS = 200;

// Normalizes each entry to its network, for example 198.51.100.7/24 -> 198.51.100.0/24,
// and drops repeats so the first label wins.
export function validateAllowlist(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.entries)
    || Object.keys(value).length !== 1) {
    return { error: 'Send JSON with an entries array.' };
  }
  const seen = new Set();
  const entries = [];
  for (const item of value.entries) {
    if (!item || typeof item !== 'object' || typeof item.ip !== 'string') {
      return { error: 'Each entry needs an ip value.' };
    }
    const label = item.label ?? '';
    if (typeof label !== 'string' || label.length > 60 || /\p{Cc}/u.test(label)) {
      return { error: `The label for "${item.ip}" must be text of up to 60 characters.` };
    }
    const range = parseRange(item.ip);
    if (!range) return { error: `"${item.ip.trim()}" is not a valid IP address or range.` };
    if (range.prefix < MIN_PREFIX[range.version]) {
      return { error: `"${item.ip.trim()}" is too broad. Use /${MIN_PREFIX[range.version]} or narrower.` };
    }
    const cidr = formatRange(range);
    if (seen.has(cidr)) continue;
    seen.add(cidr);
    entries.push({ cidr, label: label.trim() });
  }
  if (entries.length > MAX_ALLOWED_IPS) {
    return { error: `A domain can have at most ${MAX_ALLOWED_IPS} allowed IPs.` };
  }
  return { entries };
}

const HOST_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// A new domain from the dashboard: { hostname, service, aliases?, preview? }.
export function validateNewDomain(value, services) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'Send the domain as JSON.' };
  const host = (input) => (typeof input === 'string' ? input.trim().toLowerCase() : '');
  const hostname = host(value.hostname);
  if (!HOST_PATTERN.test(hostname)) return { error: 'Enter a valid public hostname, such as blog.example.com.' };
  if (value.aliases !== undefined && !Array.isArray(value.aliases)) return { error: 'Aliases must be a list.' };
  const aliases = [...new Set((value.aliases ?? []).map(host).filter(Boolean))];
  const invalidAlias = aliases.find((alias) => !HOST_PATTERN.test(alias));
  if (invalidAlias !== undefined) return { error: `"${invalidAlias}" is not a valid alias hostname.` };
  if (aliases.length > 10) return { error: 'A domain can have at most 10 aliases.' };
  let preview = null;
  if (value.preview !== undefined && value.preview !== null) {
    preview = host(value.preview);
    if (!HOST_PATTERN.test(preview)) return { error: 'Enter a valid preview hostname, or leave the preview off.' };
  }
  const all = [hostname, ...aliases, ...(preview ? [preview] : [])];
  if (new Set(all).size !== all.length) return { error: 'The hostname, aliases and preview must all differ.' };
  if (typeof value.service !== 'string' || !services.includes(value.service)) {
    return { error: 'Choose one of the connected app Workers.' };
  }
  return { entry: { hostname, ...(aliases.length ? { aliases } : {}), ...(preview ? { preview } : {}), service: value.service } };
}
