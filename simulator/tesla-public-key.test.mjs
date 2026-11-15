import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { TESLA_PUBLIC_KEY_PATH, publicKeyHandler, validateTeslaPublicKey } from './api/tesla-public-key.mjs';

const url = 'https://mcp.example.invalid' + TESLA_PUBLIC_KEY_PATH;
const good = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const encoded = Buffer.from(good.publicKey.export({ type:'spki', format:'pem' })).toString('base64');

test('fail closed until public key is configured', async () => {
  for (const value of [undefined, '', 'bad', Buffer.from('not a pem').toString('base64')]) {
    const res = publicKeyHandler(value)(new Request(url));
    assert.equal(res.status,503);
    assert.match(await res.text(), /not configured/);
  }
});
test('serves exactly P-256 public PEM, never private key', async () => {
  const res = publicKeyHandler(encoded)(new Request(url));
  assert.equal(res.status,200);
  assert.match(await res.text(),/BEGIN PUBLIC KEY/);
  assert.equal(res.headers.get('content-type'),'text/plain; charset=utf-8');
  const privateEncoded = Buffer.from(good.privateKey.export({type:'pkcs8',format:'pem'})).toString('base64');
  assert.throws(()=>validateTeslaPublicKey(privateEncoded));
});
test('rejects wrong key type/curve', () => {
  for (const curve of ['secp384r1','secp521r1']) {
    const k=generateKeyPairSync('ec',{namedCurve:curve});
    const b64=Buffer.from(k.publicKey.export({type:'spki',format:'pem'})).toString('base64');
    assert.throws(()=>validateTeslaPublicKey(b64));
  }
  const k=generateKeyPairSync('rsa',{modulusLength:2048});
  assert.throws(()=>validateTeslaPublicKey(Buffer.from(k.publicKey.export({type:'spki',format:'pem'})).toString('base64')));
});
test('GET only, exact HTTPS path without query', () => {
  const run=publicKeyHandler(encoded);
  assert.equal(run(new Request(url,{method:'POST'})).status,405);
  assert.equal(run(new Request(url+'?foo=bar')).status,404);
  assert.equal(run(new Request(url.replace('https:', 'http:'))).status,404);
  assert.equal(run(new Request('https://mcp.example.invalid/')).status,404);
});

test('Vercel routes exact Tesla well-known path to the public-key handler', () => {
  const routes = JSON.parse(requireJson()).routes;
  assert.deepEqual(routes.filter(x => x.src === TESLA_PUBLIC_KEY_PATH), [
    { src: TESLA_PUBLIC_KEY_PATH, dest: '/api/tesla-public-key' }
  ]);
});
function requireJson() {
  return readFileSync(new URL('./vercel.json', import.meta.url), 'utf8');
}

test('missing key fails closed; URL query strings remain rejected', async () => {
  const res = publicKeyHandler(undefined)(new Request(url));
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(await res.text(), /BEGIN (EC |)PRIVATE KEY|BEGIN PUBLIC KEY/);
  const wrongPath = publicKeyHandler(encoded)(new Request(url + '-wrong'));
  assert.equal(wrongPath.status, 404);
  const query = publicKeyHandler(encoded)(new Request(url + '?test=1'));
  assert.equal(query.status, 404);
  assert.equal(query.headers.get('cache-control'), 'no-store');
});
