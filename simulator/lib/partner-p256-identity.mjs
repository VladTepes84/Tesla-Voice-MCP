// Tesla P-256 identity, created ONLY on an explicitly staged Production
// build. Uses the existing Upstash-compatible Redis and existing Vercel AES
// secret; no new key material is printed, checked in, hosted or returned to MCP.
import { matchesPublicOrigin } from './public-origin.mjs';
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { seal, unseal } from './security.mjs';
import { persistentStore } from './store.mjs';
import { validateTeslaPublicKey } from '../api/tesla-public-key.mjs';

export const TESLA_P256_IDENTITY_STORE_KEY = 'partner-p256-identity-v1';
// Synthetic fixture retained for tests; runtime uses the operator's APP_ORIGIN.
export const TESLA_P256_ORIGIN = 'https://mcp.example.invalid';

function encryptionKey(env) {
  const canonical = env.TOKEN_ENCRYPTION_KEY_BASE64;
  const legacy = env.TOKEN_ENCRYPTON_KEY_BASE64;
  if (canonical && legacy && canonical !== legacy) throw Error('p256_aes_key_conflict');
  const encoded = canonical || legacy || '';
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw Error('p256_aes_key_missing');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw Error('p256_aes_key_invalid');
  return key;
}

function assertEnvironment(env) {
  // This operation is deliberately independent of Tesla vehicle access gates.
  // Preview, wrong projects and local runs must never generate real identities.
  if (env.VERCEL_ENV !== 'production' || !matchesPublicOrigin(env.APP_ORIGIN, env) ||
      env.TESLA_FLEET_REGION !== 'eu') throw Error('p256_provisioning_disabled');
}

function validateStoredIdentity(raw, aes, includePrivate = false) {
  if (typeof raw !== 'string' || raw.length > 12000) throw Error('p256_identity_invalid');
  let record, pem, privatePem;
  try {
    record = JSON.parse(raw);
    if (record.version !== 1 || typeof record.publicPem !== 'string' ||
        typeof record.encryptedPrivate !== 'string' ||
        record.publicPem.length > 2000 || record.encryptedPrivate.length > 8000)
      throw Error('invalid');
    const privateObj = unseal(record.encryptedPrivate, aes, TESLA_P256_IDENTITY_STORE_KEY);
    if (typeof privateObj.pem !== 'string' || privateObj.pem.length > 4000 ||
        !privateObj.pem.startsWith('-----BEGIN PRIVATE KEY-----')) throw Error('invalid');
    privatePem = privateObj.pem;
    const privateKey = createPublicKey(privatePem);
    if (privateKey.asymmetricKeyType !== 'ec' ||
        privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw Error('invalid');
    pem = validateTeslaPublicKey(Buffer.from(record.publicPem).toString('base64'));
    if (pem !== privateKey.export({ format: 'pem', type: 'spki' })) throw Error('keypair_mismatch');
  } catch {
    // Never rotate to "fix" corrupted, conflicting or undecryptable records.
    throw Error('p256_identity_invalid');
  }
  const der = createPublicKey(pem).export({ format: 'der', type: 'spki' });
  return { publicPem: pem, sha256: createHash('sha256').update(der).digest('hex'),
    ...(includePrivate ? { privatePem } : {}) };
}

export async function readStoredTeslaP256Public({
  env = process.env, storeFactory = persistentStore
} = {}) {
  assertEnvironment(env);
  const aes = encryptionKey(env);
  try {
    const raw = await storeFactory(env).get(TESLA_P256_IDENTITY_STORE_KEY);
    if (!raw) throw Error('p256_identity_not_configured');
    return validateStoredIdentity(raw, aes);
  } catch (err) {
    if (err?.message === 'p256_identity_not_configured' ||
        err?.message === 'p256_identity_invalid') throw err;
    throw Error('p256_store_unavailable');
  }
}

// Only the command execution backend may request the private key. Keep it
// encrypted in Redis at rest and never expose it through a public endpoint.
export async function readStoredTeslaP256Private({
  env = process.env, storeFactory = persistentStore
} = {}) {
  assertEnvironment(env);
  const aes = encryptionKey(env);
  try {
    const raw = await storeFactory(env).get(TESLA_P256_IDENTITY_STORE_KEY);
    if (!raw) throw Error('p256_identity_not_configured');
    return validateStoredIdentity(raw, aes, true);
  } catch (err) {
    if (err?.message === 'p256_identity_not_configured' ||
        err?.message === 'p256_identity_invalid') throw err;
    throw Error('p256_store_unavailable');
  }
}

export async function provisionTeslaP256Once({
  env = process.env, storeFactory = persistentStore,
  generate = generateKeyPairSync
} = {}) {
  assertEnvironment(env);
  const aes = encryptionKey(env);
  let store, current;
  try {
    store = storeFactory(env);
    current = await store.get(TESLA_P256_IDENTITY_STORE_KEY);
  } catch { throw Error('p256_store_unavailable'); }
  if (current !== null && current !== undefined) {
    return { created: false, ...validateStoredIdentity(current, aes) };
  }
  // If a public key was independently configured since the last dashboard
  // check, never silently create an identity that might conflict with it.
  if (typeof env.TESLA_PUBLIC_KEY_PEM_BASE64 === 'string' &&
      env.TESLA_PUBLIC_KEY_PEM_BASE64.trim()) {
    throw Error('p256_existing_public_key_unverified');
  }

  let privatePem, publicPem;
  try {
    const keys = generate('ec', { namedCurve: 'prime256v1',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' } });
    privatePem = keys.privateKey;
    publicPem = validateTeslaPublicKey(Buffer.from(keys.publicKey).toString('base64'));
    if (createPublicKey(privatePem).export({ type: 'spki', format: 'pem' }) !== publicPem)
      throw Error('keypair_mismatch');
  } catch { throw Error('p256_generation_failed'); }

  // Encrypt the private key with the existing AES-256-GCM secret in a single
  // self-contained record. Redis SET NX without EX is durable and atomic.
  const serialized = JSON.stringify({ version: 1, publicPem,
    encryptedPrivate: seal({pem: privatePem}, aes, TESLA_P256_IDENTITY_STORE_KEY) });
  privatePem = null;
  let created;
  try {
    created = await store.putOncePermanent(TESLA_P256_IDENTITY_STORE_KEY, serialized);
    current = await store.get(TESLA_P256_IDENTITY_STORE_KEY);
  } catch { throw Error('p256_store_unavailable'); }
  if (!current) throw Error('p256_store_unavailable');
  return { created: Boolean(created), ...validateStoredIdentity(current, aes) };
}
