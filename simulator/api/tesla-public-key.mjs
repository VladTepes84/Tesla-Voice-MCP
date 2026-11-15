import { matchesPublicOrigin } from '../lib/public-origin.mjs';
import { createPublicKey } from 'node:crypto';
import { readStoredTeslaP256Public, TESLA_P256_ORIGIN } from '../lib/partner-p256-identity.mjs';

export const TESLA_PUBLIC_KEY_PATH = '/.well-known/appspecific/com.tesla.3p.public-key.pem';

export function validateTeslaPublicKey(encoded) {
  if (typeof encoded !== 'string' || !encoded || encoded.length > 8192 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new TypeError('Tesla public key configuration unavailable');
  }
  const pem = Buffer.from(encoded, 'base64').toString('utf8').replace(/\r\n/g, '\n').trim() + '\n';
  if (!/^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+\n-----END PUBLIC KEY-----\n$/.test(pem)) {
    throw new TypeError('Only an EC public key PEM is permitted');
  }
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ec' || !['prime256v1', 'secp256r1'].includes(key.asymmetricKeyDetails?.namedCurve)) {
    throw new TypeError('Tesla requires secp256r1 public key');
  }
  return key.export({ type: 'spki', format: 'pem' });
}

export function publicKeyHandler(config = process.env.TESLA_PUBLIC_KEY_PEM_BASE64) {
  return function fetch(request) {
    const url = new URL(request.url);
    // Tesla requests this well-known path without query parameters. Do not
    // relax the exact-match requirement for Vercel's temporary share links.
    if (url.protocol !== 'https:' || url.pathname !== TESLA_PUBLIC_KEY_PATH || url.search || url.hash) {
      return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
    }
    if (request.method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } });
    try {
      const pem = validateTeslaPublicKey(config);
      return new Response(pem, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=60', 'x-content-type-options': 'nosniff' } });
    } catch {
      return new Response('Tesla public key not configured', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
    }
  };
}
// Public only: the signing private key remains AES-256-GCM encrypted in the
// existing Redis and is never served over HTTP. Invalid paths/methods and
// Preview must not query the secret store.
export async function hostedTeslaPublicKeyFetch(request, {
  env = process.env, readPublic = readStoredTeslaP256Public
} = {}) {
  const guarded = publicKeyHandler('')(request);
  if (guarded.status !== 503) return guarded;
  if (env.VERCEL_ENV !== 'production' ||
      !matchesPublicOrigin(new URL(request.url).origin, env))
    return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
  try {
    const { publicPem } = await readPublic({ env });
    const encoded = Buffer.from(publicPem, 'utf8').toString('base64');
    return publicKeyHandler(encoded)(request);
  } catch {
    return guarded; // Fail closed, with no errors, tokens or private material.
  }
}
export default { fetch: request => hostedTeslaPublicKeyFetch(request) };
