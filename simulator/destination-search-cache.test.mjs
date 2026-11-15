import test from 'node:test';
import assert from 'node:assert/strict';
import { destinationSearchCache } from './lib/destination-search-cache.mjs';

const config={issuer:'https://issuer.example/',key:Buffer.alloc(32,19)};
const found={source:'PHOTON_OSM',candidates:[{name:'Laketown',lat:45.8,lon:9.1}],selection_required:false};

test('destination search cache is encrypted, query-keyed, scoped, and persistent',async()=>{
 const rows=new Map();let now=1000,calls=0;
 const cache=destinationSearchCache({store:{get:async k=>rows.get(k)??null,put:async(k,v)=>rows.set(k,v)},config,now:()=>now});
 const first=await cache.resolve('owner','Via Sample 40, Laketown',async()=>{calls++;return found;});
 assert.equal(first.cache_hit,false);assert.deepEqual(first.result,found);assert.equal(calls,1);
 const [key,value]=[...rows.entries()][0];assert.match(key,/^destination-search:[A-Za-z0-9_-]+$/);
 assert.doesNotMatch(key+value,/Via Sample|Laketown|45\.8|9\.1/);
 const second=await cache.resolve('owner','Vía Sample 40, Laketown',async()=>{calls++;return found;});
 assert.equal(second.cache_hit,true);assert.deepEqual(second.result,found);assert.equal(calls,1);
 const isolated=await cache.resolve('another-owner','Via Sample 40, Laketown',async()=>{calls++;return found;});
 assert.equal(isolated.cache_hit,false);assert.equal(calls,2);
 now+=6*60*60*1000+1;
 const expired=await cache.resolve('owner','Via Sample 40, Laketown',async()=>{calls++;return found;});
 assert.equal(expired.cache_hit,false);assert.equal(calls,3);
});

test('identical concurrent searches share one loader and cache storage failures do not block lookup',async()=>{
 const rows=new Map(),cache=destinationSearchCache({store:{get:async k=>rows.get(k)??null,put:async(k,v)=>rows.set(k,v)},config});
 let calls=0,release;
 const gate=new Promise(resolve=>{release=resolve;});
 const loader=async()=>{calls++;await gate;return found;};
 const one=cache.resolve('owner','Duomo Milano',loader),two=cache.resolve('owner','Duomo Milano',loader);
 release();const [a,b]=await Promise.all([one,two]);
 assert.equal(calls,1);assert.deepEqual(a.result,found);assert.deepEqual(b.result,found);
 assert.equal(b.request_deduplicated,true);
 const noStore=destinationSearchCache({store:{get:async()=>null,put:async()=>{throw Error('store');}},config});
 let failures=0;
 for(let i=0;i<2;i++)await noStore.resolve('owner','No match',async()=>{failures++;return{source:'PHOTON_OSM',candidates:[],selection_required:true};});
 assert.equal(failures,2);
});

test('transient provider and limiter failures are not cached as ordinary no-result searches',async()=>{
 const rows=new Map(),cache=destinationSearchCache({store:{get:async k=>rows.get(k)??null,put:async(k,v)=>rows.set(k,v)},config});
 let calls=0;
 for(let i=0;i<2;i++)await cache.resolve('owner','Via Sample 40, Laketown',async()=>{calls++;return{source:'PHOTON_OSM',candidates:[],fallback_status:'providers_unavailable'};});
 assert.equal(calls,2);assert.equal(rows.size,0);
});

test('Google Place ID proofs are encrypted, account-bound, and expire with the lookup',async()=>{
 const rows=new Map();let now=1000;
 const store={get:async key=>rows.get(key)??null,put:async(key,value)=>rows.set(key,value),reserveGooglePlacesRequest:async()=>true};
 const cache=destinationSearchCache({store,config,now:()=>now});
 const id='TESTPLACEIDONE00000000001';
 assert.equal(await cache.attestGooglePlaceIds('owner',[id]),1);
 const [key,value]=[...rows.entries()][0];
 assert.match(key,/^google-place-id-proof:[A-Za-z0-9_-]+$/);
 assert.doesNotMatch(key+value,/owner|TESTPLACEIDONE00000000001/);
 assert.deepEqual(await cache.verifyGooglePlaceIds('owner',[id]),[id]);
 assert.deepEqual(await cache.verifyGooglePlaceIds('other-account',[id]),[]);
 now+=6*60*60*1000+1;
 assert.deepEqual(await cache.verifyGooglePlaceIds('owner',[id]),[]);
});

test('Google Place ID proof storage errors fail closed and malformed IDs cannot be attested',async()=>{
 const cache=destinationSearchCache({store:{get:async()=>null,put:async()=>{throw Error('redis unavailable');}},config});
 await assert.rejects(cache.attestGooglePlaceIds('owner',['TESTPLACEIDONE00000000001']),/redis unavailable/);
 await assert.rejects(cache.attestGooglePlaceIds('owner',['not valid!']),/invalid_map_arguments/);
});

test('Google quota reservations use the shared persistent-store counter and UTC day',async()=>{
 const days=[];
 const cache=destinationSearchCache({store:{get:async()=>null,put:async()=>{},reserveGooglePlacesRequest:async day=>{days.push(day);return true;}},config,now:()=>Date.UTC(2026,10,8,23,59)});
 assert.equal(await cache.reserveGooglePlacesRequest(),true);
 assert.deepEqual(days,['2026-11-08']);
});
