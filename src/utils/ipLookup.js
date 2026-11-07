'use strict';

/**
 * Where a sign-in came from, for the "unfamiliar sign-in" email: city, ISP,
 * and whether the address belongs to a VPN/proxy.
 *
 * 1. The IP address itself always comes from the request (req.ip — honours
 *    server.trustProxy, so behind a reverse proxy it's the real client).
 * 2. Location from the request: if Passport sits behind a proxy/CDN that
 *    adds visitor-location headers (e.g. Cloudflare's "Add visitor location
 *    headers": cf-ipcity, cf-region, cf-ipcountry) and
 *    ipLookup.trustLocationHeaders is on, those are used. Only turn that on
 *    when such a proxy is really in front — otherwise anyone could send
 *    the headers themselves.
 * 3. Anything still missing (always ISP and VPN, which no request carries)
 *    comes from proxycheck.io, unless ipLookup.proxycheck.enabled is off.
 *    That sends the sign-in's IP address to proxycheck.io.
 *
 * Never throws and never takes longer than the timeout: a lookup failure
 * just means "Unknown" in the email. Results are cached per IP for a day.
 */

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 1000;

const DEFAULT_HEADERS = { city: 'cf-ipcity', region: 'cf-region', country: 'cf-ipcountry' };

/** Loopback, private, link-local, CGNAT and unique-local addresses — nothing to look up. */
function isPrivateIp(ip) {
  let v = String(ip || '').trim().toLowerCase();
  if (v.startsWith('::ffff:')) v = v.slice(7);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v)) {
    const [a, b] = v.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

function cleanHeader(value) {
  if (Array.isArray(value)) value = value[0];
  if (!value) return null;
  let v = String(value).trim();
  try { v = decodeURIComponent(v); } catch { /* not encoded */ }
  if (!v || v.length > 100 || ['xx', 't1', 'unknown'].includes(v.toLowerCase())) return null;
  return v;
}

class IpLookup {
  constructor(options = {}, { fetchImpl = globalThis.fetch, proxycheckUrl = 'https://proxycheck.io/v2/' } = {}) {
    const pc = options.proxycheck || {};
    this.trustLocationHeaders = Boolean(options.trustLocationHeaders);
    this.headerNames = { ...DEFAULT_HEADERS, ...(options.locationHeaders || {}) };
    this.proxycheckEnabled = pc.enabled !== false;
    this.apiKey = process.env.PROXYCHECK_API_KEY || pc.apiKey || '';
    this.timeoutMs = (Number(pc.timeoutSeconds) || 4) * 1000;
    this.fetch = fetchImpl;
    this.proxycheckUrl = proxycheckUrl;
    this.cache = new Map();
  }

  /**
   * Returns { ip, city, region, country, isp, vpn, vpnType, private }.
   * Unknown fields are null; vpn is true / false / null (couldn't tell).
   */
  async lookup(ip, headers = {}) {
    const result = { ip, city: null, region: null, country: null, isp: null, vpn: null, vpnType: null, private: false };
    if (!ip || ip === 'unknown') return result;
    if (isPrivateIp(ip)) return { ...result, private: true, vpn: false };

    if (this.trustLocationHeaders) {
      const h = (name) => cleanHeader(headers[String(name).toLowerCase()]);
      result.city = h(this.headerNames.city);
      result.region = h(this.headerNames.region);
      result.country = h(this.headerNames.country);
    }

    if (this.proxycheckEnabled) {
      const pc = await this.proxycheck(ip);
      if (pc) {
        // Request headers win for location; proxycheck fills the gaps.
        for (const k of ['city', 'region', 'country']) if (!result[k] && pc[k]) result[k] = pc[k];
        result.isp = pc.isp;
        result.vpn = pc.vpn;
        result.vpnType = pc.vpnType;
      }
    }
    return result;
  }

  async proxycheck(ip) {
    const cached = this.cache.get(ip);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

    let value = null;
    try {
      const url = new URL(encodeURIComponent(ip), this.proxycheckUrl);
      url.searchParams.set('vpn', '1');
      url.searchParams.set('asn', '1');
      if (this.apiKey) url.searchParams.set('key', this.apiKey);
      const res = await this.fetch(url, { signal: AbortSignal.timeout(this.timeoutMs), headers: { Accept: 'application/json' } });
      const body = await res.json();
      const entry = body && body[ip];
      if (!res.ok || !entry || (body.status && !['ok', 'warning'].includes(body.status))) {
        console.error(`proxycheck.io lookup for ${ip} failed: ${(body && body.message) || `HTTP ${res.status}`}`);
      } else {
        const proxy = String(entry.proxy || '').toLowerCase();
        value = {
          city: entry.city || null,
          region: entry.region || null,
          country: entry.country || null,
          isp: entry.provider || entry.organisation || null,
          vpn: proxy === 'yes' ? true : proxy === 'no' ? false : null,
          vpnType: proxy === 'yes' ? (entry.type || 'Proxy') : null,
        };
      }
    } catch (err) {
      console.error(`proxycheck.io lookup for ${ip} failed: ${err.name === 'TimeoutError' ? 'timed out' : err.message}`);
    }
    if (value) {
      if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(ip, { at: Date.now(), value });
    }
    return value;
  }
}

module.exports = { IpLookup, isPrivateIp };
