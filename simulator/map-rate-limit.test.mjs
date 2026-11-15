import test from 'node:test';
import assert from 'node:assert/strict';
import { GOOGLE_PLACES_DAILY_REQUEST_LIMIT, persistentStore } from './lib/store.mjs';

test('Nominatim limiter uses an atomic Redis lease and compare-owner release',async()=>{
 const calls=[];
 const store=persistentStore({TOKEN_STORE_REST_URL:'https://redis.example.test/',TOKEN_STORE_REST_TOKEN:'fixture'},async(url,init)=>{
  assert.equal(url,'https://redis.example.test/');
  calls.push(JSON.parse(init.body));
  return Response.json({result:0});
 });
 const lease=await store.acquirePublicGeocoderLease({provider:'nominatim',intervalMs:1000});
 await lease.release();
 assert.equal(calls.length,2);assert.equal(calls[0][0],'EVAL');assert.equal(calls[0][2],2);
 assert.match(calls[0][3],/public-geocoder:nominatim:lock$/);assert.match(calls[0][4],/public-geocoder:nominatim:next$/);
 assert.match(calls[0][1],/redis.call\('TIME'\)/);assert.match(calls[0][1],/redis.call\('SET'/);
 assert.match(calls[1][1],/redis.call\('GET',KEYS\[1\]\)==ARGV\[1\]/);
 assert.doesNotMatch(JSON.stringify(calls),/TESLA|read-budget/);
});

test('public geocoder limiter rejects unbounded or too-fast intervals before touching Redis',async()=>{
 let calls=0;const store=persistentStore({TOKEN_STORE_REST_URL:'https://redis.example.test/',TOKEN_STORE_REST_TOKEN:'fixture'},async()=>{calls++;return Response.json({result:0});});
 await assert.rejects(store.acquirePublicGeocoderLease({provider:'other'}),/invalid_arguments/);
 await assert.rejects(store.acquirePublicGeocoderLease({intervalMs:999}),/invalid_arguments/);
 assert.equal(calls,0);
});

test('Google Places reservation uses one atomic, separate 20-request UTC budget',async()=>{
 const calls=[];
 const store=persistentStore({TOKEN_STORE_REST_URL:'https://redis.example.test/',TOKEN_STORE_REST_TOKEN:'fixture'},async(url,init)=>{
  calls.push(JSON.parse(init.body));return Response.json({result:1});
 });
 assert.equal(await store.reserveGooglePlacesRequest('2026-11-08'),true);
 assert.equal(calls.length,1);
 const [operation,script,keyCount,key,limit,ttl]=calls[0];
 assert.equal(operation,'EVAL');assert.equal(keyCount,1);
 assert.match(key,/google-places-budget:2026-11-08$/);
 assert.equal(limit,GOOGLE_PLACES_DAILY_REQUEST_LIMIT);assert.equal(limit,20);assert.equal(ttl,172800);
 assert.match(script,/redis.call\('INCR',KEYS\[1\]\)/);assert.match(script,/used>=limit/);
 assert.doesNotMatch(key,/read-budget/i);assert.match(key,/tesla-voice:v1:google-places-budget:/);
});

test('Google Places quota exhaustion and Redis corruption fail closed',async()=>{
 for(const result of [0,-1,'not-a-counter']){
  const store=persistentStore({TOKEN_STORE_REST_URL:'https://redis.example.test/',TOKEN_STORE_REST_TOKEN:'fixture'},async()=>Response.json({result}));
  if(result===0)assert.equal(await store.reserveGooglePlacesRequest('2026-11-08'),false);
  else await assert.rejects(store.reserveGooglePlacesRequest('2026-11-08'),/store/);
 }
});

test('Google Places quota rejects malformed UTC dates before Redis',async()=>{
 let calls=0;const store=persistentStore({TOKEN_STORE_REST_URL:'https://redis.example.test/',TOKEN_STORE_REST_TOKEN:'fixture'},async()=>{calls++;return Response.json({result:1});});
 for(const day of ['2026-13-08','2026-02-30','20261108'])await assert.rejects(store.reserveGooglePlacesRequest(day),/configuration/);
 assert.equal(calls,0);
});
