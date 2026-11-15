import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('prepared local artifact contains the MCP server but no storage or frontend', async () => {
  const manifest = JSON.parse(await readFile(new URL('./dist/.openai/hosting.json', import.meta.url)));
  assert.deepEqual(manifest.capabilities, ['mcp']);
  assert.equal(manifest.d1, null);
  assert.equal(manifest.r2, null);
  assert.ok(manifest.project_id === undefined || typeof manifest.project_id === 'string');
  const source = await readFile(new URL('./dist/server/index.js', import.meta.url));
  const worker = await import(`data:text/javascript;base64,${source.toString('base64')}`);
  const { request } = await import('./offline-request.mjs');
  const req = request('tools/call', { name: 'get_simulated_battery', arguments: {} });
  const response = await worker.default.fetch(req);
  const data = await response.json();
  assert.equal(JSON.parse(data.result.content[0].text).source, 'SIMULATED');
});
