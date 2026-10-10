// E148: browser copy of src/key-ip/address.js; equality is checked in web/tests/key-ip.test.mjs.
// E148: shared, browser-safe IP parsing. No DNS lookups or address storage.
function ipv4(text) {
  const parts = text.split('.');
  if (parts.length !== 4 || parts.some(part => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) return null;
  return parts.reduce((value, part) => (value << 8n) | BigInt(part), 0n);
}

export function parseIp(text) {
  if (typeof text !== 'string' || !text || text.includes('%')) return null;
  if (!text.includes(':')) {
    const value = ipv4(text);
    return value === null ? null : { bits: 32, value };
  }
  let address = text;
  if (address.includes('.')) {
    const lastColon = address.lastIndexOf(':');
    const tail = ipv4(address.slice(lastColon + 1));
    if (tail === null) return null;
    address = address.slice(0, lastColon + 1) + (tail >> 16n).toString(16) + ':' + (tail & 65535n).toString(16);
  }
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if ([...left, ...right].some(part => !/^[\da-f]{1,4}$/i.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const parts = [...left, ...Array(missing).fill('0'), ...right];
  const value = parts.reduce((total, part) => (total << 16n) | BigInt('0x' + part), 0n);
  return { bits: 128, value };
}

export function parseIpRange(text) {
  if (typeof text !== 'string' || text !== text.trim() || text.length > 64) return null;
  const [address, prefix, extra] = text.split('/');
  if (extra !== undefined || (prefix !== undefined && !/^(0|[1-9]\d{0,2})$/.test(prefix))) return null;
  const ip = parseIp(address);
  if (!ip) return null;
  const length = prefix === undefined ? ip.bits : Number(prefix);
  if (length > ip.bits) return null;
  return { ...ip, prefix: length };
}

function unmapped(ip) {
  return ip.bits === 128 && ip.value >> 32n === 65535n ? { bits: 32, value: ip.value & 4294967295n } : ip;
}

export function ipAllowed(address, entries) {
  const parsed = parseIp(address);
  if (!parsed) return false;
  const ip = unmapped(parsed);
  return entries.some(entry => {
    let range = parseIpRange(entry);
    if (!range) return false;
    if (range.bits === 128 && range.value >> 32n === 65535n && range.prefix >= 96)
      range = { ...unmapped(range), prefix: range.prefix - 96 };
    if (range.bits !== ip.bits) return false;
    const shift = BigInt(range.bits - range.prefix);
    return ip.value >> shift === range.value >> shift;
  });
}

export function allowlistFromLines(text) {
  const entries = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (entries.length > 32) throw new Error('Use at most 32 IP addresses or ranges.');
  if (entries.some(entry => !parseIpRange(entry))) throw new Error('Enter a valid IPv4 or IPv6 address or CIDR range on each line.');
  return entries.length ? entries : null;
}

// E148: editor operations.
export async function addCurrentIp(request, text) {
  const result = await request('/api/v1/keys/current-ip');
  const address = result?.data?.ip;
  if (!parseIp(address)) throw new Error('Your client IP address is not available on this connection.');
  const entries = allowlistFromLines(text) ?? [];
  if (!entries.includes(address)) entries.push(address);
  allowlistFromLines(entries.join('\n'));
  return entries.join('\n');
}

export async function saveKeyAllowedIps(request, keyHash, text) {
  const allowed_ips = allowlistFromLines(text);
  await request('/api/v1/keys/' + encodeURIComponent(keyHash), { method: 'PATCH', body: { allowed_ips } });
  return allowed_ips;
}
