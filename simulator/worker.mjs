// Local simulator: no outbound network, credentials, or Tesla API calls.
const tool = {
  name: 'get_simulated_battery',
  description: 'Returns a synthetic battery level; does not read a real vehicle.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
};

function reply(id, result) {
  return Response.json({ jsonrpc: '2.0', id, result }, { headers: { 'cache-control': 'no-store' } });
}

function error(id, code, message) {
  return Response.json({ jsonrpc: '2.0', id, error: { code, message } }, { headers: { 'cache-control': 'no-store' } });
}

async function toolResult(invoke, onToolError) {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await invoke()) }], isError: false };
  } catch (err) {
    if (!onToolError) throw err;
    return { content: [{ type: 'text', text: JSON.stringify(await onToolError(err)) }], isError: true };
  }
}

function matchesSchema(schema, value) {
  if (!schema || typeof schema !== 'object') return false;
  if (Object.hasOwn(schema, 'const') && !Object.is(schema.const, value)) return false;
  if (schema.anyOf && (!Array.isArray(schema.anyOf) || !schema.anyOf.some(item => matchesSchema(item, value)))) return false;
  if (schema.enum && !schema.enum.some(item => Object.is(item, value))) return false;
  if (schema.type === 'null') return value === null;
  if (schema.type === 'array') return Array.isArray(value) &&
    (schema.minItems === undefined || value.length >= schema.minItems) &&
    (schema.maxItems === undefined || value.length <= schema.maxItems) &&
    value.every(item => matchesSchema(schema.items, item));
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
    const properties = schema.properties || {};
    if (schema.additionalProperties !== true && Object.keys(value).some(key => !Object.hasOwn(properties, key))) return false;
    if (Array.isArray(schema.required) && schema.required.some(key => !Object.hasOwn(value, key))) return false;
    return Object.entries(value).every(([key, item]) => {
      if (!Object.hasOwn(properties, key)) return schema.additionalProperties === true;
      return matchesSchema(properties[key], item);
    });
  }
  if (schema.type === 'string') return typeof value === 'string' && (schema.maxLength === undefined || value.length <= schema.maxLength) && (schema.minLength === undefined || value.length >= schema.minLength);
  if (schema.type === 'integer') return Number.isInteger(value) && (schema.minimum === undefined || value >= schema.minimum) && (schema.maximum === undefined || value <= schema.maximum);
  if (schema.type === 'number') return typeof value === 'number' && Number.isFinite(value) && (schema.minimum === undefined || value >= schema.minimum) && (schema.maximum === undefined || value <= schema.maximum);
  if (schema.type === 'boolean') return typeof value === 'boolean';
  return schema.type === undefined;
}


const LEGACY_VERSIONS = new Set(['2025-11-25', '2025-06-18', '2025-03-26']);

// Handshake-era MCP uses initialize followed by an id-less notification.
// Keep this small compatibility adapter stateless: do not mint MCP sessions,
// cache tokens, execute server-originated requests, or expose any Tesla APIs.
async function handleLegacyRpc(request, body, availableTools, readBattery, invokeTool, authorizeTool, serverName, serverVersion, onToolError, onAuthorizationError) {
  const statusHeaders = { 'cache-control': 'no-store' };
  const legacyError = (id, code, message, status = 400) =>
    Response.json({ jsonrpc: '2.0', id, error: { code, message } }, { status, headers: statusHeaders });

  const hasId = Object.hasOwn(body, 'id') && (typeof body.id === 'string' || typeof body.id === 'number');
  if (body.method === 'notifications/initialized') {
    if (hasId) return legacyError(body.id, -32600, 'Invalid notification');
    return new Response(null, { status: 202, headers: statusHeaders });
  }
  if (!hasId) return legacyError(null, -32600, 'Invalid request');
  if (body.method === 'initialize') {
    const offered = body.params?.protocolVersion;
    const client = body.params?.clientInfo;
    const caps = body.params?.capabilities;
    if (!LEGACY_VERSIONS.has(offered) || !client || typeof client.name !== 'string' ||
        typeof client.version !== 'string' || !caps || typeof caps !== 'object' ||
        Array.isArray(caps)) return legacyError(body.id, -32602, 'Unsupported initialize parameters');
    return reply(body.id, { protocolVersion: offered,
      capabilities: { tools: {} }, serverInfo: { name: serverName, version: serverVersion } });
  }

  // A legacy HTTP server MAY be sessionless. Validate the optional version
  // header when supplied; do not accept a modern request as a legacy downgrade.
  const version = request.headers.get('mcp-protocol-version');
  if (version && !LEGACY_VERSIONS.has(version))
    return legacyError(body.id, -32022, 'Unsupported legacy protocol version');
  if (body.method === 'tools/list') return reply(body.id, { tools: availableTools });
  if (body.method !== 'tools/call') return legacyError(body.id, -32601, 'Method not found', 404);
  const toolName = body.params?.name;
  if (typeof toolName !== 'string' || !availableTools.some(t => t.name === toolName))
    return legacyError(body.id, -32602, 'Tool unavailable');
  const args = body.params?.arguments ?? {};
  const selectedTool = availableTools.find(t => t.name === toolName);
  if (!matchesSchema(selectedTool.inputSchema, args))
    return legacyError(body.id, -32602, 'Invalid arguments');
  if (authorizeTool) {
    try { await authorizeTool(toolName, request, args); }
    catch {
      if (onAuthorizationError) return reply(body.id, await onAuthorizationError(toolName));
      return new Response('Unauthorized', { status: 401, headers: statusHeaders });
    }
  }
  const result = await toolResult(() => invokeTool ? invokeTool(toolName, args, { requestId: body.id }) : readBattery ? readBattery() :
    { source: 'SIMULATED', battery_percent: 70, note: 'Test-only value; no vehicle contacted.' }, onToolError);
  return reply(body.id, result);
}

export function createWorker({ exposedTool = tool, exposedTools = null, readBattery, invokeTool, authorizeTool, onToolError, onAuthorizationError, serverName = 'tesla-voice-simulated', serverVersion = '0.1.0' } = {}) {
const availableTools = exposedTools ?? [exposedTool];
return {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== '/mcp') return new Response(null, { status: 404 });
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
    if (request.headers.has('origin') && request.headers.get('origin') !== url.origin) return new Response(null, { status: 403 });
    if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return new Response(null, { status: 415 });
    const accept = request.headers.get('accept') || '';
    if (!accept.includes('application/json') || !accept.includes('text/event-stream')) return new Response(null, { status: 406 });
    const length = Number(request.headers.get('content-length') || 0);
    if (length > 4096) return new Response(null, { status: 413 });
    let body;
    try {
      const reader = request.body?.getReader();
      const chunks = [];
      let size = 0;
      if (reader) {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 4096) { await reader.cancel(); return new Response(null, { status: 413 }); }
          chunks.push(value);
        }
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch { return error(null, -32700, 'JSON non valido'); }
    if (!body || Array.isArray(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string')
      return error(null, -32600, 'Richiesta non valida');
    const meta = body.params?._meta;
    if (!meta?.['io.modelcontextprotocol/protocolVersion'] &&
        (body.method === 'initialize' || body.method === 'notifications/initialized' ||
         body.method === 'tools/list' || body.method === 'tools/call')) {
      return handleLegacyRpc(request, body, availableTools, readBattery, invokeTool, authorizeTool, serverName, serverVersion, onToolError, onAuthorizationError);
    }
    if (!Object.hasOwn(body, 'id') || !['string', 'number'].includes(typeof body.id))
      return error(null, -32600, 'Richiesta non valida');
    const fail = (code, message, data) => Response.json({ jsonrpc: '2.0', id: body.id, error: { code, message, ...(data ? { data } : {}) } }, { status: 400, headers: { 'cache-control': 'no-store' } });
    const version = meta?.['io.modelcontextprotocol/protocolVersion'];
    if (!version || request.headers.get('mcp-protocol-version') !== version || request.headers.get('mcp-method') !== body.method) return fail(-32020, 'Missing or mismatched request metadata');
    if (version !== '2026-07-28') return fail(-32022, 'Unsupported protocol version', { supported: ['2026-07-28'], requested: version });
    const info = meta['io.modelcontextprotocol/clientInfo'];
    const caps = meta['io.modelcontextprotocol/clientCapabilities'];
    if ((info !== undefined && (!info || typeof info !== 'object' || Array.isArray(info) || typeof info.name !== 'string' || typeof info.version !== 'string')) || !caps || typeof caps !== 'object' || Array.isArray(caps)) return fail(-32602, 'Invalid client metadata');
    if (body.method === 'tools/call') {
      let name = request.headers.get('mcp-name');
      if (name?.startsWith('=?base64?') && name.endsWith('?=')) {
        try { name = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(name.slice(9, -2)), c => c.charCodeAt(0))); } catch { return fail(-32020, 'Invalid encoded name'); }
      }
      if (!name || name !== body.params?.name) return fail(-32020, 'Mismatched tool name');
    }
    if (body.method === 'server/discover') return reply(body.id, { resultType: 'complete', supportedVersions: ['2026-07-28'], _meta: { 'io.modelcontextprotocol/serverInfo': { name: serverName, version: serverVersion } }, capabilities: { tools: {} }, ttlMs: 0, cacheScope: 'private' });
    if (body.method === 'tools/list') return reply(body.id, { resultType: 'complete', tools: availableTools, _meta: { 'io.modelcontextprotocol/serverInfo': { name: serverName, version: serverVersion } }, ttlMs: 0, cacheScope: 'private' });
    if (body.method === 'tools/call') {
      const toolName = body.params?.name;
      if (!availableTools.some(item => item.name === toolName))
        return error(body.id, -32602, 'Tool non disponibile');
      const args = body.params?.arguments === undefined ? {} : body.params.arguments;
      const selectedTool = availableTools.find(t => t.name === toolName);
      if (!matchesSchema(selectedTool.inputSchema, args))
        return error(body.id, -32602, 'Argomenti non validi');
      if (authorizeTool) {
        try { await authorizeTool(toolName, request, args); }
        catch {
          if (onAuthorizationError) return reply(body.id, {resultType:'complete', ...await onAuthorizationError(toolName)});
          return new Response('Unauthorized', {status:401, headers:{'cache-control':'no-store'}});
        }
      }
      const result = await toolResult(() => invokeTool ? invokeTool(toolName, args, { requestId: body.id }) :
        readBattery ? readBattery() :
          { source: 'SIMULATED', battery_percent: 70, call_id: crypto.randomUUID(),
            note: 'Synthetic data; no vehicle was queried.' }, onToolError);
      return reply(body.id, { resultType: 'complete', _meta: { 'io.modelcontextprotocol/serverInfo': { name: serverName, version: serverVersion } }, ...result });
    }
    return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method unavailable; supported protocol: 2026-07-28 (no legacy initialize)' } }, { status: 404 });
  }
};


}
export default createWorker();

