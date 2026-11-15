export function request(method, params = {}, overrides = {}, url = 'https://example.invalid/mcp') {
  const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'offline-test', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} };
  return new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': method, ...(method === 'tools/call' ? { 'mcp-name': params.name } : {}), ...overrides }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: meta } }) });
}
