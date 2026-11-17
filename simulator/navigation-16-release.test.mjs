import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { realMcp } from './lib/real-mcp.mjs';
import { tripNavigation } from './lib/trip-navigation.mjs';
import { request } from './offline-request.mjs';
import { TESLA_P256_ORIGIN } from './lib/partner-p256-identity.mjs';
import { GPS_ROUTE_ORDER_SCHEMA } from './lib/gps-route-activation.mjs';

const names=Array.from({length:16},(_,i)=>'Waypoint '+String(i+1));
const positions=names.map((_,i)=>({lat:45+i/100,lon:9+i/100}));

test('16 OSM waypoints pass saved navigation handoff without vehicle dispatch',async()=>{
 const db=new Map(),store={put:async(k,v)=>db.set(k,v),get:async k=>db.get(k)??null};
 const config={issuer:'offline-fixture',key:Buffer.alloc(32,17),origin:TESLA_P256_ORIGIN,env:{
  VERCEL_ENV:'production',TESLA_FLEET_REGION:'eu',TESLA_BACKEND_ENABLED:'true',TESLA_READ_ENABLED:'true',
  TESLA_COMMANDS_ENABLED:'true',TESLA_COMMAND_EXECUTION_ENABLED:'true',TESLA_REAL_RELEASE_APPROVED:'true',
  TESLA_GPS_ROUTE_CANDIDATE_ENABLED:'true',TESLA_GPS_ROUTE_ORDER_SCHEMA:GPS_ROUTE_ORDER_SCHEMA
 }};
 const plans=tripNavigation({store,config});
 const record=count=>({navigation_only:true,requires_verified_waypoint_identity:true,
  destinations:positions.slice(0,count),
  place_evidence:positions.slice(0,count).map((_,i)=>({source:'PHOTON_OSM',coordinate_status:'unique_public_map_match_not_user_confirmed',osm_id:i+101,osm_type:'node',source_url:'https://www.openstreetmap.org/node/'+(i+101)})),
  resolved_route:{stops:names.slice(0,count-1),destination:names[count-1]}})
 const sixteen=await plans.save('owner',record(16));
 assert.equal(sixteen.multi_stop_candidate_available,true);
 const saved=await plans.get('owner',sixteen.id);
 assert.equal(saved.multi_stop_navigation_handoff.available,true);
 assert.equal(saved.multi_stop_navigation_handoff.command_request.operation,'navigation_gps_request');
 assert.deepEqual(saved.multi_stop_navigation_handoff.command_request.arguments.points,positions);
 assert.equal(saved.multi_stop_navigation_handoff.api_actuation_count,16);
 assert.equal(saved.multi_stop_navigation_handoff.automatic_dispatch,false);
});

test('MCP Google resolver prepares 16 place IDs in order without contacting Tesla',async()=>{
 const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
 const jwk={...publicKey.export({format:'jwk'}),kid:'offline-key',use:'sig',alg:'RS256'};
 const config={origin:TESLA_P256_ORIGIN,issuer:'https://issuer.example/',audience:TESLA_P256_ORIGIN+'/mcp',
  jwks:{keys:[jwk]},env:{VERCEL_ENV:'production',MCP_ALLOWED_SUBJECT:'offline',TESLA_FLEET_REGION:'eu',
  TESLA_READ_ENABLED:'true',TESLA_LOCATION_ENABLED:'true',TESLA_BACKEND_ENABLED:'true',
  TESLA_COMMANDS_ENABLED:'true',TESLA_COMMAND_EXECUTION_ENABLED:'true',TESLA_REAL_RELEASE_APPROVED:'true',
  TESLA_NATIVE_WAYPOINTS_ENABLED:'true',GOOGLE_PLACES_SEARCH_ENABLED:'true',GOOGLE_PLACES_API_KEY:'fixture-key'}};
 let providerCalls=0,proofs=0;
 const backend={savedTripPlaces:{get:async()=>({places:{}})},destinationCache:{
  resolve:async(_subject,_query,load)=>({result:await load(),cache_hit:false}),
  reserveGooglePlacesRequest:async()=>true,
  attestGooglePlaceIds:async()=>{proofs++;return 1;}}};
 const handler=realMcp({config,backend});
 const t=Math.floor(Date.now()/1000);
 const head=Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT',kid:jwk.kid})).toString('base64url');
 const payload=Buffer.from(JSON.stringify({iss:config.issuer,aud:config.audience,sub:'offline',
  iat:t-1,exp:t+600,scope:'battery:read location:read'})).toString('base64url');
 const token=head+'.'+payload+'.'+sign('RSA-SHA256',Buffer.from(head+'.'+payload),privateKey).toString('base64url');
 const priorFetch=globalThis.fetch;
 globalThis.fetch=async(_url,init)=>{
  providerCalls++;const query=JSON.parse(init.body).textQuery;
  const i=names.indexOf(query);
  return Response.json({places:[{id:'GoogleMockPlace'+String(i).padStart(3,'0'),displayName:{text:query},formattedAddress:query+', Italia'}]});
 };
 try {
  const rejected=await handler(request('tools/call',{name:'plan_smart_trip',arguments:{
   navigationOnly:false,externalMapsConsent:true,stops:names.slice(0,9),destination:names.at(9)
  }},{authorization:'Bearer '+token},config.origin+'/mcp'));
  const rejectedBody=await rejected.json();
  assert.equal(rejectedBody.error?.code,-32602);
  assert.equal(providerCalls,0);
  assert.equal(proofs,0);
  const result=await handler(request('tools/call',{name:'plan_smart_trip',arguments:{
   navigationOnly:true,externalMapsConsent:true,stops:names.slice(0,-1),destination:names.at(-1)
  }},{authorization:'Bearer '+token},config.origin+'/mcp'));
  assert.equal(result.status,200);
  const response=await result.json();
  const body=JSON.parse(response.result.content[0].text);
  assert.equal(body.status,'payload_ready');
  assert.equal(body.resolver_priority,'GOOGLE_PLACES');
  assert.equal(body.command_request.operation,'navigation_waypoints_request');
  const ids=body.command_request.arguments.waypoints.split(',');
  assert.equal(ids.length,16);
  assert.deepEqual(ids,names.map((_,i)=>'refId:GoogleMockPlace'+String(i).padStart(3,'0')));
  assert.equal(providerCalls,16);
  assert.equal(proofs,16);
  assert.equal(body.sent_to_vehicle,false);
  assert.equal(body.automatic_dispatch,false);
 }finally{globalThis.fetch=priorFetch;}
});
