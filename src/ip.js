// IPv4 and IPv6 parsing for the allowlist. Addresses are BigInt values so a
// range check is a single mask and compare.

const BITS = { 4: 32, 6: 128 };
// The broadest ranges an allowlist entry may use, so nobody allows "everyone" by mistake.
export const MIN_PREFIX = { 4: 8, 6: 32 };

function parseV4(text) {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    // Reject leading zeros: some tools read "010" as octal.
    if (!/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255) return null;
    value = (value << 8n) | BigInt(part);
  }
  return value;
}

function parseV6(input) {
  let text = input;
  if (!/^[0-9a-f:.]+$/i.test(text) || !text.includes(':')) return null;
  if (text.includes('.')) {
    const index = text.lastIndexOf(':');
    const v4 = parseV4(text.slice(index + 1));
    if (v4 === null) return null;
    text = `${text.slice(0, index + 1)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    value = (value << 16n) | BigInt(Number.parseInt(group, 16));
  }
  return value;
}

export function parseAddress(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (text.includes(':')) {
    const value = parseV6(text);
    return value === null ? null : { version: 6, value };
  }
  const value = parseV4(text);
  return value === null ? null : { version: 4, value };
}

// Visitor addresses: treat IPv4-mapped IPv6 (::ffff:a.b.c.d) as plain IPv4.
export function parseClientIp(input) {
  const address = parseAddress(input ?? '');
  if (address?.version === 6 && address.value >> 32n === 0xffffn) {
    return { version: 4, value: address.value & 0xffffffffn };
  }
  return address;
}

const maskFor = (version, prefix) => {
  const bits = BITS[version];
  return prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(bits - prefix);
};

export function parseRange(input) {
  if (typeof input !== 'string') return null;
  const parts = input.trim().split('/');
  if (parts.length > 2) return null;
  const address = parseAddress(parts[0]);
  if (!address) return null;
  let prefix = BITS[address.version];
  if (parts.length === 2) {
    if (!/^\d{1,3}$/.test(parts[1])) return null;
    prefix = Number(parts[1]);
    if (prefix > BITS[address.version]) return null;
  }
  return { version: address.version, prefix, network: address.value & maskFor(address.version, prefix) };
}

export function formatAddress({ version, value }) {
  if (version === 4) {
    return [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 0xffn)).join('.');
  }
  const groups = Array.from({ length: 8 }, (_, index) => Number((value >> BigInt(112 - index * 16)) & 0xffffn));
  // Compress the longest run of two or more zero groups (RFC 5952).
  let bestStart = -1;
  let bestLength = 1;
  for (let start = 0; start < 8;) {
    if (groups[start] !== 0) {
      start++;
      continue;
    }
    let end = start;
    while (end < 8 && groups[end] === 0) end++;
    if (end - start > bestLength) {
      bestStart = start;
      bestLength = end - start;
    }
    start = end;
  }
  const hex = groups.map((group) => group.toString(16));
  if (bestStart === -1) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLength).join(':')}`;
}

export const formatRange = (range) => `${formatAddress({ version: range.version, value: range.network })}/${range.prefix}`;

export function rangeContains(range, address) {
  return range.version === address.version
    && (address.value & maskFor(range.version, range.prefix)) === range.network;
}

// IPv6 devices rotate addresses within their /64, so suggest the network instead.
export function suggestedRange(address) {
  const prefix = address.version === 6 ? 64 : 32;
  return formatRange({ version: address.version, prefix, network: address.value & maskFor(address.version, prefix) });
}
