import { generateKeyPairSync, sign } from 'node:crypto';
import { configuration } from '../lib/security.mjs';
import { persistentStore } from '../lib/store.mjs';
import { createTeslaBackend } from '../lib/tesla.mjs';
import { realMcp } from '../lib/real-mcp.mjs';
import { request } from '../offline-request.mjs';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength:2048 });
const jwk={...publicKey.export({format:'jwk'}),kid:'status-fixture',alg:'RS256'};
export function statusFixture(db, implementations = {}, overrides = {}) {
  const env={APP_ORIGIN:'https://example.invalid',MCP_AUTH_ISSUER:'https://issuer.invalid/',MCP_AUTH_JWKS:JSON.stringify({keys:[jwk]}),MCP_ALLOWED_SUBJECT:'owner',
    TOKEN_ENCRYPTION_KEY_BASE64:Buffer.alloc(32,7).toString('base64'),TESLA_CLIENT_ID:'fixture',TESLA_CLIENT_SECRET:'fixture',
    TESLA_FLEET_REGION:'eu',TESLA_BACKEND_ENABLED:'true',TESLA_READ_ENABLED:'true',TESLA_COMMANDS_ENABLED:'true',TESLA_COMMAND_EXECUTION_ENABLED:'true',
    TESLA_VEHICLE_VIN:'5YJ3E1EA0LF000000',TOKEN_STORE_REST_URL:'https://redis.fixture.invalid/',TOKEN_STORE_REST_TOKEN:'fixture-store',...overrides};
  const config=configuration(env),store=(implementations.persistentStore??persistentStore)(env,db.fetcher);
  let teslaCalls=0;
  const backend=(implementations.createTeslaBackend??createTeslaBackend)({config,store,fetcher:()=>{teslaCalls++;throw Error('Unexpected Tesla access');}});
  const handler=(implementations.realMcp??realMcp)({config,backend});
  const rpc=async(args,{legacy=false,scope='vehicle:control',name='get_vehicle_command_status'}={})=>{
    const now=Math.floor(Date.now()/1000),h=Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT',kid:jwk.kid})).toString('base64url');
    const p=Buffer.from(JSON.stringify({iss:config.issuer,aud:config.audience,sub:'owner',scope,iat:now-1,exp:now+600})).toString('base64url');
    const token=h+'.'+p+'.'+sign('RSA-SHA256',Buffer.from(h+'.'+p),privateKey).toString('base64url');
    const params={name,arguments:args};
    const req=legacy?new Request(config.audience,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:'status-read',method:'tools/call',params})}):request('tools/call',params,{authorization:'Bearer '+token},config.audience);
    const response=await handler(req),body=await response.json();
    return {response,body,result:body.result?JSON.parse(body.result.content[0].text):null};
  };
  return {env,config,store,backend,rpc,teslaCalls:()=>teslaCalls};
}
