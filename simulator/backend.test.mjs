import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { configuration, authenticate, seal, unseal, hash, jsonFetch } from './lib/security.mjs';
import { persistentStore } from './lib/store.mjs';
import { createTeslaBackend, nativeAcknowledgementResult } from './lib/tesla.mjs';
import { realMcp } from './lib/real-mcp.mjs';
import { TESLA_P256_ORIGIN, TESLA_P256_IDENTITY_STORE_KEY } from './lib/partner-p256-identity.mjs';
import { NATIVE_COORDINATE_SCHEMA } from './lib/native-navigation-candidates.mjs';
import { request as mcpRequest } from './offline-request.mjs';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
const env = { APP_ORIGIN: 'https://example.invalid', MCP_AUTH_ISSUER: 'https://id.invalid', MCP_AUTH_JWKS: JSON.stringify({ keys: [jwk] }), MCP_ALLOWED_SUBJECT: 'owner', TOKEN_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'), TESLA_CLIENT_ID: 'fake-client', TESLA_CLIENT_SECRET: 'fake-secret', TESLA_FLEET_REGION: 'eu', TESLA_BACKEND_ENABLED: 'true', TESLA_READ_ENABLED: 'true', TESLA_DAILY_READ_LIMIT: '10', TESLA_VEHICLE_VIN: '5YJ3E1EA0LF000000', TOKEN_STORE_REST_URL: 'https://redis.invalid', TOKEN_STORE_REST_TOKEN: 'fake-store-token' };
const config = configuration(env);
test('native waypoint acknowledgement never claims the route was set or shown',()=>{
 const result=nativeAcknowledgementResult('experimental_native_refid_waypoints');
 assert.equal(result.navigation_set,'unverified');
 assert.match(result.note,/ActionStatus OK/);
 assert.match(result.note,/unverified/);
 assert.equal(nativeAcknowledgementResult('experimental_native_supercharger').navigation_set,undefined);
 assert.equal(nativeAcknowledgementResult(undefined).navigation_set,undefined);
 assert.equal(nativeAcknowledgementResult(undefined).note,'Tesla accepted the request. The command result does not prove that the vehicle completed the action.');
});
function jwt(overrides = {}, header = {}, issuedAt = Date.now()) {
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'at+jwt', kid: 'test-key', ...header })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ iss: config.issuer, aud: config.audience, sub: 'owner', scope: 'tesla:connect battery:read', iat: Math.floor(issuedAt/1000), exp: Math.floor(issuedAt/1000)+600, ...overrides })).toString('base64url');
  return h + '.' + p + '.' + sign('RSA-SHA256', Buffer.from(h + '.' + p), privateKey).toString('base64url');
}
function redis(initialTime = Date.now()) {
  const rows = new Map(), commands = [];
  let clock = initialTime;
  const fetcher = async (url, opts) => {
    assert.equal(url, 'https://redis.invalid/');
    assert.equal(opts.headers.authorization, 'Bearer fake-store-token');
    assert.equal(opts.redirect, 'error');
    const args = JSON.parse(opts.body); commands.push(args);
    const [cmd, key, ...rest] = args;
    for (const [k,v] of rows) if (v.expires <= clock) rows.delete(k);
    const get = k => rows.get(k)?.value ?? null;
    const set = (k, v, ttl) => rows.set(k, { value: v, expires: ttl === '' || ttl === undefined ? Infinity : clock + Number(ttl)*1000 });
    let result;
    if (cmd === 'GET') result = get(key);
    else if (cmd === 'GETDEL') { result = get(key); rows.delete(key); }
    else if (cmd === 'PERSIST') { const row=rows.get(key);if(row){row.expires=Infinity;result=1;}else result=0; }
    else if (cmd === 'SET') {
      if (rest.includes('NX') && rows.has(key)) result = null;
      else { set(key, rest[0], rest.at(-1)); result = 'OK'; }
    } else if (cmd === 'EVAL') {
      const count = rest[0], lock = rest[1], owner = rest[count + 1];
      if (count === 3 && key.includes('command_guard_claim')) {
        if(get(lock)!==owner)result=-1;
        else if(get(rest[3])!==null)result=0;
        else {rows.set(rest[3],{value:rest[6],expires:rest[7] ? clock + Number(rest[7])*1000 : Infinity});rows.set(rest[2],{value:rest[5],expires:Infinity});result=1;}
      } else if (count === 2 && key.includes('command_guard_clear')) {
        if(get(lock)===owner && get(rest[2])===rest[4]){rows.delete(rest[2]);result=1;}else result=0;
      } else if (count === 0 && key.includes("local p=redis.call('SCAN'")) {
        const records=[...rows.entries()].filter(([storedKey])=>storedKey.startsWith('tesla-voice:v1:direct-state:')).map(([storedKey,row])=>[storedKey,row.value]);
        result=['0',records,0];
      } else if (count === 50) {
        const keys = rest.slice(1, 51), limit = rest[51], requested = Number(rest[52]), extraKey = rest[53];
        const extraRaw = get(extraKey), extra = extraRaw === null ? 0 : Number(extraRaw);
        const values = keys.map(get);
        if (values.some(v => v !== null && v !== '1') || !Number.isSafeInteger(extra) || extra < 0) result = -1;
        else if (limit === 'unlimited') { set(extraKey, String(extra + requested), 172800); result = 1; }
        else if (values.filter(v => v === '1').length + extra + requested > Number(limit)) result = 0;
        else {
          const free = keys.slice(0, Number(limit)).filter(k => get(k) === null);
          if (free.length < requested) result = 0;
          else { for (const k of free.slice(0, requested)) set(k, '1', 172800); result = 1; }
        }
      } else if (get(lock) !== owner) result = 0;
      else if (count === 1) { rows.delete(lock); result = 1; }
      else { set(rest[2], rest[4], rest[5]); result = 1; }
    } else throw Error('unexpected Redis operation');
    return Response.json({ result });
  };
  const store=persistentStore(env,fetcher);
  store.putOncePermanent=async(key,value)=>{
    const storageKey='tesla-voice:v1:'+key;
    if(rows.has(storageKey))return false;
    rows.set(storageKey,{value,expires:Number.POSITIVE_INFINITY});
    return true;
  };
  return { store, rows, commands, advance: ms => { clock += ms; } };
}
function fixture(initialTime = Date.now()) {
  const db = redis(initialTime), calls = []; let clock = initialTime;
  let remote = async url => url.includes('/token') ? Response.json({ access_token: 'fake-access', refresh_token: 'fake-refresh', token_type: 'Bearer', scope: 'openid offline_access vehicle_device_data', expires_in: 3600 }) : Response.json({ response: { charge_state: { battery_level: 71, timestamp: clock - 10000 }, vin: 'must-not-escape', drive_state: { latitude: 123 } } });
  const backend = createTeslaBackend({ config, store: db.store, now: () => clock, fetcher: async (url, opts) => { calls.push({ url, opts }); return remote(url, opts); } });
  const start = () => backend.start(new Request(config.origin + '/oauth/tesla/start', { method: 'POST', headers: { authorization: 'Bearer ' + jwt({}, {}, clock), origin: config.origin, 'content-type': 'application/json' } }));
  async function begin() {
    const r = await start(); assert.equal(r.status, 200);
    const cookie = r.headers.get('set-cookie').split(';')[0];
    const url = new URL((await r.json()).authorization_url);
    return { cookie, url, state: url.searchParams.get('state') };
  }
  const callback = (tx, extra = '') => backend.callback(new Request(config.callback + '?state=' + tx.state + '&code=fake-code' + extra, { headers: { cookie: tx.cookie } }));
  return { ...db, backend, calls, start, begin, callback, now: () => clock, advance: ms => { clock += ms; db.advance(ms); }, remote: value => { remote = value; } };
}
for(const first of ['direct','prepared'])test('uncertain navigation cannot bypass its guard through '+first+' or the other execution flow',async()=>{
 const f=fixture(),tx=await f.begin();
 f.remote(async()=>Response.json({access_token:'fake-access',refresh_token:'fake-refresh',token_type:'Bearer',expires_in:3600,scope:'openid offline_access vehicle_device_data vehicle_location vehicle_cmds vehicle_charging_cmds'}));
 assert.equal((await f.callback(tx)).status,200);
 const commandConfig=configuration({...env,APP_ORIGIN:TESLA_P256_ORIGIN,VERCEL_ENV:'production',TESLA_COMMANDS_ENABLED:'true',TESLA_COMMAND_EXECUTION_ENABLED:'true'});
 let calls=0;
 const backend=createTeslaBackend({config:commandConfig,store:f.store,fetcher:async()=>{calls++;return Response.json({error:'command_outcome_unknown'},{status:502});}});
 await backend.prepareVehicleCommandSetup('owner');
 const prepared=async()=>{const p=await backend.prepareCommand('owner','navigation_request',{destination:'Laketown'});return backend.confirmCommand('owner',p.ticket,p.confirmation_phrase);};
 const direct=()=>backend.executeRequestedCommand('owner','navigation_request',{destination:'Laketown'},'cross-flow-request');
 await assert.rejects(first==='direct'?direct():prepared(),/command_outcome_unknown/);
 await assert.rejects(first==='direct'?prepared():direct(),/command_pending/);
 assert.equal((await backend.vehicleCommandStatus('owner','navigation_request',{destination:'Laketown'})).state,'uncertain');
 assert.equal(calls,1);
});
test('proxy evidence of definitive rejection allows a later explicit navigation request',async()=>{
 const f=fixture(),tx=await f.begin();
 f.remote(async()=>Response.json({access_token:'fake-access',refresh_token:'fake-refresh',token_type:'Bearer',expires_in:3600,scope:'openid offline_access vehicle_device_data vehicle_location vehicle_cmds vehicle_charging_cmds'}));
 assert.equal((await f.callback(tx)).status,200);
 const commandConfig=configuration({...env,APP_ORIGIN:TESLA_P256_ORIGIN,VERCEL_ENV:'production',TESLA_COMMANDS_ENABLED:'true',TESLA_COMMAND_EXECUTION_ENABLED:'true'});
 let calls=0;
 const backend=createTeslaBackend({config:commandConfig,store:f.store,fetcher:async()=>++calls===1?
  Response.json({error:'command_rejected',command_evidence:{definitive_no_effect:true,proxy_accepted:true}},{status:409}):Response.json({accepted:true})});
 await backend.prepareVehicleCommandSetup('owner');
 await assert.rejects(backend.executeRequestedCommand('owner','navigation_request',{destination:'Laketown'},'rejected-request'),/command_rejected/);
 assert.equal((await backend.vehicleCommandStatus('owner','navigation_request',{destination:'Laketown'})).retry_allowed,true);
 assert.equal((await backend.executeRequestedCommand('owner','navigation_request',{destination:'Laketown'},'new-explicit-request')).accepted,true);
 assert.equal(calls,2);
});
test('request-id and status-reference lookups work without local command arguments',async()=>{
 const f=fixture(),tx=await f.begin();
 f.remote(async()=>Response.json({access_token:'fake-access',refresh_token:'fake-refresh',token_type:'Bearer',expires_in:3600,scope:'openid offline_access vehicle_device_data vehicle_location vehicle_cmds vehicle_charging_cmds'}));
 assert.equal((await f.callback(tx)).status,200);
 const commandConfig=configuration({...env,APP_ORIGIN:TESLA_P256_ORIGIN,VERCEL_ENV:'production',TESLA_COMMANDS_ENABLED:'true',TESLA_COMMAND_EXECUTION_ENABLED:'true'});
 const requestId='status-selector-request-20261109';
 const backend=createTeslaBackend({config:commandConfig,store:f.store,fetcher:async()=>Response.json({error:'command_outcome_unknown'},{status:502})});
 await backend.prepareVehicleCommandSetup('owner');
 await assert.rejects(backend.executeRequestedCommand('owner','navigation_request',{destination:'Laketown'},requestId),/command_outcome_unknown/);
 const byRequest=await backend.vehicleCommandStatus('owner','navigation_request',undefined,{requestId});
 assert.equal(byRequest.state,'uncertain');
 const byArguments=await backend.vehicleCommandStatus('owner','navigation_request',{destination:'Laketown'});
 assert.equal(byArguments.state,'uncertain');
 const byReference=await backend.vehicleCommandStatus('owner','navigation_request',undefined,{statusReference:byArguments.status_reference});
 assert.equal(byReference.state,'uncertain');
});
async function assertScopeChallenge(response,scope) {
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.result.isError,true);
  const error=JSON.parse(body.result.content[0].text).error;
  assert.equal(error.code,'mcp_authorization_required');
  assert.equal(error.required_scope,scope);
  assert.match(body.result._meta['mcp/www_authenticate'][0],/error="insufficient_scope"/);
  assert.ok(body.result._meta['mcp/www_authenticate'][0].includes('scope="'+scope+'"'));
}
for(const [operation,args] of [['navigation_request',{destination:'Central Square'}],['charge_port_door_open',{}],['set_temps',{driver_temp:22,passenger_temp:22}]])test('authenticated invocation continuation distinguishes new identical intent from retry: '+operation,async()=>{
 const f=fixture(),tx=await f.begin();
 f.remote(async()=>Response.json({access_token:'fake-access',refresh_token:'fake-refresh',token_type:'Bearer',expires_in:3600,scope:'openid offline_access vehicle_device_data vehicle_location vehicle_cmds vehicle_charging_cmds'}));
 assert.equal((await f.callback(tx)).status,200);
 const c=configuration({...env,APP_ORIGIN:TESLA_P256_ORIGIN,VERCEL_ENV:'production',TESLA_COMMANDS_ENABLED:'true',TESLA_COMMAND_EXECUTION_ENABLED:'true'});
 let sent=0;const backend=createTeslaBackend({config:c,store:f.store,now:f.now,fetcher:async url=>{assert.equal(url,c.origin+'/api/tesla-command-proxy');sent++;return Response.json({accepted:true});}});
 await backend.prepareVehicleCommandSetup('owner');const run=realMcp({config:c,backend});
 const invoke=async(arguments_,id=1)=>{
  const req=mcpRequest('tools/call',{name:'execute_requested_vehicle_command',arguments:arguments_});
  const body=JSON.parse(await req.text());body.id=id;
  const headers=new Headers(req.headers);headers.set('authorization','Bearer '+jwt({scope:'vehicle:control',aud:c.audience}));
  const rpc=await(await run(new Request(c.audience,{method:'POST',headers,body:JSON.stringify(body)}))).json();
  return JSON.parse(rpc.result.content[0].text);
 };
 const first=await invoke({operation,arguments:args});assert.equal(first.status,'invocation_ready');assert.equal(sent,0);
 assert.equal(first.continuation.arguments._tesla_invocation_token,first.invocation_token);
 const command=first.continuation;
 assert.equal((await invoke(command)).dispatch_performed,true);assert.equal(sent,1);
 const retry=await invoke(command,99);assert.equal(retry.dispatch_performed,false);assert.equal(retry.result_reused,true);assert.equal(sent,1);
 const next=await invoke({operation,arguments:args});assert.notEqual(next.invocation_token,first.invocation_token);assert.equal(sent,1);
 assert.equal((await invoke(next.continuation)).dispatch_performed,true);assert.equal(sent,2);
 await assert.rejects(backend.executeRequestedCommand('other-owner',operation,args,1,{token:first.invocation_token}),/invalid_command_invocation/);
 f.advance(121000);assert.equal((await invoke(command)).error.code,'command_invocation_expired');assert.equal(sent,2);
});
test('command scope challenge works on legacy and modern transports without preparing or executing', async () => {
  for(const legacy of [false,true]) {
    let prepared=0,executed=0;
    const commandConfig={...config,env:{...config.env,TESLA_COMMANDS_ENABLED:'true',TESLA_COMMAND_EXECUTION_ENABLED:'true'}};
    const run=realMcp({config:commandConfig,backend:{
      prepareCommand:async()=>{prepared++;return {prepared:true};},
      confirmCommand:async()=>{executed++;return {accepted:true};}
    }});
    const req=(name,args,scope)=>{
      if(legacy)return new Request(config.audience,{method:'POST',headers:{
        'content-type':'application/json',accept:'application/json, text/event-stream',authorization:'Bearer '+jwt({scope})
      },body:JSON.stringify({jsonrpc:'2.0',id:42,method:'tools/call',params:{name,arguments:args}})});
      const r=mcpRequest('tools/call',{name,arguments:args});
      const h=new Headers(r.headers);h.set('authorization','Bearer '+jwt({scope}));
      return new Request(config.audience,{method:'POST',headers:h,body:r.body,duplex:'half'});
    };
    await assertScopeChallenge(await run(req('prepare_vehicle_command',{operation:'wake_up',arguments:{}},'battery:read')),'vehicle:control');
    await assertScopeChallenge(await run(req('execute_vehicle_command',{ticket:'A'.repeat(43),confirmation_phrase:'CONFIRM FIXTURE'},'battery:read')),'vehicle:control');
    assert.equal(prepared,0);assert.equal(executed,0);
    const ok=await run(req('prepare_vehicle_command',{operation:'wake_up',arguments:{}},'vehicle:control'));
    assert.equal((await ok.json()).result.isError,false);
    assert.equal(prepared,1);assert.equal(executed,0);
  }
});
test('connection status reports verified MCP permissions separately from Tesla permissions', async()=>{
  const run=realMcp({config,backend:{connectionStatus:async()=>({connected:true,vehicle_permissions:{vehicle_commands:true}})}});
  const r=mcpRequest('tools/call',{name:'get_connection_status',arguments:{}});
  const h=new Headers(r.headers);h.set('authorization','Bearer '+jwt({scope:'battery:read'}));
  const response=await run(new Request(config.audience,{method:'POST',headers:h,body:r.body,duplex:'half'}));
  const status=JSON.parse((await response.json()).result.content[0].text);
  assert.equal(status.vehicle_permissions.vehicle_commands,true);
  assert.deepEqual(status.mcp_permissions,{'tesla:connect':false,'battery:read':true,'location:read':false,'vehicle:control':false});
  assert.doesNotMatch(JSON.stringify(status),/Bearer|auth0\||fake-access/);
});
const tokenKey = 'tokens:' + hash(config.issuer + '\nowner');
test('charging cost comparison requires read scope and uses no backend', async () => {
  const run = realMcp({ config, backend: new Proxy({}, { get() { throw Error('backend must not be called'); } }) });
  const args = { energyToBatteryKwh: 36, efficiencyPercent: 90, first: { label: 'A', eurPerKwh: 0.35, fixedFeeEur: 0 }, second: { label: 'B', eurPerKwh: 0, fixedFeeEur: 17.5 } };
  const req = (scope, values) => { const r = mcpRequest('tools/call', { name: 'compare_charging_costs', arguments: values }); const h = new Headers(r.headers); h.set('authorization', 'Bearer ' + jwt({ scope })); return new Request(config.audience, { method: 'POST', headers: h, body: r.body, duplex: 'half' }); };
  await assertScopeChallenge(await run(req('tesla:connect', args)), 'battery:read');
  const result = await (await run(req('battery:read', args))).json();
  assert.equal(result.result.isError, false);
  assert.equal(JSON.parse(result.result.content[0].text).lower_cost, 'first');
  const bad = await (await run(req('battery:read', { ...args, first: { label: 'A' } }))).json();
  assert.equal(bad.error.code, -32602);
});
test('energy estimate MCP tool checks permissions and calculates without calling the backend', async () => {
  const run = realMcp({ config, backend: new Proxy({}, { get() { throw Error('backend must not be called'); } }) });
  const request = (scope, args) => {
    const r = mcpRequest('tools/call', { name: 'estimate_trip_energy', arguments: args });
    const h = new Headers(r.headers); h.set('authorization', 'Bearer ' + jwt({ scope }));
    return new Request(config.audience, { method: 'POST', headers: h, body: r.body, duplex: 'half' });
  };
  const args = { distanceKm: 200, consumptionKwhPer100Km: 20, usableCapacityKwh: 80, batteryPercent: 70, reservePercent: 25 };
  await assertScopeChallenge(await run(request('tesla:connect', args)), 'battery:read');
  const result = await (await run(request('battery:read', args))).json();
  assert.equal(result.result.isError, false);
  const estimate = JSON.parse(result.result.content[0].text);
  assert.equal(estimate.estimated_arrival_percent, 20);
  assert.equal(estimate.source, 'ESTIMATE');
  const invalid = await (await run(request('battery:read', { ...args, batteryPercent: 101 }))).json();
  assert.equal(invalid.error.code, -32602);
});
test('trip plan MCP tool checks read permission and combines calculations without backend calls', async () => {
  const run = realMcp({ config, backend: new Proxy({}, { get() { throw Error('backend must not be called'); } }) });
  const args = {
    distanceKm: 200, consumptionKwhPer100Km: 20, usableCapacityKwh: 80,
    batteryPercent: 60, reservePercent: 25, efficiencyPercent: 95,
    first: { label: 'AC', eurPerKwh: 0.35, fixedFeeEur: 0 },
    second: { label: 'Forfait', eurPerKwh: 0, fixedFeeEur: 17.5 }
  };
  const req = (scope, values) => { const r = mcpRequest('tools/call', { name: 'plan_trip', arguments: values }); const h = new Headers(r.headers); h.set('authorization', 'Bearer ' + jwt({ scope })); return new Request(config.audience, { method: 'POST', headers: h, body: r.body, duplex: 'half' }); };
  await assertScopeChallenge(await run(req('tesla:connect', args)), 'battery:read');
  const response = await run(req('battery:read', args));
  assert.equal(response.status, 200);
  const result = JSON.parse((await response.json()).result.content[0].text);
  assert.equal(result.minimum_additional_battery_kwh, 12);
  assert.equal(result.charging_costs.first.estimated_eur, 4.42);
  assert.equal(result.charging_costs.lower_cost, 'first');
});
test('connectivity MCP tools dispatch exact modes and require read permission', async () => {
  const calls=[];
  const run=realMcp({config,backend:{vehicleConnectivity:async(subject,kind='connectivity')=>{calls.push({subject,kind});return {source:'TEST'};}}});
  const request=(name,scope)=>{
    const r=mcpRequest('tools/call',{name,arguments:{}});
    const h=new Headers(r.headers);h.set('authorization','Bearer '+jwt({scope}));
    return new Request(config.audience,{method:'POST',headers:h,body:r.body,duplex:'half'});
  };
  for(const name of ['get_vehicle_connectivity','get_vehicle_mobile_access']){
    await assertScopeChallenge(await run(request(name,'tesla:connect')),'battery:read');
    assert.equal((await run(request(name,'battery:read'))).status,200);
  }
  assert.deepEqual(calls,[{subject:'owner',kind:'connectivity'},{subject:'owner',kind:'mobile_access'}]);
});
test('vehicle reachability and mobile access use budgeted exact endpoints and project no identifiers', async () => {
  for (const state of ['online','asleep','offline']) {
    const f=fixture();
    const tx=await f.begin(); await f.callback(tx);
    f.remote(async()=>Response.json({response:{state,vin:'PRIVATE',id:123,display_name:'PRIVATE'}}));
    const before=f.calls.length;
    const result=await f.backend.vehicleConnectivity('owner');
    assert.equal(f.calls.length,before+1);
    assert.equal(result.state,state);
    assert.ok(f.calls.at(-1).url.endsWith('/api/1/vehicles/'+env.TESLA_VEHICLE_VIN));
    assert.doesNotMatch(JSON.stringify(result),/PRIVATE|vin|display_name/);
    assert.equal((await f.backend.connectionStatus('owner',{includeReadReadiness:true})).cached_read_readiness.budget.reserved,2);
    f.advance(61000);
    f.remote(async()=>Response.json({response:false}));
    const mobile=await f.backend.vehicleConnectivity('owner','mobile_access');
    assert.equal(mobile.mobile_access_enabled,false);
    assert.ok(f.calls.at(-1).url.endsWith('/mobile_enabled'));
  }
});
test('vehicle reachability rejects unrecognized modes and malformed upstream without retry', async () => {
  const f=fixture();
  await assert.rejects(()=>f.backend.vehicleConnectivity('owner','arbitrary_path'),/invalid_arguments/);
  assert.equal(f.calls.length,0);
  const tx=await f.begin(); await f.callback(tx);
  f.remote(async()=>Response.json({response:{state:'unknown'}}));
  const before=f.calls.length;
  await assert.rejects(()=>f.backend.vehicleConnectivity('owner'),/upstream/);
  assert.equal(f.calls.length,before+1);
  f.advance(61000);
  f.remote(async()=>Response.json({response:'true'}));
  await assert.rejects(()=>f.backend.vehicleConnectivity('owner','mobile_access'),/upstream/);
});
test('configuration fails closed for missing credentials, encryption key, region, identity and explicit gate', () => {
  for (const field of ['APP_ORIGIN','MCP_AUTH_JWKS','MCP_ALLOWED_SUBJECT','TOKEN_ENCRYPTION_KEY_BASE64','TESLA_CLIENT_ID','TESLA_CLIENT_SECRET','TESLA_FLEET_REGION','TESLA_BACKEND_ENABLED']) assert.throws(() => configuration({ ...env, [field]: '' }));
  assert.throws(() => configuration({ ...env, APP_ORIGIN: 'http://example.invalid' }));
});
test('real backend trims only configured owner whitespace and still matches JWT subject exactly', () => {
  const normalized = configuration({ ...env, MCP_ALLOWED_SUBJECT: '  owner\n' });
  assert.equal(normalized.env.MCP_ALLOWED_SUBJECT, 'owner');
  const request = token => new Request(config.audience, { headers: { authorization: 'Bearer ' + token } });
  assert.equal(authenticate(request(jwt()), normalized, 'battery:read'), 'owner');
  assert.throws(() => authenticate(request(jwt({ sub: ' owner' })), normalized, 'battery:read'));
  assert.throws(() => configuration({ ...env, MCP_ALLOWED_SUBJECT: ' \n ' }), /configuration/);
});
test('accepts legacy misspelled Vercel AES key without rotating; rejects conflicting keys', () => {
  const { TOKEN_ENCRYPTION_KEY_BASE64: original, ...rest } = env;
  const legacyOnly = configuration({ ...rest, TOKEN_ENCRYPTON_KEY_BASE64: original });
  assert.deepEqual(legacyOnly.key, config.key);
  assert.equal(legacyOnly.key.length, 32);
  const bothSame = configuration({ ...env, TOKEN_ENCRYPTON_KEY_BASE64: original });
  assert.deepEqual(bothSame.key, config.key);
  assert.throws(() => configuration({ ...rest, TOKEN_ENCRYPTON_KEY_BASE64: '' }), /configuration/);
  assert.throws(() => configuration({
    ...env,
    TOKEN_ENCRYPTON_KEY_BASE64: Buffer.alloc(32, 8).toString('base64')
  }), /configuration/);
});

test('MCP access validates signature, issuer, resource audience, expiry, owner, scope and token type', () => {
  const req = token => new Request(config.audience, { headers: { authorization: 'Bearer ' + token } });
  assert.equal(authenticate(req(jwt()), config, 'battery:read'), 'owner');
  // Auth0 uses typ=JWT for API access tokens, unlike strict RFC9068 at+jwt.
  // Correct API audience, owner, scopes and RSA signature remain mandatory.
  assert.equal(authenticate(req(jwt({}, { typ: 'JWT' })), config, 'battery:read'), 'owner');
  // Auth0 often includes both the MCP API audience and /userinfo.
  assert.equal(authenticate(req(jwt({ aud: [config.audience, 'https://issuer.example.invalid/userinfo'] })), config, 'battery:read'), 'owner');
  assert.equal(authenticate(req(jwt({ aud: [config.audience] })), config, 'battery:read'), 'owner');
  assert.throws(() => authenticate(req(jwt({ aud: 'auth0-client-id' }, { typ: 'JWT' })), config, 'battery:read'));
  const nowSeconds = Math.floor(Date.now()/1000);
  assert.equal(authenticate(req(jwt({ iat: nowSeconds, exp: nowSeconds + 86400 }, {typ:'JWT'})),config,'battery:read'),'owner');
  assert.throws(() => authenticate(req(jwt({ iat: nowSeconds, exp: nowSeconds + 86401 }, {typ:'JWT'})),config,'battery:read'));
  for (const claims of [{ iss: 'https://auth.tesla.com' }, { aud: 'different' },
    { aud: ['https://issuer.example.invalid/userinfo'] },
    { aud: ['other', 'another'] }, { aud: [] }, { aud: [config.audience, 12] },
    { aud: [config.audience, null] }, { aud: { resource: config.audience } },
    { sub: 'other' }, { exp: 0 }, { exp: '9999999999' }, { scope: 'tesla:connect' }, { nbf: Date.now() }, { iat: 0 }, { exp: Math.floor(Date.now()/1000)+10, iat: Math.floor(Date.now()/1000)+20 }]) assert.throws(() => authenticate(req(jwt(claims)), config, 'battery:read'));
  for (const h of [{ alg: 'none' }, { typ: 'id+jwt' }, { kid: 'unknown' }, { crit: ['x'] }]) assert.throws(() => authenticate(req(jwt({}, h)), config, 'battery:read'));
  assert.throws(() => authenticate(req(jwt().slice(0, -10) + 'bad'), config, 'battery:read'));
  assert.throws(() => authenticate(req('fake-tesla-access-token'), config, 'battery:read'));
});
test('AES-GCM ciphertext is bound to account, resists tampering and contains no plaintext token', () => {
  const encrypted = seal({ refresh: 'fake-sensitive-refresh' }, config.key, 'one');
  assert.doesNotMatch(encrypted, /fake-sensitive/);
  assert.equal(unseal(encrypted, config.key, 'one').refresh, 'fake-sensitive-refresh');
  assert.throws(() => unseal(encrypted, config.key, 'two'));
  assert.throws(() => unseal(encrypted.slice(0,-4)+'AAAA', config.key, 'one'));
});
test('persistent store enforces atomic consume and cross-instance lock ownership including expiry', async () => {
  const f = redis(); await f.store.put('state','opaque',10);
  assert.deepEqual(await Promise.all([f.store.take('state'), f.store.take('state')]), ['opaque',null]);
  const a = await f.store.lock('tokens'); await assert.rejects(f.store.lock('tokens'));
  f.advance(61000); const b = await f.store.lock('tokens');
  await assert.rejects(a.save('old',100)); await a.release();
  await assert.rejects(f.store.lock('tokens'));
  await b.save('new',100); assert.equal(await f.store.get('tokens'),'new'); await b.release();
});
test('OAuth state, S256 verifier and secure browser cookie; tokens stay encrypted and replay is rejected', async () => {
  const f = fixture(), tx = await f.begin();
  assert.deepEqual(tx.url.searchParams.get('scope').split(' '), ['openid','offline_access','vehicle_device_data','vehicle_location','vehicle_cmds','vehicle_charging_cmds']);
  assert.equal(tx.url.searchParams.get('code_challenge_method'),'S256');
  assert.equal((await f.callback(tx)).status,200);
  const form = new URLSearchParams(f.calls[0].opts.body);
  assert.equal(hash(form.get('code_verifier')),tx.url.searchParams.get('code_challenge'));
  assert.equal(form.get('client_secret'),'fake-secret');
  assert.equal(form.get('scope'),'openid offline_access vehicle_device_data vehicle_location vehicle_cmds vehicle_charging_cmds');
  const encrypted = await f.store.get(tokenKey);
  assert.doesNotMatch(encrypted,/fake-access|fake-refresh/);
  assert.equal(unseal(encrypted,config.key,tokenKey).refresh,'fake-refresh');
  assert.equal((await f.callback(tx)).status,400); assert.equal(f.calls.length,1);
});
test('OAuth token exchange fails closed when the request budget store is unavailable', async () => {
  const f = fixture(), tx = await f.begin();
  f.store.reserveTeslaBudget = async () => { throw Error('store unavailable'); };
  const result = await f.callback(tx);
  assert.equal(result.status, 503);
  assert.equal(f.calls.length, 0);
  assert.equal(await f.store.get(tokenKey), null);
});
test('OAuth failure diagnostics reveal only categorical information, never token values', async () => {
  const f = fixture(), tx = await f.begin(), logs = [], original = console.info;
  f.remote(async () => Response.json({ access_token:'secret-test-access', refresh_token:'secret-test-refresh', token_type:'Bearer', expires_in:3600 }));
  console.info = (...args) => logs.push(args.map(String).join(' '));
  try {
    assert.equal((await f.callback(tx)).status,503);
    assert.equal(f.calls.length,1);
    assert.ok(logs.some(line => line.includes('TESLA_TOKEN_HTTP_STATUS 200')));
    assert.ok(logs.some(line => line.includes('"scope_present":false')));
    assert.ok(logs.some(line => line.includes('TESLA_OAUTH_FAILURE reauthorize')));
    assert.doesNotMatch(logs.join('\n'), /secret-test-access|secret-test-refresh|fake-code|fake-secret/);
  } finally { console.info = original; }
});
test('OAuth accepts requested vehicle permissions in the Tesla token response', async () => {
  const f = fixture(), tx = await f.begin();
  f.remote(async () => Response.json({ access_token:'fake-access', refresh_token:'fake-refresh', token_type:'Bearer', expires_in:3600, scope:'openid offline_access vehicle_device_data vehicle_location' }));
  assert.equal((await f.callback(tx)).status,200);
  assert.ok(await f.store.get(tokenKey));
  assert.equal(f.calls.length,1);
});
test('connection status reports the four vehicle permission categories without contacting Tesla', async () => {
  const f=fixture(), tx=await f.begin();
  f.remote(async()=>Response.json({access_token:'fake-access',refresh_token:'fake-refresh',token_type:'Bearer',expires_in:3600,scope:'openid offline_access vehicle_device_data vehicle_location vehicle_cmds vehicle_charging_cmds'}));
  assert.equal((await f.callback(tx)).status,200);
  const callsBefore=f.calls.length;
  const status=await f.backend.connectionStatus('owner');
  assert.equal(status.connected,true);
  assert.equal(status.all_vehicle_permissions_granted,true);
  assert.deepEqual(status.vehicle_permissions,{vehicle_information:true,vehicle_location:true,vehicle_commands:true,charging_management:true});
  assert.equal(f.calls.length,callsBefore);
});
test('live vehicle-data readiness diagnoses feature gates, quota and missing vehicle config using storage only', async () => {
  const f = fixture(Date.UTC(2026, 10, 1, 12));
  const tokens = { access: 'FIXTURE_ACCESS', refresh: 'FIXTURE_REFRESH',
    scopes: ['vehicle_device_data'], expires: f.now() - 1, refreshExpires: f.now() + 86400000 };
  await f.store.put(tokenKey, seal(tokens, config.key, tokenKey), 3600);
  for (let slot = 0; slot < 9; slot++) await f.store.once('read-budget:2026-11-01:' + slot, 172800);
  const ordinary = await f.backend.connectionStatus('owner');
  assert.equal(ordinary.live_vehicle_data_readiness, undefined);
  assert.equal(ordinary.cached_read_readiness, undefined);
  assert.equal(f.commands.filter(args => args[0] === 'GET' && args[1].includes('read-budget:')).length, 0);
  const result = await f.backend.connectionStatus('owner', { includeReadReadiness: true });
  const readiness = result.live_vehicle_data_readiness;
  assert.deepEqual(result.cached_read_readiness, readiness, 'keep the existing readiness field for the current MCP client');
  assert.equal(result.connected, true);
  assert.deepEqual(result.enabled_features, {
    cached_vehicle_data: true,
    vehicle_connectivity: true,
    vehicle_mobile_access: true,
    live_vehicle_data: true,
    vehicle_reading_history: true,
    vehicle_location: false,
    charging_history: true,
    vehicle_command_tools: false
  });
  assert.equal(readiness.vehicle_configured, true);
  assert.equal(readiness.requests_needed, 2);
  assert.equal(readiness.budget.remaining, 1);
  assert.equal(readiness.budget_sufficient, false);
  assert.equal(readiness.ready, false);
  const noVehicle = createTeslaBackend({ config: configuration({ ...env, TESLA_VEHICLE_VIN: '' }),
    store: f.store, now: f.now, fetcher: async () => { throw Error('must not call Tesla'); } });
  const missing = await noVehicle.connectionStatus('owner', { includeReadReadiness: true });
  assert.equal(missing.live_vehicle_data_readiness.vehicle_configured, false);
  assert.equal(missing.cached_read_readiness.vehicle_configured, false);
  assert.equal(f.calls.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /FIXTURE_ACCESS|FIXTURE_REFRESH|5YJ3E1EA0LF000000/);
  assert.equal(f.commands.filter(args => args[0] === 'SET' && args[1].includes('read-budget:')).length, 9);
});
test('command setup creates one encrypted server key and returns only the explicit registration link',async()=>{
  const f=fixture(),tx=await f.begin();
  f.remote(async()=>Response.json({access_token:'fake-access',refresh_token:'fake-refresh',token_type:'Bearer',expires_in:3600,scope:'openid offline_access vehicle_device_data vehicle_location vehicle_cmds vehicle_charging_cmds'}));
  assert.equal((await f.callback(tx)).status,200);
  const commandConfig=configuration({...env,APP_ORIGIN:TESLA_P256_ORIGIN,VERCEL_ENV:'production',TESLA_PARTNER_REGISTRATION_APPROVED:'true'});
  const backend=createTeslaBackend({config:commandConfig,store:f.store,fetcher:async()=>{throw Error('setup must not call Tesla');}});
  const result=await backend.prepareVehicleCommandSetup('owner');
  assert.equal(result.source,'TESLA_VIRTUAL_KEY_SETUP');
  assert.equal(result.key_created,true);
  assert.match(result.key_fingerprint_sha256,/^[a-f0-9]{64}$/);
  assert.equal(result.public_key_url,TESLA_P256_ORIGIN+'/.well-known/appspecific/com.tesla.3p.public-key.pem');
  assert.equal(result.partner_domain_registered,false);
  assert.equal(result.vehicle_pairing_required,false);
  assert.match(result.partner_registration_approval_url,/^https:\/\/mcp\.example\.invalid\/oauth\/tesla\/partner-registration\?ticket=/);
  assert.equal(result.partner_registration_expires_in_seconds,300);
  assert.equal(result.pairing_url,undefined);
  assert.equal(result.no_vehicle_command_sent,true);
  assert.doesNotMatch(JSON.stringify(result),/BEGIN PUBLIC KEY|BEGIN PRIVATE KEY|fake-access|fake-refresh/);
  assert.equal(f.calls.length,1,'only the simulated OAuth token exchange was made');
  const stored=f.rows.get('tesla-voice:v1:'+TESLA_P256_IDENTITY_STORE_KEY)?.value;
  assert.ok(stored);
  assert.doesNotMatch(stored,/BEGIN PRIVATE KEY/);
  assert.doesNotMatch(stored,/private-test-token/);
});
test('confirmed command is owner-bound, single-use, signed internally and exposes no invented command id',async()=>{
  const f=fixture(),tx=await f.begin();
  f.remote(async()=>Response.json({access_token:'fake-access',refresh_token:'fake-refresh',token_type:'Bearer',expires_in:3600,scope:'openid offline_access vehicle_device_data vehicle_location vehicle_cmds vehicle_charging_cmds'}));
  assert.equal((await f.callback(tx)).status,200);
  const commandConfig=configuration({...env,APP_ORIGIN:TESLA_P256_ORIGIN,VERCEL_ENV:'production',TESLA_COMMANDS_ENABLED:'true',TESLA_COMMAND_EXECUTION_ENABLED:'true'});
  let envelope, signedHeaders, networkCalls=0;
  const backend=createTeslaBackend({config:commandConfig,store:f.store,fetcher:async(url,opts)=>{
    networkCalls++;
    assert.equal(url,TESLA_P256_ORIGIN+'/api/tesla-command-proxy');
    envelope=JSON.parse(opts.body);signedHeaders=opts.headers;
    return Response.json({accepted:true});
  }});
  await backend.prepareVehicleCommandSetup('owner');
  const prepared=await backend.prepareCommand('owner','door_lock',{});
  assert.equal(prepared.execution_enabled,true);
  assert.equal(prepared.confirmation_required,true);
  assert.equal(networkCalls,0);
  const result=await backend.confirmCommand('owner',prepared.ticket,prepared.confirmation_phrase);
  assert.equal(result.accepted,true);
  assert.equal(result.completed,false);
  assert.equal(result.command_id,undefined);
  assert.equal(networkCalls,1);
  assert.equal(envelope.operation,'door_lock');
  assert.equal(envelope.access_token,'fake-access');
  assert.match(envelope.private_key_pem,/BEGIN PRIVATE KEY/);
  const signingKey=createHmac('sha256',commandConfig.key).update('tesla-command-proxy-v1').digest();
  const expected=createHmac('sha256',signingKey).update(signedHeaders['x-tesla-command-time']+'\n'+JSON.stringify(envelope)).digest('base64url');
  assert.equal(signedHeaders['x-tesla-command-signature'],expected);
  await assert.rejects(backend.confirmCommand('owner',prepared.ticket,prepared.confirmation_phrase),/expired|used/);
  assert.equal(networkCalls,1,'replay never sends another command');
});
test('uncertain wake outcome from proxy stays unknown and cannot be replayed',async()=>{
  const f=fixture(),tx=await f.begin();
  f.remote(async()=>Response.json({access_token:'fake-access',refresh_token:'fake-refresh',token_type:'Bearer',expires_in:3600,scope:'openid offline_access vehicle_device_data vehicle_location vehicle_cmds vehicle_charging_cmds'}));
  assert.equal((await f.callback(tx)).status,200);
  const commandConfig=configuration({...env,APP_ORIGIN:TESLA_P256_ORIGIN,VERCEL_ENV:'production',TESLA_COMMANDS_ENABLED:'true',TESLA_COMMAND_EXECUTION_ENABLED:'true'});
  let calls=0;
  const backend=createTeslaBackend({config:commandConfig,store:f.store,fetcher:async()=>{calls++;return Response.json({error:'command_outcome_unknown'},{status:502});}});
  await backend.prepareVehicleCommandSetup('owner');
  const prepared=await backend.prepareCommand('owner','wake_up',{});
  assert.equal(calls,0);
  await assert.rejects(backend.confirmCommand('owner',prepared.ticket,prepared.confirmation_phrase),/^Error: command_outcome_unknown$/);
  await assert.rejects(backend.confirmCommand('owner',prepared.ticket,prepared.confirmation_phrase),/expired|used/);
  assert.equal(calls,1);
});
test('direct requested command dispatches once and rejects replay',async()=>{
  const f=fixture(),tx=await f.begin();
  f.remote(async()=>Response.json({access_token:'fake-access',refresh_token:'fake-refresh',token_type:'Bearer',expires_in:3600,scope:'openid offline_access vehicle_device_data vehicle_location vehicle_cmds vehicle_charging_cmds'}));
  assert.equal((await f.callback(tx)).status,200);
  const commandConfig=configuration({...env,APP_ORIGIN:TESLA_P256_ORIGIN,VERCEL_ENV:'production',TESLA_COMMANDS_ENABLED:'true',TESLA_COMMAND_EXECUTION_ENABLED:'true'});
  let calls=0;
  const backend=createTeslaBackend({config:commandConfig,store:f.store,fetcher:async()=>{calls++;return Response.json({accepted:true,command_id:'fixture'});}});
  await backend.prepareVehicleCommandSetup('owner');
  const id='request_identifier_123456';
  const result=await backend.executeRequestedCommand('owner','navigation_request',{destination:'Test city'},id);
  assert.equal(result.accepted,true); assert.equal(calls,1);
  assert.deepEqual(await backend.executeRequestedCommand('owner','navigation_request',{destination:'Test city'},id),{...result,dispatch_performed:false,result_reused:true});
  assert.equal(calls,1,'a retry with the same request ID returns the saved result without dispatch');
  assert.equal((await backend.executeRequestedCommand('owner','navigation_request',{destination:'Another city'},id)).accepted,true);
  assert.equal(calls,2);
  assert.equal((await backend.executeRequestedCommand('owner','navigation_request',{destination:'Test city'},'request_identifier_654321')).accepted,true);
  assert.equal(calls,3,'a distinct request ID represents a distinct user request');
});
test('direct commands block a fresh ID after uncertain outcome but allow repeats after success',async()=>{
  const f=fixture(),tx=await f.begin();
  f.remote(async()=>Response.json({access_token:'fake-access',refresh_token:'fake-refresh',token_type:'Bearer',expires_in:3600,scope:'openid offline_access vehicle_device_data vehicle_location vehicle_cmds vehicle_charging_cmds'}));
  assert.equal((await f.callback(tx)).status,200);
  const commandConfig=configuration({...env,APP_ORIGIN:TESLA_P256_ORIGIN,VERCEL_ENV:'production',TESLA_COMMANDS_ENABLED:'true',TESLA_COMMAND_EXECUTION_ENABLED:'true'});
  let calls=0, fail=true;
  const backend=createTeslaBackend({config:commandConfig,store:f.store,fetcher:async()=>{calls++;if(fail){fail=false;return Response.json({error:'command_outcome_unknown'},{status:502});}return Response.json({accepted:true,command_id:'fixture'});}});
  await backend.prepareVehicleCommandSetup('owner');
  const requestId='request_identifier_111111';
  await assert.rejects(backend.executeRequestedCommand('owner','navigation_request',{destination:'Test city'},requestId),/command_outcome_unknown/);
  await assert.rejects(backend.executeRequestedCommand('owner','navigation_request',{destination:'Test city'},requestId),/command_pending/);
  await assert.rejects(backend.executeRequestedCommand('owner','navigation_request',{destination:'Test city'},'request_identifier_222222'),/command_pending/);
  assert.equal(calls,1);
  assert.equal((await backend.executeRequestedCommand('owner','media_volume_up',{},'request_identifier_333333')).accepted,true);
  assert.equal((await backend.executeRequestedCommand('owner','media_volume_up',{},'request_identifier_444444')).accepted,true);
  assert.equal(calls,3);
});
test('direct command keeps its pending guard if Tesla accepted but result storage fails',async()=>{
  const f=fixture(),tx=await f.begin();
  f.remote(async()=>Response.json({access_token:'fake-access',refresh_token:'fake-refresh',token_type:'Bearer',expires_in:3600,scope:'openid offline_access vehicle_device_data vehicle_location vehicle_cmds vehicle_charging_cmds'}));
  assert.equal((await f.callback(tx)).status,200);
  const commandConfig=configuration({...env,APP_ORIGIN:TESLA_P256_ORIGIN,VERCEL_ENV:'production',TESLA_COMMANDS_ENABLED:'true',TESLA_COMMAND_EXECUTION_ENABLED:'true'});
  let calls=0;
  const backend=createTeslaBackend({config:commandConfig,store:f.store,fetcher:async()=>{calls++;return Response.json({accepted:true});}});
  await backend.prepareVehicleCommandSetup('owner');
  const originalPut=f.store.put;
  f.store.put=async(key,...args)=>{if(key.startsWith('direct-result:'))throw Error('store');return originalPut(key,...args);};
  await assert.rejects(backend.executeRequestedCommand('owner','door_lock',{},'request_identifier_333333'),/store/);
  f.store.put=originalPut;
  await assert.rejects(backend.executeRequestedCommand('owner','door_lock',{},'request_identifier_444444'),/command_pending/);
  assert.equal(calls,1,'an accepted command is not dispatched again when its result could not be recorded');
});
test('command failure logs only the fixed confirmation stage without sensitive inputs',async()=>{
  const f=fixture();
  const commandConfig=configuration({...env,APP_ORIGIN:TESLA_P256_ORIGIN,VERCEL_ENV:'production',TESLA_COMMANDS_ENABLED:'true',TESLA_COMMAND_EXECUTION_ENABLED:'true'});
  let calls=0;
  const backend=createTeslaBackend({config:commandConfig,store:f.store,fetcher:async()=>{calls++;throw Error('unexpected network');}});
  const originalInfo=console.info, logs=[];
  console.info=(...args)=>logs.push(args);
  try {
    await assert.rejects(backend.confirmCommand('private-owner','private-ticket','private-confirmation'),/invalid_confirmation/);
  } finally { console.info=originalInfo; }
  assert.deepEqual(logs,[['TESLA_COMMAND_FAILURE_STAGE','confirmation']]);
  assert.equal(calls,0);
});
test('refresh that drops a command scope invalidates the rotated token and sends no command',async()=>{
  const f=fixture(),tx=await f.begin();
  f.remote(async()=>Response.json({access_token:'fake-access',refresh_token:'fake-refresh',token_type:'Bearer',expires_in:90,scope:'openid offline_access vehicle_device_data vehicle_cmds vehicle_charging_cmds'}));
  assert.equal((await f.callback(tx)).status,200);
  const commandConfig=configuration({...env,APP_ORIGIN:TESLA_P256_ORIGIN,VERCEL_ENV:'production',TESLA_COMMANDS_ENABLED:'true',TESLA_COMMAND_EXECUTION_ENABLED:'true'});
  let commandCalls=0,refreshCalls=0;
  const backend=createTeslaBackend({config:commandConfig,store:f.store,now:f.now,fetcher:async(url)=>{
    if(url.includes('/token')){refreshCalls++;return Response.json({access_token:'restricted-access',refresh_token:'rotated-refresh',token_type:'Bearer',expires_in:3600,scope:'openid offline_access vehicle_device_data'});}
    commandCalls++;return Response.json({accepted:true});
  }});
  await backend.prepareVehicleCommandSetup('owner');
  const prepared=await backend.prepareCommand('owner','door_lock',{});
  f.advance(40000);
  await assert.rejects(backend.confirmCommand('owner',prepared.ticket,prepared.confirmation_phrase),/permission/);
  assert.equal(refreshCalls,1);
  assert.equal(commandCalls,0);
  assert.equal(unseal(await f.store.get(tokenKey),config.key,tokenKey).invalid,true);
});
test('Tesla token response may provide allowed scopes in scp while extra or missing scopes fail closed', async () => {
  function teslaToken(scp) {
    const head = Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT'})).toString('base64url');
    const body = Buffer.from(JSON.stringify({iss:'https://auth.tesla.com/oauth2/v3/nts',aud:config.fleet,sub:'fake-owner',scp})).toString('base64url');
    return head+'.'+body+'.'+sign('RSA-SHA256',Buffer.from(head+'.'+body),privateKey).toString('base64url');
  }
  for (const [scp, expected] of [
    [['openid','offline_access','vehicle_device_data'],200],
    [['openid','vehicle_device_data','vehicle_location'],200],
    [['openid','vehicle_device_data','vehicle_cmds'],200],
    [['openid','vehicle_device_data','vehicle_charging_cmds'],200],
    [['openid','vehicle_device_data','energy_cmds'],503],
    [['openid'],503],
    ['vehicle_device_data',503]
  ]) {
    const f=fixture(), tx=await f.begin(), access=teslaToken(scp);
    f.remote(async()=>Response.json({access_token:access,refresh_token:'fake-refresh',token_type:'Bearer',expires_in:3600}));
    assert.equal((await f.callback(tx)).status,expected);
    assert.equal(Boolean(await f.store.get(tokenKey)),expected===200);
    // Tesla access tokens must never authenticate as MCP client tokens.
    assert.throws(()=>authenticate(new Request(config.audience,{headers:{authorization:'Bearer '+access}}),config,'battery:read'));
  }
  const f=fixture(), tx=await f.begin();
  f.remote(async()=>Response.json({access_token:teslaToken(['vehicle_device_data','energy_cmds']),refresh_token:'fake-refresh',token_type:'Bearer',expires_in:3600,scope:'vehicle_device_data'}));
  assert.equal((await f.callback(tx)).status,503);
  assert.equal(await f.store.get(tokenKey),null);
});
test('OAuth rejects foreign browser, duplicate query, expired state and provider denial without token exchange', async () => {
  for (const scenario of ['cookie','duplicate','expiry','denied']) {
    const f=fixture(), tx=await f.begin();
    if (scenario==='cookie') tx.cookie='__Host-tesla-oauth='+'x'.repeat(43);
    if (scenario==='expiry') f.advance(601000);
    const r=await f.callback(tx,scenario==='duplicate'?'&state='+tx.state:scenario==='denied'?'&error=access_denied&error_description=PRIVATE':'');
    assert.equal(r.status,400); assert.equal(f.calls.length,0); assert.doesNotMatch(await r.text(),/PRIVATE|fake-code/);
  }
});
test('Tesla callback accepts only the expected issuer parameter without ambiguity', async () => {
  const issuer = encodeURIComponent('https://auth.tesla.com/oauth2/v3');
  for (const [suffix, status, calls] of [
    ['&issuer=' + issuer, 200, 1],
    ['&iss=' + issuer, 200, 1],
    ['&issuer=' + encodeURIComponent('https://other.invalid'), 400, 0],
    ['&issuer=' + issuer + '&issuer=' + issuer, 400, 0],
    ['&iss=' + issuer + '&issuer=' + issuer, 400, 0],
  ]) {
    const f = fixture(), tx = await f.begin();
    const r = await f.callback(tx, suffix);
    assert.equal(r.status, status);
    assert.equal(f.calls.length, calls);
  }
});
test('OAuth start requires independently authenticated owner, same origin and JSON; rate limits initiation', async () => {
  const f=fixture();
  assert.equal((await f.backend.start(new Request(config.origin,{method:'GET'}))).status,405);
  assert.equal((await f.backend.start(new Request(config.origin,{method:'POST'}))).status,403);
  assert.equal((await f.backend.start(new Request(config.origin,{method:'POST',headers:{origin:config.origin,'content-type':'application/json',authorization:'Bearer fake-tesla-token'}}))).status,401);
  await f.start(); assert.equal((await f.start()).status,429); assert.equal(f.calls.length,0);
});
test('battery returns only allowlisted fields from Tesla cache; no VIN/location/tokens or commands escape', async () => {
  const f=fixture(); await f.callback(await f.begin());
  const data=await f.backend.battery('owner'); assert.equal(data.battery_percent,71);
  assert.equal(data.source,'TESLA_CACHED'); assert.ok(data.observed_at); assert.equal(data.history_recorded,true);
  assert.doesNotMatch(JSON.stringify(data),/fake-access|fake-refresh|must-not-escape|latitude/);
  const cachedUrl=new URL(f.calls[1].url);
  assert.equal(cachedUrl.pathname,'/api/1/vehicles/'+env.TESLA_VEHICLE_VIN+'/vehicle_data_cached');
  assert.equal(cachedUrl.search,'');
  assert.equal(f.calls[1].opts.method,undefined);
  // Tesla requires Content-Type JSON even on GET, otherwise may return 406.
  assert.equal(f.calls[1].opts.headers['content-type'],'application/json');
  assert.equal(f.calls[1].opts.headers.accept,'application/json');
  assert.equal(f.calls[1].opts.headers.authorization,'Bearer fake-access');
  assert.equal(f.calls.length,2);
  const beforeHistory=f.calls.length;
  const history=await f.backend.vehicleReadingHistory('owner');
  assert.equal(history.readings.length,1);
  assert.equal(history.readings[0].source,'TESLA_CACHED');
  assert.ok(history.readings[0].requested_at && history.readings[0].observed_at);
  assert.equal(f.calls.length,beforeHistory,'reading history must not contact Tesla');
  const encrypted=await f.store.get('vehicle-reading-history:'+hash(config.issuer+'\nowner'));
  assert.doesNotMatch(encrypted,/fake-access|fake-refresh|5YJ3E1EA0LF000000/);
  assert.equal((await f.backend.battery('owner')).battery_percent,71);
});
test('live vehicle, tire, climate and charging details are allowlisted and bounded', async () => {
  const f=fixture(); await f.callback(await f.begin());
  f.remote(async()=>Response.json({response:{charge_state:{battery_level:62,timestamp:Date.now(),battery_range:200.5,charge_limit_soc:80,charging_state:'Charging',charger_power:11,scheduled_charging_pending:true,secret:'PRIVATE'},vehicle_state:{locked:true,odometer:1234.5,tpms_pressure_fl:2.7,software_update:{status:'available',version:'2026.1',secret:'PRIVATE'},vin:'PRIVATE'},climate_state:{inside_temp:20.5,seat_heater_rear_left:2,secret:'PRIVATE'},drive_state:{latitude:12}}}));
  const result=await f.backend.battery('owner',{live:true});
  assert.equal(result.estimated_range_miles,200.5);
  assert.equal(result.charge_limit_percent,80);
  assert.equal(result.charging_state,'Charging');
  assert.equal(result.charger_power_kw,11);
  assert.equal(result.scheduled_charging_pending,true);
  assert.equal(result.vehicle_status.locked,true);
  assert.equal(result.vehicle_status.tire_pressure_bar.fl,2.7);
  assert.equal(result.vehicle_status.software_update.version,'2026.1');
  assert.equal(result.climate.inside_temperature_c,20.5);
  assert.equal(result.climate.seat_heater_rear_left,2);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE|latitude/);
  assert.equal(f.calls.length,2);
  assert.match(f.calls[1].url,/vehicle_data\?/);
  assert.doesNotMatch(f.calls[1].url,/location_data|drive_state|wake_up|vehicle_data_cached/);
});
test('cached and live readings are both retained in encrypted chronological history', async () => {
  const f=fixture(); await f.callback(await f.begin());
  const cached=await f.backend.battery('owner');
  assert.equal(cached.source,'TESLA_CACHED');
  f.advance(61000);
  f.remote(async()=>Response.json({response:{charge_state:{battery_level:68,timestamp:f.now(),battery_range:210},vehicle_state:{locked:true,odometer:1000}}}));
  const live=await f.backend.battery('owner',{live:true});
  assert.equal(live.source,'TESLA_LIVE');
  const history=await f.backend.vehicleReadingHistory('owner',31);
  assert.equal(history.readings.length,2);
  assert.deepEqual(history.readings.map(item=>item.source),['TESLA_CACHED','TESLA_LIVE']);
  assert.ok(Date.parse(history.readings[0].requested_at)<Date.parse(history.readings[1].requested_at));
  assert.equal(history.readings[1].battery_percent,68);
  assert.equal(history.readings[1].vehicle_status.locked,true);
  assert.doesNotMatch(JSON.stringify(history),/5YJ3E1EA0LF000000|fake-access|fake-refresh|latitude|longitude/);
  assert.equal(f.calls.filter(call=>call.url.includes('/vehicle_data')).length,2);
});
test('prepared location is disabled by default without network or budget consumption', async () => {
  const f=fixture();
  await assert.rejects(f.backend.location('owner'),/disabled/);
  assert.equal(f.calls.length,0);
  assert.equal(f.commands.length,0);
});
test('prepared location makes one budgeted live read and returns only valid coordinates and timestamp', async () => {
  const f=fixture();
  f.remote(async()=>Response.json({access_token:'fake-access',refresh_token:'fake-refresh',token_type:'Bearer',expires_in:3600,scope:'openid offline_access vehicle_device_data vehicle_location'}));
  await f.callback(await f.begin());
  const calls=[];
  const backend=createTeslaBackend({config:{...config,env:{...env,TESLA_LOCATION_ENABLED:'true'}},store:f.store,fetcher:async(url,opts)=>{
    calls.push({url,opts});
    return Response.json({response:{drive_state:{latitude:45,longitude:9,timestamp:Date.now(),active_route_destination:'Innsbruck',active_route_energy_at_arrival:18,active_route_miles_to_arrival:10,active_route_minutes_to_arrival:20.2,active_route_traffic_minutes_delay:3,active_route_route_line:'PRIVATE_ROUTE',secret:'PRIVATE'},vin:'PRIVATE'}});
  }});
  const result=await backend.location('owner',20);
  assert.deepEqual([result.source,result.latitude,result.longitude],['TESLA_LIVE',45,9]);
  assert.deepEqual(result.navigation,{destination:'Innsbruck',expected_arrival_battery_percent:18,distance_to_arrival_km:16.1,eta_minutes:20.2,traffic_delay_minutes:3});
  assert.deepEqual(result.route_reserve_assessment,{available:true,reserve_percent:20,expected_arrival_battery_percent:18,meets_reserve:false,shortfall_percentage_points:2});
  assert.ok(result.observed_at);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE|vin|active_route_route_line/);
  assert.equal(calls.length,1);
  assert.match(calls[0].url,/vehicle_data\?endpoints=location_data$/);
  assert.doesNotMatch(calls[0].url,/wake_up/);
  assert.equal(f.commands.filter(c=>c[0]==='EVAL' && c[2]===50).length,2);
});
test('location reserve assessment reports sufficient reserve and unavailable Tesla estimates', async () => {
  const f=fixture();
  f.remote(async()=>Response.json({access_token:'fake-access',refresh_token:'fake-refresh',token_type:'Bearer',expires_in:3600,scope:'openid offline_access vehicle_device_data vehicle_location'}));
  await f.callback(await f.begin());
  let arrival=25, vehicleCalls=0;
  const backend=createTeslaBackend({config:{...config,env:{...env,TESLA_LOCATION_ENABLED:'true'}},store:f.store,now:f.now,fetcher:async()=>{
    vehicleCalls++;
    return Response.json({response:{drive_state:{latitude:45,longitude:9,timestamp:f.now(),active_route_energy_at_arrival:arrival}}});
  }});
  const sufficient=await backend.location('owner',20);
  assert.deepEqual(sufficient.route_reserve_assessment,{available:true,reserve_percent:20,expected_arrival_battery_percent:25,meets_reserve:true,shortfall_percentage_points:0});
  f.advance(61000);
  arrival=undefined;
  const unavailable=await backend.location('owner',20);
  assert.deepEqual(unavailable.route_reserve_assessment,{available:false,reserve_percent:20,note:'Tesla did not provide an estimated arrival battery percentage for an active route.'});
  assert.equal(vehicleCalls,2);
});
test('location reserve assessment rejects invalid limits before contacting Tesla', async () => {
  const f=fixture();
  const backend=createTeslaBackend({config:{...config,env:{...env,TESLA_LOCATION_ENABLED:'true'}},store:f.store,fetcher:async()=>{throw Error('Tesla must not be called for invalid reserve input');}});
  await assert.rejects(backend.location('owner',101),/invalid_arguments/);
  assert.equal(f.calls.length,0);
});
test('location omits a Tesla arrival battery estimate outside the valid percent range', async () => {
  const f=fixture();
  f.remote(async()=>Response.json({access_token:'fake-access',refresh_token:'fake-refresh',token_type:'Bearer',expires_in:3600,scope:'openid offline_access vehicle_device_data vehicle_location'}));
  await f.callback(await f.begin());
  const backend=createTeslaBackend({config:{...config,env:{...env,TESLA_LOCATION_ENABLED:'true'}},store:f.store,fetcher:async()=>
    Response.json({response:{drive_state:{latitude:45,longitude:9,timestamp:Date.now(),active_route_energy_at_arrival:101}}})});
  const result=await backend.location('owner');
  assert.equal(result.navigation,undefined);
});
test('MCP maps a Tesla location timeout to vehicle_unavailable without retry', async () => {
  const f=fixture();
  f.remote(async()=>Response.json({access_token:'fake-access',refresh_token:'fake-refresh',token_type:'Bearer',expires_in:3600,scope:'openid offline_access vehicle_device_data vehicle_location'}));
  await f.callback(await f.begin());
  const configWithLocation={...config,env:{...env,TESLA_LOCATION_ENABLED:'true'}};
  const calls=[];
  const backend=createTeslaBackend({config:configWithLocation,store:f.store,now:f.now,fetcher:async(url,opts)=>{
    calls.push({url,opts});
    return Response.json({error:'PRIVATE_UPSTREAM_BODY'}, {status:408});
  }});
  const run=realMcp({config:configWithLocation,backend});
  const r=mcpRequest('tools/call',{name:'get_vehicle_location',arguments:{}});
  const h=new Headers(r.headers);
  h.set('authorization','Bearer '+jwt({scope:'location:read'},{},f.now()));
  const response=await run(new Request(config.audience,{method:'POST',headers:h,body:r.body,duplex:'half'}));
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.result.isError,true);
  const failure=JSON.parse(body.result.content[0].text);
  assert.equal(failure.error.code,'vehicle_unavailable');
  assert.match(failure.error.message,/No automatic attempt will be made/);
  assert.equal(calls.length,1,'one Tesla location request, with no retry');
  assert.match(calls[0].url,/vehicle_data\?endpoints=location_data$/);
  assert.doesNotMatch(calls[0].url,/wake_up|vehicle_data_cached/);
  assert.equal(f.calls.length,1,'only the initial OAuth exchange occurred');
  assert.doesNotMatch(JSON.stringify(body),/PRIVATE_UPSTREAM_BODY|fake-access|VIN/);
});
test('location fails closed before Tesla calls unless the stored Tesla token has vehicle_location', async () => {
  const f=fixture(); await f.callback(await f.begin());
  const backend=createTeslaBackend({config:{...config,env:{...env,TESLA_LOCATION_ENABLED:'true'}},store:f.store,fetcher:async()=>{throw Error('Tesla must not be called without location scope');}});
  await assert.rejects(backend.location('owner'),/permission/);
  assert.equal(f.calls.length,1,'only the original OAuth token exchange occurred');
});
test('location and charging diagnostics log only operation and HTTP status or invalid shape', async () => {
  const f=fixture();
  f.remote(async()=>Response.json({access_token:'fake-access',refresh_token:'fake-refresh',token_type:'Bearer',expires_in:3600,scope:'openid offline_access vehicle_device_data vehicle_location vehicle_charging_cmds'}));
  await f.callback(await f.begin());
  let calls=0;
  const backend=createTeslaBackend({config:{...config,env:{...env,TESLA_LOCATION_ENABLED:'true'}},store:f.store,now:f.now,fetcher:async()=>{
    calls++;
    return calls===1 ? Response.json({private:'SECRET'}, {status:503}) : Response.json({response:{private:'SECRET'}});
  }});
  const originalInfo=console.info, logs=[];
  console.info=(...args)=>logs.push(args);
  try {
    await assert.rejects(backend.location('owner'),/upstream/);
    f.advance(61000);
    await assert.rejects(backend.chargingHistory('owner',7),/upstream/);
  } finally { console.info=originalInfo; }
  assert.deepEqual(logs,[['TESLA_READ_HTTP_STATUS','location',503],['TESLA_READ_HTTP_STATUS','charging_history',200],['TESLA_READ_RESPONSE_SHAPE','charging_history',JSON.stringify({top_level_keys:['response'],response_type:'object',response_keys:['private'],data_type:'undefined'})],['TESLA_READ_RESPONSE_INVALID','charging_history']]);
  assert.equal(calls,2);
  assert.doesNotMatch(JSON.stringify(logs),/SECRET|fake-access|owner/);
});
test('invalid charging response logs bounded schema keys but never response values', async () => {
  const f=fixture();
  f.remote(async()=>Response.json({access_token:'fake-access',refresh_token:'fake-refresh',token_type:'Bearer',expires_in:3600,scope:'openid offline_access vehicle_device_data vehicle_charging_cmds'}));
  await f.callback(await f.begin());
  const backend=createTeslaBackend({config,store:f.store,now:f.now,fetcher:async()=>Response.json({response:{sessions:[{site_name:'PRIVATE'}],vin:'PRIVATE'},error_description:'PRIVATE'})});
  const originalInfo=console.info, logs=[];
  console.info=(...args)=>logs.push(args);
  try { await assert.rejects(backend.chargingHistory('owner',7),/upstream/); }
  finally { console.info=originalInfo; }
  const shape=logs.find(row=>row[0]==='TESLA_READ_RESPONSE_SHAPE');
  assert.deepEqual(JSON.parse(shape[2]),{top_level_keys:['response','error_description'],response_type:'object',response_keys:['sessions','vin'],data_type:'undefined'});
  assert.doesNotMatch(JSON.stringify(logs),/PRIVATE|fake-access|owner/);
});
test('prepared location rejects malformed data and does not fall back or retry', async () => {
  const f=fixture();
  f.remote(async()=>Response.json({access_token:'fake-access',refresh_token:'fake-refresh',token_type:'Bearer',expires_in:3600,scope:'openid offline_access vehicle_device_data vehicle_location'}));
  await f.callback(await f.begin());
  let calls=0;
  const backend=createTeslaBackend({config:{...config,env:{...env,TESLA_LOCATION_ENABLED:'true'}},store:f.store,fetcher:async()=>{calls++;return Response.json({response:{drive_state:{latitude:91,longitude:9,timestamp:Date.now()}}});}});
  await assert.rejects(backend.location('owner'),/upstream/);
  assert.equal(calls,1);
});
test('charging history requires the Tesla charging scope and returns only bounded safe fields', async () => {
  const f=fixture();
  let requestUrl;
  f.remote(async(url)=>{
    if(url.includes('/token')) return Response.json({access_token:'fake-access',refresh_token:'fake-refresh',token_type:'Bearer',expires_in:3600,scope:'openid offline_access vehicle_device_data vehicle_charging_cmds'});
    requestUrl=new URL(url);
    return Response.json({response:{data:[{sessionId:123,vin:'PRIVATE-VIN',siteLocationName:'Milano Supercharger',chargeStartDateTime:'2026-10-31T10:00:00Z',chargeStopDateTime:'2026-10-31T10:30:00Z',countryCode:'it',billingType:'IMMEDIATE',fees:[{feeType:'CHARGING',currencyCode:'eur',totalDue:3.42,uom:'kwh',isPaid:true,status:'PAID'}],invoices:[{contentId:'PRIVATE-INVOICE'}]}]}});
  });
  await f.callback(await f.begin());
  const result=await f.backend.chargingHistory('owner',7);
  assert.equal(requestUrl.pathname,'/api/1/dx/charging/history');
  assert.equal(requestUrl.searchParams.get('vin'),env.TESLA_VEHICLE_VIN);
  assert.equal(requestUrl.searchParams.get('pageNo'),'1');
  assert.equal(requestUrl.searchParams.get('pageSize'),'10');
  assert.equal(result.sessions.length,1);
  assert.equal(result.sessions[0].site_name,'Milano Supercharger');
  assert.equal(result.sessions[0].country,'IT');
  assert.equal(result.sessions[0].fees[0].currency,'EUR');
  assert.equal(result.sessions[0].fees[0].total_due,3.42);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE|sessionId|invoices/);
  assert.equal(f.calls.length,2);
  await assert.rejects(f.backend.chargingHistory('owner',32),/invalid_arguments/);
  assert.equal(f.calls.length,2,'invalid period does not use the Tesla API');
});
test('charging history accepts Tesla pagination with top-level data and totalResults', async () => {
  const f=fixture();
  f.remote(async(url)=>{
    if(url.includes('/token')) return Response.json({access_token:'fake-access',refresh_token:'fake-refresh',token_type:'Bearer',expires_in:3600,scope:'openid offline_access vehicle_device_data vehicle_charging_cmds'});
    return Response.json({data:[{siteLocationName:'Munich Supercharger',chargeStartDateTime:'2026-11-01T12:00:00Z',chargeStopDateTime:'2026-11-01T12:20:00Z'}],totalResults:1,private:'DO-NOT-RETURN'});
  });
  await f.callback(await f.begin());
  const result=await f.backend.chargingHistory('owner',7);
  assert.equal(result.sessions.length,1);
  assert.equal(result.sessions[0].site_name,'Munich Supercharger');
  assert.doesNotMatch(JSON.stringify(result),/totalResults|private|DO-NOT-RETURN/);
});
test('charging history fails closed when Tesla scope is missing', async () => {
  const f=fixture();
  await f.callback(await f.begin());
  await assert.rejects(f.backend.chargingHistory('owner'),/permission/);
  assert.equal(f.calls.length,1,'only the fake OAuth exchange occurred');
});
test('nearby Tesla charging sites are projected, bounded and location-gated', async () => {
  const f=fixture();
  let requestUrl;
  f.remote(async()=>Response.json({access_token:'fake-access',refresh_token:'fake-refresh',token_type:'Bearer',expires_in:3600,scope:'openid offline_access vehicle_device_data vehicle_location'}));
  await f.callback(await f.begin());
  const backend=createTeslaBackend({config:{...config,env:{...env,TESLA_LOCATION_ENABLED:'true'}},store:f.store,fetcher:async url=>{
    requestUrl=new URL(url);
    return Response.json({response:{congestion_sync_time_utc_secs:Date.now()/1000,superchargers:[{name:'Milano',type:'supercharger',distance_miles:1.5,available_stalls:5,total_stalls:8,site_closed:false,location:{lat:45, long:9},vin:'PRIVATE'}],destination_charging:[{name:'Hotel',distance_miles:2,location:{lat:91,long:9},private:'PRIVATE'}]}});
  }});
  const result=await backend.nearbyChargingSites('owner');
  assert.equal(result.sites.length,2);
  assert.deepEqual(result.sites[0],{kind:'supercharger',name:'Milano',type:'supercharger',distance_miles:1.5,available_stalls:5,total_stalls:8,closed:false,latitude:45,longitude:9});
  assert.equal(result.sites[1].latitude,undefined);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE|vin/);
  assert.equal(requestUrl.pathname,'/api/1/vehicles/'+env.TESLA_VEHICLE_VIN+'/nearby_charging_sites');
  assert.equal(requestUrl.searchParams.get('detail'),'true');
  assert.equal(f.calls.length,1,'only the fake OAuth exchange occurred');
  assert.doesNotMatch(requestUrl.pathname,/wake_up/);
});
test('Tesla station IDs preserve exact native provenance without guessing from addresses or unsafe integers',async()=>{
 const f=fixture();
 f.remote(async()=>Response.json({access_token:'fake-access',refresh_token:'fake-refresh',token_type:'Bearer',expires_in:3600,scope:'openid offline_access vehicle_device_data vehicle_location'}));
 await f.callback(await f.begin());
 const ids=['9223372036854775807',42,'0','1e2',Number.MAX_SAFE_INTEGER+1,'9223372036854775808',-1];
 const backend=createTeslaBackend({config:{...config,env:{...env,TESLA_LOCATION_ENABLED:'true'}},store:f.store,fetcher:async()=>Response.json({response:{superchargers:ids.map(id=>({id,name:'Synthetic station',location:{lat:45, long:9}})),destination_charging:[{id:100,name:'Synthetic AC'}]}})});
 const result=await backend.nearbyChargingSites('owner');
 assert.equal(result.sites[0].tesla_site_id,'9223372036854775807');assert.equal(result.sites[1].tesla_site_id,'42');
 assert.equal(result.sites[0].tesla_site_id_source,'TESLA_NEARBY_CHARGING_SITES');
 assert.ok(result.sites.slice(2).every(s=>s.tesla_site_id===undefined));
 assert.ok(result.sites.every(s=>!('battery_preconditioning_verified' in s))); // Identity is not an actuation receipt.
});
test('invalid optional charging details are omitted without affecting battery', async () => {
  const f=fixture(); await f.callback(await f.begin());
  f.remote(async()=>Response.json({response:{charge_state:{battery_level:62,timestamp:Date.now(),battery_range:-1,charge_limit_soc:101,charging_state:'PRIVATE'}}}));
  const result=await f.backend.battery('owner');
  assert.equal(result.battery_percent,62);
  assert.equal(result.estimated_range_miles,undefined);
  assert.equal(result.charge_limit_percent,undefined);
  assert.equal(result.charging_state,undefined);
});
test('refresh rotates exactly once and persists the new token', async () => {
  const f=fixture(); await f.callback(await f.begin()); f.advance(3600000);
  await f.backend.battery('owner');
  const form=new URLSearchParams(f.calls[1].opts.body);
  assert.equal(form.get('grant_type'),'refresh_token'); assert.equal(form.get('refresh_token'),'fake-refresh');
  assert.equal(form.has('client_secret'),false);
  assert.equal(unseal(await f.store.get(tokenKey),config.key,tokenKey).invalid,undefined);
  assert.equal(f.calls.filter(x=>x.url.includes('/token')).length,2);
});
test('failed refresh leaves persistent invalid marker and requires new consent, never reuses old refresh', async () => {
  const f=fixture(); await f.callback(await f.begin()); f.advance(3600000);
  f.remote(async()=>Response.json({ error:'login_required', refresh_token:'DO-NOT-LEAK' },{status:401}));
  await assert.rejects(f.backend.battery('owner'));
  assert.equal(unseal(await f.store.get(tokenKey),config.key,tokenKey).invalid,true);
  f.advance(61000); await assert.rejects(f.backend.battery('owner')); assert.equal(f.calls.length,2);
});
test('exhausted request budget preserves the refresh token and sends nothing to Tesla', async () => {
  const f=fixture(); await f.callback(await f.begin()); f.advance(3600000);
  const day=new Date(Date.now()+3600000).toISOString().slice(0,10);
  for(let i=0;i<10;i++) await f.store.once(`read-budget:${day}:${i}`,172800);
  await assert.rejects(f.backend.battery('owner'),/budget/);
  assert.equal(f.calls.length,1);
  assert.equal(unseal(await f.store.get(tokenKey),config.key,tokenKey).refresh,'fake-refresh');
});
test('read gate, malformed vehicle and daily ceiling block Fleet requests', async () => {
  for (const change of [{TESLA_READ_ENABLED:'false'},{TESLA_VEHICLE_VIN:'../x'},{TESLA_DAILY_READ_LIMIT:'0'},{TESLA_DAILY_READ_LIMIT:'51'}]) {
    const f=fixture(), b=createTeslaBackend({config:{...config,env:{...env,...change}},store:f.store,fetcher:async()=>{throw Error('must not call');}});
    await assert.rejects(b.battery('owner')); assert.equal(f.commands.length,0);
  }
  const now=Date.now();
  const f=fixture(Math.floor(now/86400000)*86400000-12*3600000); await f.callback(await f.begin());
  for(let i=0;i<9;i++){await f.backend.battery('owner');f.advance(61000);}
  await assert.rejects(f.backend.battery('owner')); assert.equal(f.calls.length,10);
});
test('MCP real tool rejects Tesla bearer, unknown tools and arguments before any Fleet call', async () => {
  const f=fixture(), run=realMcp({config,backend:f.backend});
  const req=(method,params,token=jwt())=>{const r=mcpRequest(method,params);const h=new Headers(r.headers);h.set('authorization','Bearer '+token);return new Request(config.audience,{method:'POST',headers:h,body:r.body,duplex:'half'});};
  const denied=await run(req('tools/list',{},'fake-tesla-token'));assert.equal(denied.status,401);assert.match(denied.headers.get('www-authenticate'),/resource_metadata/);
  const list=await (await run(req('tools/list'))).json(); assert.deepEqual(list.result.tools.map(x=>x.name),['connect_tesla','prepare_vehicle_command_setup','get_connection_status','get_vehicle_command_catalog','get_vehicle_connectivity','get_vehicle_mobile_access','get_battery','get_vehicle_status','get_live_vehicle_data','get_vehicle_reading_history','get_charging_history','get_vehicle_schedules','estimate_trip_energy','compare_charging_costs','plan_trip','get_free_to_x_card_tariffs','get_charging_preferences','set_charging_preferences']);
  for(const params of [{name:'wake_up',arguments:{}},{name:'get_battery',arguments:{vin:'x'}}]) assert.ok((await (await run(req('tools/call',params))).json()).error);
  assert.equal(f.calls.length,0);
});
test('virtual-key setup is a dedicated authenticated tool and no-read mode exposes no vehicle data',async()=>{
  let setups=0;
  const noReadConfig={...config,env:{...config.env,TESLA_READ_ENABLED:'false'}};
  const run=realMcp({config:noReadConfig,backend:{prepareVehicleCommandSetup:async()=>{setups++;return {source:'TESLA_VIRTUAL_KEY_SETUP',no_vehicle_command_sent:true};}}});
  const req=(method,params,scope)=>{const r=mcpRequest(method,params);const h=new Headers(r.headers);h.set('authorization','Bearer '+jwt({scope}));return new Request(config.audience,{method:'POST',headers:h,body:r.body,duplex:'half'});};
  const listing=await (await run(req('tools/list',{},'tesla:connect'))).json();
  assert.deepEqual(listing.result.tools.map(t=>t.name),['connect_tesla','prepare_vehicle_command_setup']);
  const call={name:'prepare_vehicle_command_setup',arguments:{}};
  assert.equal((await run(req('tools/call',call,'battery:read'))).status,401);
  assert.equal(setups,0);
  assert.equal((await run(req('tools/call',call,'tesla:connect'))).status,200);
  assert.equal(setups,1);
});
test('location discovery requires explicit gate and invocation requires its own MCP scope', async () => {
  let calls=0, sites=0, reserveSeen;
  const configWithLocation={...config,env:{...config.env,TESLA_LOCATION_ENABLED:'true',TESLA_NATIVE_COORDINATE_PILOT_ENABLED:'true',TESLA_NATIVE_COORDINATE_ENABLED:'true',TESLA_NATIVE_COORDINATE_SCHEMA:NATIVE_COORDINATE_SCHEMA}};
  const run=realMcp({config:configWithLocation,backend:{location:async(_subject,reserve)=>{calls++;reserveSeen=reserve;return {source:'TEST'};},nearbyChargingSites:async()=>{sites++;return {source:'TEST_SITES'};}}});
  const req=(method,params,scope)=>{const r=mcpRequest(method,params);const h=new Headers(r.headers);h.set('authorization','Bearer '+jwt({scope}));return new Request(config.audience,{method:'POST',headers:h,body:r.body,duplex:'half'});};
  const list=await (await run(req('tools/list',{},'battery:read'))).json();
  assert.deepEqual(list.result.tools.map(t=>t.name),['connect_tesla','prepare_vehicle_command_setup','get_connection_status','get_vehicle_command_catalog','get_vehicle_connectivity','get_vehicle_mobile_access','get_battery','get_vehicle_status','get_live_vehicle_data','get_vehicle_reading_history','get_charging_history','get_vehicle_schedules','estimate_trip_energy','compare_charging_costs','plan_trip','get_free_to_x_card_tariffs','get_charging_preferences','set_charging_preferences','resolve_frequent_waypoints','get_vehicle_location','get_live_vehicle_address','get_nearby_charging_sites','get_saved_trip_places','set_saved_trip_place','reverse_trip_location','search_trip_destination','plan_road_trip','find_charging_sites','plan_charging_road_trip','plan_smart_trip','get_planned_trip']);
  const params={name:'get_vehicle_location',arguments:{reservePercent:15}};
  const frequentCall={name:'resolve_frequent_waypoints',arguments:{destinations:['Centralville','Westville','Duomo']}};
  await assertScopeChallenge(await run(req('tools/call',frequentCall,'battery:read')),'location:read');
  const frequentResult=await (await run(req('tools/call',frequentCall,'location:read'))).json();
  assert.equal(JSON.parse(frequentResult.result.content[0].text).status,'destination_not_found');
  await assertScopeChallenge(await run(req('tools/call',params,'battery:read')),'location:read');
  assert.equal(calls,0);
  assert.equal((await run(req('tools/call',params,'location:read'))).status,200);
  assert.equal(calls,1);
  assert.equal(reserveSeen,15);
  const sitesCall={name:'get_nearby_charging_sites',arguments:{}};
  await assertScopeChallenge(await run(req('tools/call',sitesCall,'battery:read')),'location:read');
  assert.equal(sites,0);
  assert.equal((await run(req('tools/call',sitesCall,'location:read'))).status,200);
  assert.equal(sites,1);
  const noRead=realMcp({config:{...configWithLocation,env:{...configWithLocation.env,TESLA_READ_ENABLED:'false'}},backend:{}});
  const disabled=await (await noRead(req('tools/list',{},'tesla:connect'))).json();
  assert.deepEqual(disabled.result.tools.map(t=>t.name),['connect_tesla','prepare_vehicle_command_setup']);
});
test('charging history is an authenticated read-only MCP tool with validated date-window input',async()=>{
  let observed;
  const run=realMcp({config,backend:{chargingHistory:async(_subject,days)=>{observed=days;return {source:'TEST_HISTORY'};}}});
  const req=(method,params,scope)=>{const r=mcpRequest(method,params);const h=new Headers(r.headers);h.set('authorization','Bearer '+jwt({scope}));return new Request(config.audience,{method:'POST',headers:h,body:r.body,duplex:'half'});};
  const call={name:'get_charging_history',arguments:{days:14}};
  await assertScopeChallenge(await run(req('tools/call',call,'tesla:connect')),'battery:read');
  assert.equal(observed,undefined);
  const ok=await run(req('tools/call',call,'battery:read'));
  assert.equal(ok.status,200);
  assert.equal(observed,14);
});
test('vehicle schedules are an authenticated read-only MCP tool',async()=>{
  let called=0;
  const run=realMcp({config,backend:{vehicleSchedules:async()=>{called++;return {source:'TEST_SCHEDULES'};}}});
  const req=(method,params,scope)=>{const r=mcpRequest(method,params);const h=new Headers(r.headers);h.set('authorization','Bearer '+jwt({scope}));return new Request(config.audience,{method:'POST',headers:h,body:r.body,duplex:'half'});};
  const call={name:'get_vehicle_schedules',arguments:{}};
  await assertScopeChallenge(await run(req('tools/call',call,'tesla:connect')),'battery:read');
  assert.equal(called,0);
  const response=await run(req('tools/call',call,'battery:read'));
  assert.equal(response.status,200);
  assert.equal(called,1);
});
test('vehicle schedule read makes one live Tesla request and omits location and unknown fields',async()=>{
  const f=fixture();
  f.remote(async url=>url.includes('/token')
    ? Response.json({access_token:'fake-access',refresh_token:'fake-refresh',token_type:'Bearer',expires_in:3600,scope:'openid offline_access vehicle_device_data'})
    : Response.json({response:{
      charge_schedule_data:{charge_schedules:[{id:7,enabled:true,one_time:false,days_of_week:'WEEKDAYS',start_time:420,start_enabled:true,end_time:1320,end_enabled:true,latitude:45,longitude:9,secret:'PRIVATE'}]},
      preconditioning_schedule_data:{preconditioning_schedules:[{id:3,enabled:false,one_time:true,days_of_week:'MON',precondition_time:435,lat:45,lon:9,secret:'PRIVATE'}]},
      vin:'PRIVATE'
    }}));
  await f.callback(await f.begin());
  const result=await f.backend.vehicleSchedules('owner');
  assert.equal(result.source,'TESLA_SCHEDULES_LIVE');
  assert.deepEqual(result.charging,{available:true,schedules:[{id:7,enabled:true,one_time:false,days_of_week:'WEEKDAYS',start_time:420,start_enabled:true,end_time:1320,end_enabled:true}],omitted_entries:0});
  assert.deepEqual(result.preconditioning,{available:true,schedules:[{id:3,enabled:false,one_time:true,days_of_week:'MON',precondition_time:435}],omitted_entries:0});
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE|latitude|longitude|"lat"|"lon"/);
  const vehicleCalls=f.calls.filter(call=>String(call.url).includes('/vehicle_data'));
  assert.equal(vehicleCalls.length,1);
  const requestUrl=new URL(vehicleCalls[0].url);
  assert.equal(requestUrl.searchParams.get('endpoints'),'charge_schedule_data;preconditioning_schedule_data');
  assert.doesNotMatch(vehicleCalls[0].url,/wake_up/);
});
test('schedule read marks an unrecognized Tesla schedule block unavailable instead of claiming it is empty',async()=>{
  const f=fixture();
  f.remote(async url=>url.includes('/token')
    ? Response.json({access_token:'fake-access',refresh_token:'fake-refresh',token_type:'Bearer',expires_in:3600,scope:'openid offline_access vehicle_device_data'})
    : Response.json({response:{charge_schedule_data:{},preconditioning_schedule_data:{}}}));
  await f.callback(await f.begin());
  const result=await f.backend.vehicleSchedules('owner');
  assert.equal(result.charging.available,false);
  assert.equal(result.preconditioning.available,false);
  assert.deepEqual(result.charging.schedules,[]);
  assert.match(result.note,/this does not mean that no schedules are configured/);
});
test('MCP sends explicit live readings and app history to their dedicated backend handlers',async()=>{
  const observed=[];
  const run=realMcp({config,backend:{battery:async(_subject,options={})=>{observed.push(['battery',options.live===true]);return {source:options.live?'TESLA_LIVE':'TESLA_CACHED'};},vehicleReadingHistory:async(_subject,days)=>{observed.push(['history',days]);return {source:'APP_READING_HISTORY'};}}});
  const req=(method,params)=>{const r=mcpRequest(method,params);const h=new Headers(r.headers);h.set('authorization','Bearer '+jwt());return new Request(config.audience,{method:'POST',headers:h,body:r.body,duplex:'half'});};
  const live=await run(req('tools/call',{name:'get_live_vehicle_data',arguments:{}}));
  assert.equal(live.status,200);
  const history=await run(req('tools/call',{name:'get_vehicle_reading_history',arguments:{days:7}}));
  assert.equal(history.status,200);
  assert.deepEqual(observed,[['battery',true],['history',7]]);
});
test('vehicle command tools are listed only with both gates and each call requires vehicle:control', async () => {
  let prepared=0, executed=0;
  const commandConfig={...config,env:{...config.env,TESLA_COMMANDS_ENABLED:'true',TESLA_COMMAND_EXECUTION_ENABLED:'true'}};
  let directRequestId;
  const run=realMcp({config:commandConfig,backend:{prepareCommand:async(_subject,operation,args)=>{prepared++;return {operation,args};},confirmCommand:async()=>{executed++;return {accepted:true};},executeRequestedCommand:async(_subject,_operation,_args,requestId)=>{executed++;directRequestId=requestId;return {accepted:true};}}});
  const req=(method,params,scope)=>{const r=mcpRequest(method,params);const h=new Headers(r.headers);h.set('authorization','Bearer '+jwt({scope}));return new Request(config.audience,{method:'POST',headers:h,body:r.body,duplex:'half'});};
  const listed=await (await run(req('tools/list',{},'battery:read vehicle:control'))).json();
  assert.deepEqual(listed.result.tools.map(t=>t.name),['connect_tesla','prepare_vehicle_command_setup','get_connection_status','get_vehicle_command_catalog','get_vehicle_connectivity','get_vehicle_mobile_access','get_battery','get_vehicle_status','get_live_vehicle_data','get_vehicle_reading_history','get_charging_history','get_vehicle_schedules','estimate_trip_energy','compare_charging_costs','plan_trip','get_free_to_x_card_tariffs','get_charging_preferences','set_charging_preferences','prepare_vehicle_command','execute_vehicle_command','execute_requested_vehicle_command','get_vehicle_command_status']);
  const direct={name:'execute_requested_vehicle_command',arguments:{operation:'door_lock',arguments:{}}};
  assert.equal(listed.result.tools.find(t=>t.name==='execute_requested_vehicle_command').inputSchema.properties.request_id,undefined);
  await assertScopeChallenge(await run(req('tools/call',direct,'battery:read')),'vehicle:control');
  assert.equal(executed,0);
  const prepare={name:'prepare_vehicle_command',arguments:{operation:'door_lock',arguments:{}}};
  await assertScopeChallenge(await run(req('tools/call',prepare,'battery:read')),'vehicle:control');
  assert.equal(prepared,0);
  assert.equal((await run(req('tools/call',prepare,'vehicle:control'))).status,200);
  assert.equal(prepared,1);
  assert.equal(executed,0);
  assert.equal((await run(req('tools/call',direct,'vehicle:control'))).status,200);
  assert.equal(executed,1);
  assert.equal(directRequestId,1,'the backend receives the MCP JSON-RPC id for transport retry idempotency');
  const noExecution=realMcp({config:{...commandConfig,env:{...commandConfig.env,TESLA_COMMAND_EXECUTION_ENABLED:'false'}},backend:{}});
  const disabled=await (await noExecution(req('tools/list',{},'tesla:connect'))).json();
  assert.deepEqual(disabled.result.tools.map(t=>t.name),['connect_tesla','prepare_vehicle_command_setup','get_connection_status','get_vehicle_command_catalog','get_vehicle_connectivity','get_vehicle_mobile_access','get_battery','get_vehicle_status','get_live_vehicle_data','get_vehicle_reading_history','get_charging_history','get_vehicle_schedules','estimate_trip_energy','compare_charging_costs','plan_trip','get_free_to_x_card_tariffs','get_charging_preferences','set_charging_preferences']);
});
test('Supercharger command preparation exposes the exact id payload without contacting command infrastructure', async () => {
  const commandConfig={...config,env:{...config.env,TESLA_COMMANDS_ENABLED:'true',TESLA_COMMAND_EXECUTION_ENABLED:'true'}};
  const backend=new Proxy({}, {get(){throw Error('preparation must not access backend or Redis');}});
  const run=realMcp({config:commandConfig,backend});
  const req=(method,params,scope='vehicle:control')=>{const r=mcpRequest(method,params);const h=new Headers(r.headers);h.set('authorization','Bearer '+jwt({scope}));return new Request(config.audience,{method:'POST',headers:h,body:r.body,duplex:'half'});};
  const listed=await (await run(req('tools/list',{},'battery:read vehicle:control'))).json();
  const prepareSchema=listed.result.tools.find(t=>t.name==='prepare_vehicle_command').inputSchema;
  assert.ok(prepareSchema.properties.operation.enum.includes('navigation_sc_request'));
  assert.equal(prepareSchema.anyOf[0].properties.arguments.properties.id.type,'integer');
  assert.equal(prepareSchema.anyOf[0].properties.arguments.properties.id.minimum,1);
  const executeSchema=listed.result.tools.find(t=>t.name==='execute_requested_vehicle_command').inputSchema;
  assert.ok(!executeSchema.properties.operation.enum.includes('navigation_sc_request'),'the send tool remains blocked');
  const response=await run(req('tools/call',{name:'prepare_vehicle_command',arguments:{operation:'navigation_sc_request',arguments:{id:9994}}}));
  const body=await response.json();
  assert.equal(body.result.isError,false);
  const preview=JSON.parse(body.result.content[0].text);
  assert.equal(preview.status,'payload_prepared_not_executable');
  assert.equal(preview.operation,'navigation_sc_request');
  assert.deepEqual(preview.payload,{id:9994});
  assert.equal(preview.dispatch_performed,false);
  assert.equal(preview.sent_to_vehicle,false);
  assert.equal(preview.wake_up_performed,false);
  assert.equal(preview.proxy_called,false);
  assert.equal(preview.tesla_api_called,false);
  assert.equal(preview.redis_called,false);
  assert.equal(preview.signature_generated,false);
  assert.equal(preview.ticket_created,false);
  assert.equal(preview.telemetry_observed,false);
  assert.equal(preview.telemetry_field_availability_for_vin,'not_verified');
  assert.ok(Object.hasOwn(preview.telemetry_expectations,'PreconditioningEnabled'));
  assert.ok(Object.hasOwn(preview.telemetry_expectations,'BatteryHeaterOn'));
  assert.ok(Object.hasOwn(preview.telemetry_expectations,'DestinationName'));
  assert.ok(Object.hasOwn(preview.telemetry_expectations,'DestinationLocation'));
  await assertScopeChallenge(await run(req('tools/call',{name:'prepare_vehicle_command',arguments:{operation:'navigation_sc_request',arguments:{id:9994}}},'battery:read')),'vehicle:control');
  for (const args of [{}, {id:'9994'}, {id:0}, {id:-1}, {id:9994.5}, {id:Number.MAX_SAFE_INTEGER+1}, {id:9994,site_id:'30350'}]) {
    const invalid=await run(req('tools/call',{name:'prepare_vehicle_command',arguments:{operation:'navigation_sc_request',arguments:args}}));
    assert.equal((await invalid.json()).error.code,-32602,'invalid Supercharger payload is rejected before backend access');
  }
});
test('waypoint prepare and execution schemas expose the ordered coordinate string and reject malformed lists', async () => {
  const commandConfig={...config,env:{...config.env,TESLA_COMMANDS_ENABLED:'true',TESLA_COMMAND_EXECUTION_ENABLED:'true'}};
  const calls=[];
  const run=realMcp({config:commandConfig,backend:{
    prepareCommand:async(_subject,operation,args)=>{calls.push(['prepare',operation,args]);return {operation,args,confirmation_required:true};},
    executeRequestedCommand:async(_subject,operation,args)=>{calls.push(['execute',operation,args]);return {status:'invocation_ready',sent_to_vehicle:false,dispatch_performed:false};}
  }});
  const req=(method,params)=>{const r=mcpRequest(method,params);const h=new Headers(r.headers);h.set('authorization','Bearer '+jwt({scope:'vehicle:control'}));return new Request(config.audience,{method:'POST',headers:h,body:r.body,duplex:'half'});};
  const listed=await (await run(req('tools/list',{}))).json();
  const prepareSchema=listed.result.tools.find(t=>t.name==='prepare_vehicle_command').inputSchema;
  const prepareWaypoints=prepareSchema.anyOf.find(branch=>branch.properties?.operation?.const==='navigation_waypoints_request');
  assert.ok(prepareWaypoints);
  assert.equal(prepareWaypoints.properties.arguments.properties.waypoints.type,'string');
  const preparePatterns=prepareWaypoints.properties.arguments.properties.waypoints.anyOf.map(pattern=>new RegExp(pattern.pattern));
  const arguments_={waypoints:'45.5499106,9.0782851;45.5497740,9.3437490;45.4641669,9.1916121'};
  assert.ok(preparePatterns.some(pattern=>pattern.test(arguments_.waypoints)));
  assert.ok(!preparePatterns.some(pattern=>pattern.test('45.4642,9.1900')));
  const executeSchema=listed.result.tools.find(t=>t.name==='execute_requested_vehicle_command').inputSchema;
  const executeWaypoints=executeSchema.anyOf.find(branch=>branch.properties?.operation?.const==='navigation_waypoints_request');
  assert.ok(executeWaypoints);
  assert.equal(executeWaypoints.properties.arguments.properties.waypoints.type,'string');
  assert.equal(executeWaypoints.properties.arguments.properties._tesla_invocation_token.type,'string');
  const prepared=await run(req('tools/call',{name:'prepare_vehicle_command',arguments:{operation:'navigation_waypoints_request',arguments:arguments_}}));
  assert.equal((await prepared.json()).result.isError,false);
  assert.deepEqual(calls[0],['prepare','navigation_waypoints_request',arguments_]);
  const ready=await run(req('tools/call',{name:'execute_requested_vehicle_command',arguments:{operation:'navigation_waypoints_request',arguments:arguments_}}));
  const readyBody=await ready.json();
  assert.equal(readyBody.result.isError,false);
  assert.deepEqual(calls[1],['execute','navigation_waypoints_request',arguments_]);
  assert.equal(calls.length,2);
  assert.equal(readyBody.result.content.length,1);
});
test('coordinate waypoint preparation propagates its gate through authorization and direct preflight without dispatch', async () => {
  const f=fixture();
  const tx=await f.begin();
  f.remote(async url=>url.includes('/token')
    ? Response.json({access_token:'fake-access',refresh_token:'fake-refresh',token_type:'Bearer',expires_in:3600,scope:'openid offline_access vehicle_device_data vehicle_cmds'})
    : Response.json({response:{}}));
  assert.equal((await f.callback(tx)).status,200);
  const commandConfig=configuration({...env,APP_ORIGIN:TESLA_P256_ORIGIN,VERCEL_ENV:'production',
    TESLA_COMMANDS_ENABLED:'true',TESLA_COMMAND_EXECUTION_ENABLED:'true',TESLA_REAL_RELEASE_APPROVED:'true',
    TESLA_NATIVE_COORDINATE_PILOT_ENABLED:'true',TESLA_NATIVE_COORDINATE_ENABLED:'true',TESLA_NATIVE_COORDINATE_SCHEMA:NATIVE_COORDINATE_SCHEMA});
  let dispatches=0;
  const backend=createTeslaBackend({config:commandConfig,store:f.store,now:f.now,fetcher:async()=>{dispatches++;throw Error('dispatch must not run in preparation');}});
  await backend.prepareVehicleCommandSetup('owner');
  const args={waypoints:'45.5499106,9.0782851;45.5497740,9.3437490;45.4641669,9.1916121'};
  const prepared=await backend.prepareCommand('owner','navigation_waypoints_request',args);
  assert.equal(prepared.operation,'navigation_waypoints_request');
  assert.deepEqual(prepared.args,args);
  assert.equal(prepared.execution_enabled,true);
  assert.equal(prepared.confirmation_required,true);
  const direct=await backend.executeRequestedCommand('owner','navigation_waypoints_request',args,'waypoint-preflight',{token:undefined});
  assert.equal(direct.status,'invocation_ready');
  assert.equal(direct.sent_to_vehicle,false);
  assert.equal(direct.dispatch_performed,false);
  for(const invalid of ['45.4642,9.1900','91,9;45,10','45,9;46,10;']) {
    await assert.rejects(backend.prepareCommand('owner','navigation_waypoints_request',{waypoints:invalid}),/invalid_arguments/);
    await assert.rejects(backend.executeRequestedCommand('owner','navigation_waypoints_request',{waypoints:invalid},'invalid-waypoints',{token:undefined}),/invalid_arguments/);
  }
  assert.equal(dispatches,0);
});
test('Supercharger preparation schema preserves zero IDs in existing schedule preparation', async () => {
  const commandConfig={...config,env:{...config.env,TESLA_COMMANDS_ENABLED:'true',TESLA_COMMAND_EXECUTION_ENABLED:'true'}};
  let seen;
  const run=realMcp({config:commandConfig,backend:{prepareCommand:async(_subject,operation,args)=>{seen={operation,args};return {prepared:true};}}});
  const r=mcpRequest('tools/call',{name:'prepare_vehicle_command',arguments:{operation:'remove_charge_schedule',arguments:{id:0}}});
  const h=new Headers(r.headers);h.set('authorization','Bearer '+jwt({scope:'vehicle:control'}));
  const response=await run(new Request(config.audience,{method:'POST',headers:h,body:r.body,duplex:'half'}));
  assert.equal((await response.json()).result.isError,false);
  assert.deepEqual(seen,{operation:'remove_charge_schedule',args:{id:0}});
});
test('upstream failures and invalid battery are sanitized; no live fallback or retry', async () => {
  const f=fixture(); await f.callback(await f.begin());
  f.remote(async()=>Response.json({response:{charge_state:{battery_level:101,timestamp:Date.now()}}}));
  await assert.rejects(f.backend.battery('owner')); assert.equal(f.calls.length,2);
  await assert.rejects(jsonFetch(async()=>Response.json({secret:'PRIVATE'},{status:500}),'https://fake.invalid'),e=>!e.message.includes('PRIVATE'));
});
test('a persistence failure after refresh leaves old credentials unusable', async () => {
  const f=fixture(); await f.callback(await f.begin()); f.advance(3600000);
  const original=f.store.lock;
  f.store.lock=async key=>{const lease=await original(key);let saves=0;return {...lease,save:async(...args)=>{if(++saves===2)throw Error('fake-storage-failure');return lease.save(...args);}};};
  await assert.rejects(f.backend.battery('owner'));
  assert.equal(unseal(await f.store.get(tokenKey),config.key,tokenKey).invalid,true);
  assert.equal(f.calls.filter(x=>x.url.includes('/token')).length,2);
  f.advance(61000);await assert.rejects(f.backend.battery('owner'));
  assert.equal(f.calls.filter(x=>x.url.includes('/token')).length,2);
});
test('two backend instances cannot refresh while a lease is held', async () => {
  const f=fixture();await f.callback(await f.begin());f.advance(3600000);
  const lease=await f.store.lock(tokenKey);
  const other=createTeslaBackend({config,store:f.store,fetcher:async()=>{throw Error('unexpected network');}});
  await assert.rejects(other.battery('owner'));
  assert.equal(f.calls.length,1);await lease.release();
});

test('live vehicle-data failures stop without cache fallback, wake or retry', async () => {
  for (const [status, code] of [[408, 'vehicle_unavailable'], [404, 'upstream'], [412, 'upstream']]) {
    const f = fixture();
    await f.callback(await f.begin());
    f.remote(async url => {
      assert.match(url, /\/vehicle_data\?/);
      return Response.json({ error: 'PRIVATE_UPSTREAM_BODY' }, { status });
    });
    await assert.rejects(f.backend.battery('owner',{live:true}), e => e.message === code);
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls.filter(x => /wake_up|vehicle_data_cached/.test(x.url)).length, 0);
    assert.equal(f.calls.filter(x => /\/vehicle_data\?/.test(x.url)).length, 1);
  }
});
test('MCP reports a safe live-unavailable message without cache fallback or retry', async () => {
  let calls = 0;
  const run = realMcp({ config, backend: { battery: async () => { calls++; throw Error('vehicle_unavailable'); } } });
  const r = mcpRequest('tools/call', { name: 'get_live_vehicle_data', arguments: {} });
  const h = new Headers(r.headers);
  h.set('authorization', 'Bearer ' + jwt());
  const response = await run(new Request(config.audience, { method: 'POST', headers: h, body: r.body, duplex: 'half' }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.id,1);
  assert.equal(body.result.isError,true);
  const failure=JSON.parse(body.result.content[0].text);
  assert.equal(failure.error.code,'vehicle_unavailable');
  assert.match(failure.error.message, /The operation outcome cannot be confirmed/);
  assert.match(failure.error.message, /explicitly request one wake_up command/);
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE_UPSTREAM_BODY|vin|refresh_token|Bearer /i);
  assert.equal(calls, 1);
});

test('Production live read ignores the legacy fifty cap and meters requests beyond it', async () => {
  const f = fixture(Date.UTC(2026, 10, 2, 12));
  assert.equal((await f.callback(await f.begin())).status, 200);
  for (let slot = 1; slot < 49; slot++)
    await f.store.once(`read-budget:2026-11-02:${slot}`, 172800);
  const productionConfig = configuration({ ...env,
    APP_ORIGIN: 'https://mcp.example.invalid',
    VERCEL_ENV: 'production',
    TESLA_DAILY_READ_LIMIT: '50' });
  let reads = 0;
  const backend = createTeslaBackend({ config: productionConfig, store: f.store, now: f.now,
    fetcher: async url => {
      assert.equal(new URL(url).pathname, '/api/1/vehicles/' + env.TESLA_VEHICLE_VIN + '/vehicle_data');
      reads++;
      return Response.json({ response: { charge_state: { battery_level: 71, timestamp: f.now() - 1000 } } });
    } });
  const before = (await backend.connectionStatus('owner', { includeReadReadiness: true })).live_vehicle_data_readiness;
  assert.equal(before.budget.limit, null);
  assert.equal(before.budget.unlimited, true);
  assert.equal(before.budget.reserved, 49);
  assert.equal(before.budget.remaining, null);
  assert.equal((await backend.battery('owner', { live: true })).battery_percent, 71);
  const after = (await backend.connectionStatus('owner', { includeReadReadiness: true })).live_vehicle_data_readiness;
  assert.equal(after.budget.limit, null);
  assert.equal(after.budget.reserved, 50);
  assert.equal(after.budget.remaining, null);
  assert.equal(after.ready, true);
  f.advance(61000);
  await backend.battery('owner', { live: true });
  assert.equal(reads, 2);
  const metered = (await backend.connectionStatus('owner', { includeReadReadiness: true })).live_vehicle_data_readiness;
  assert.equal(metered.budget.reserved, 51);
  assert.equal(metered.ready, true);
});

test('Redis atomic reservation counts sparse legacy slots before any live request', async () => {
  const f = fixture(Date.UTC(2026, 10, 2, 12));
  assert.equal((await f.callback(await f.begin())).status, 200);
  for (let slot = 30; slot < 39; slot++) await f.store.once(`read-budget:2026-11-02:${slot}`, 172800);
  const before = f.calls.length;
  await assert.rejects(f.backend.battery('owner', {live:true}), /budget/);
  assert.equal(f.calls.length, before);
  assert.ok(f.commands.some(args => args[0] === 'EVAL' && args[2] === 50));
});

test('road route executes through authenticated MCP without any Tesla backend call', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let maps = 0;
  globalThis.fetch = async url => {
    assert.equal(new URL(url).hostname, 'router.project-osrm.org'); maps++;
    return Response.json({code:'Ok',routes:[{distance:200000,duration:9000,legs:[{distance:100000,duration:4500},{distance:100000,duration:4500}]}]});
  };
  const run = realMcp({config:{...config,env:{...env,TESLA_LOCATION_ENABLED:'true'}},backend:new Proxy({}, {get(){assert.fail('Tesla backend invoked');}})});
  const args = {origin:{lat:45,lon:9},destination:{lat:46,lon:10},roundTrip:true,batteryPercent:50,usableCapacityKwh:50,consumptionKwhPer100Km:20,reservePercent:10,externalMapsConsent:true,efficiencyPercent:100,chargingOptions:[null,{label:'listed stop',eurPerKwh:0.1,fixedFeeEur:0}]};
  const req = mcpRequest('tools/call',{name:'plan_road_trip',arguments:args});
  const h = new Headers(req.headers); h.set('authorization','Bearer '+jwt({scope:'location:read'}));
  const response = await run(new Request(config.audience,{method:'POST',headers:h,body:req.body,duplex:'half'}));
  const body = await response.json(); assert.equal(body.result.isError,false);
  const result = JSON.parse(body.result.content[0].text);
  assert.equal(result.distance_km,200); assert.equal(result.charging_plan.feasible,true);
  assert.equal(result.charging_plan.estimated_total_eur,2); assert.equal(maps,1);
});

test('MCP map consent, array bounds and nullable tariff schemas reject invalid input before providers', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => assert.fail('provider called for invalid input');
  const run = realMcp({config:{...config,env:{...env,TESLA_LOCATION_ENABLED:'true'}},backend:{}});
  const valid = {origin:{lat:45,lon:9},destination:{lat:46,lon:10},roundTrip:true,batteryPercent:50,usableCapacityKwh:50,consumptionKwhPer100Km:20,reservePercent:10,externalMapsConsent:true};
  for (const arguments_ of [{...valid,externalMapsConsent:false},{...valid,stops:Array(9).fill(valid.origin)},{...valid,chargingOptions:['bad']},{...valid,chargingOptions:[null,{label:'bad',eurPerKwh:-1,fixedFeeEur:0}]}]) {
    const req = mcpRequest('tools/call',{name:'plan_road_trip',arguments:arguments_});
    const h = new Headers(req.headers); h.set('authorization','Bearer '+jwt({scope:'location:read'}));
    const response = await run(new Request(config.audience,{method:'POST',headers:h,body:req.body,duplex:'half'}));
    assert.equal((await response.json()).error.code,-32602);
  }
});

test('live battery and GPS reads can repeat immediately without application cooldown', async () => {
  const f=fixture();
  f.remote(async()=>Response.json({access_token:'fake-access',refresh_token:'fake-refresh',token_type:'Bearer',expires_in:3600,scope:'openid offline_access vehicle_device_data vehicle_location'}));
  await f.callback(await f.begin());
  const backend = createTeslaBackend({config:{...config,env:{...env,TESLA_LOCATION_ENABLED:'true'}},store:f.store,now:f.now,fetcher:async url=> {
    return String(url).includes('location_data') ? Response.json({response:{drive_state:{latitude:45,longitude:9,timestamp:f.now()-2000}}}) : Response.json({response:{charge_state:{battery_level:71,timestamp:f.now()}}});
  }});
  for(let i=0;i<3;i++) {
    assert.equal((await backend.battery('owner',{live:true})).battery_percent,71);
    assert.equal((await backend.location('owner')).data_age_seconds,2);
  }
  assert.equal(await f.store.get('read-cooldown'),null);
  const status=await backend.connectionStatus('owner',{includeReadReadiness:true});
  assert.equal(status.live_vehicle_data_readiness.budget.reserved,7);
});

test('live address MCP uses one GPS read, no coordinates in result, and never repeats GPS after map failure', async t => {
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  let gps=0, maps=0;
  const backend={location:async()=>{gps++;return {source:'TESLA_LIVE',latitude:45,longitude:9,observed_at:'2026-11-03T00:00:00Z',data_age_seconds:2};}};
  const run=realMcp({config:{...config,env:{...env,TESLA_LOCATION_ENABLED:'true'}},backend});
  const call=async(scope,consent)=>{
    const r=mcpRequest('tools/call',{name:'get_live_vehicle_address',arguments:{externalMapsConsent:consent}});
    const h=new Headers(r.headers);h.set('authorization','Bearer '+jwt({scope}));
    return run(new Request(config.audience,{method:'POST',headers:h,body:r.body,duplex:'half'}));
  };
  await assertScopeChallenge(await call('battery:read',true),'location:read');
  assert.equal(gps,0);
  await call('location:read',false);assert.equal(gps,0);
  globalThis.fetch=async()=>{maps++;return Response.json({features:[{geometry:{coordinates:[9,45]},properties:{street:'Via Roma',city:'Milano'}}]});};
  const result=JSON.parse((await (await call('location:read',true)).json()).result.content[0].text);
  assert.equal(result.spoken_address,'Via Roma, Milano');assert.equal(result.data_age_seconds,2);
  assert.equal(gps,1);assert.equal(maps,1);assert.doesNotMatch(JSON.stringify(result),/latitude|longitude|coordinates/);
  globalThis.fetch=async()=>{maps++;throw Error('unavailable');};
  const failure=JSON.parse((await (await call('location:read',true)).json()).result.content[0].text);
  assert.equal(failure.address_available,false);assert.equal(failure.tesla_read_repeated,false);
  assert.equal(gps,2);assert.equal(maps,2);
});

test('public tariff and charging route tools execute through MCP with least-privilege scopes and no Tesla backend',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let calls=0;
  globalThis.fetch=async url=>{calls++;
    if(new URL(url).hostname==='freeto-x.it')return new Response('<h2>Costi di ricarica con carta alle stazioni Free To X</h2>Corrente Alternata €0,50/kWh Corrente Continua €0,65/kWh Ricarica ad Alta Potenza €0,79/kWh Quanto costa ricaricare');
    assert.equal(new URL(url).hostname,'router.project-osrm.org');
    return Response.json({code:'Ok',routes:[{distance:100000,duration:9000,legs:[{distance:50000,duration:4500},{distance:50000,duration:4500}]}]});
  };
  const run=realMcp({config:{...config,env:{...env,TESLA_LOCATION_ENABLED:'true'}},backend:new Proxy({}, {get(){assert.fail('Tesla backend');}})});
  const invoke=async(name,args,scope)=>{const r=mcpRequest('tools/call',{name,arguments:args});const h=new Headers(r.headers);h.set('authorization','Bearer '+jwt({scope}));return run(new Request(config.audience,{method:'POST',headers:h,body:r.body,duplex:'half'}));};
  await assertScopeChallenge(await invoke('get_free_to_x_card_tariffs',{},'location:read'),'battery:read');
  const tariff=JSON.parse((await (await invoke('get_free_to_x_card_tariffs',{},'battery:read')).json()).result.content[0].text);
  assert.equal(tariff.payment_method,'direct_card_POS');assert.equal(tariff.tariffs.length,3);
  const args={origin:{lat:45,lon:9},destination:{lat:46,lon:10},roundTrip:true,batteryPercent:100,usableCapacityKwh:50,consumptionKwhPer100Km:20,reservePercent:10,chargingTargetPercent:80,maxChargingStops:4,externalMapsConsent:true};
  await assertScopeChallenge(await invoke('plan_charging_road_trip',args,'battery:read'),'location:read');
  const route=JSON.parse((await (await invoke('plan_charging_road_trip',args,'location:read')).json()).result.content[0].text);
  assert.equal(route.charging_plan.feasible,true);assert.equal(route.sent_to_vehicle,false);assert.equal(calls,2);
});

test('nearby failures log only HTTP status and a generic error class/message', async () => {
  const scenarios = [
    {
      status: 503,
      fetcher: async () => Response.json({ token: 'DO_NOT_LOG', coordinates: 'DO_NOT_LOG', body: 'DO_NOT_LOG' }, { status: 503 }),
      expected: { http_status: 503, error_class: 'http_error', message: 'Tesla returned an HTTP error.' }
    },
    {
      status: 200,
      fetcher: async () => new Response('DO_NOT_LOG raw upstream body'),
      expected: { http_status: 200, error_class: 'invalid_response', message: 'The provider response is unusable.' }
    },
    {
      status: null,
      fetcher: async () => { const error = Error('DO_NOT_LOG token coordinates'); error.name = 'TimeoutError'; throw error; },
      expected: { http_status: null, error_class: 'timeout', message: 'The Tesla request timed out.' }
    }
  ];
  for (const scenario of scenarios) {
    const f = fixture();
    const tx = await f.begin();
    f.remote(async () => Response.json({
      access_token: 'fake-access', refresh_token: 'fake-refresh',
      token_type: 'Bearer', expires_in: 3600,
      scope: 'openid offline_access vehicle_device_data vehicle_location'
    }));
    assert.equal((await f.callback(tx)).status, 200);
    const events = [];
    const backend = createTeslaBackend({
      config: { ...config, env: { ...env, TESLA_LOCATION_ENABLED: 'true' } },
      store: f.store,
      fetcher: scenario.fetcher,
      logger: { error: (event, payload) => events.push({ event, payload }) }
    });
    await assert.rejects(() => backend.nearbyChargingSites('owner'));
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'TESLA_NEARBY_DIAGNOSTIC');
    assert.deepEqual(JSON.parse(events[0].payload), scenario.expected);
    assert.doesNotMatch(JSON.stringify(events), /DO_NOT_LOG|fake-access|fake-refresh|latitude|longitude/i);
  }
});
