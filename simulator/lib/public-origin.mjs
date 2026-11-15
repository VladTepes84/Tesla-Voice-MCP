import { isIP } from 'node:net';
// The operator supplies the HTTPS origin registered with Tesla. Never fall back
// to another installation's domain or accept paths, ports, or credentials.
export function configuredPublicOrigin(env = process.env) {
  const value = env?.APP_ORIGIN;
  if (typeof value !== 'string' || !value) throw Error('configuration');
  let url;
  try { url = new URL(value); } catch { throw Error('configuration'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      url.origin !== value || !url.hostname.includes('.') ||
      isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0 || url.hostname === 'localhost') throw Error('configuration');
  return url.origin;
}
export function configuredPartnerDomain(env = process.env) {
  return new URL(configuredPublicOrigin(env)).hostname;
}

export function matchesPublicOrigin(value, env = process.env) {
  try { return value === configuredPublicOrigin(env); } catch { return false; }
}
