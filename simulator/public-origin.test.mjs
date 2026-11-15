import test from 'node:test';
import assert from 'node:assert/strict';
import { configuredPublicOrigin, configuredPartnerDomain } from './lib/public-origin.mjs';
test('derives Tesla origin and domain only from explicit canonical HTTPS configuration', () => {
  const env = { APP_ORIGIN: 'https://mcp.example.com' };
  assert.equal(configuredPublicOrigin(env), 'https://mcp.example.com');
  assert.equal(configuredPartnerDomain(env), 'mcp.example.com');
});
test('rejects missing, insecure and noncanonical origin values', () => {
  for (const value of [undefined, '', 'http://example.com', 'https://example.com/', 'https://example.com/path', 'https://user:pass@example.com', 'https://example.com:444', 'https://localhost', 'https://127.0.0.1', 'https://127.0.0.2', 'https://[::1]'])
    assert.throws(() => configuredPublicOrigin({ APP_ORIGIN: value }), /configuration/);
});
