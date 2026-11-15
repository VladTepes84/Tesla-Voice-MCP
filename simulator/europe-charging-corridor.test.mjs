import test from 'node:test';
import assert from 'node:assert/strict';
import { chargingCorridorQuery } from './lib/charging-corridor.mjs';
import { planChargingRoadTrip } from './lib/charging-route.mjs';

const input = {origin:{lat:45,lon:9},destination:{lat:46,lon:10},roundTrip:true,
  batteryPercent:50,usableCapacityKwh:50,consumptionKwhPer100Km:20,
  reservePercent:10,chargingTargetPercent:85,maxChargingStops:4,externalMapsConsent:true};

test('European cross-border geometry creates bounded regional charging windows',()=>{
  const line=[[9.19,45.4642],[9.35,45.9],[9.55,46.2],[9.7636,46.4285],
    [9.55,46.2],[9.35,45.9],[9.19,45.4642]];
  const {query,coverage}=chargingCorridorQuery(line);
  assert.equal(coverage.complete,true);
  assert.ok(coverage.queried_windows>2 && coverage.queried_windows<=16);
  assert.match(query,/\[out:json\]\[timeout:6\]/);
  assert.match(query,/socket:type2_combo/);
  assert.match(query,/\(nwr/);
  assert.doesNotMatch(query,/undefined|NaN/);
});

test('long European itineraries report incomplete charging coverage, never complete',()=>{
  const line=Array.from({length:150},(_,i)=>[2+i*0.05,44+i*0.05]);
  const r=chargingCorridorQuery(line,{maxWindows:4});
  assert.equal(r.coverage.complete,false);
  assert.equal(r.coverage.queried_windows,4);
  assert.ok(r.coverage.total_windows>4);
  assert.throws(()=>chargingCorridorQuery([[9,45],[Infinity,46]]),/invalid_map_arguments/);
});

test('OSM charging query stays regional and returns verified road distance when no charger found',async()=>{
  const calls=[];
  const result=await planChargingRoadTrip(input,{fetcher:async(url,options={})=>{
    calls.push({url,body:options.body||''});
    if(url.includes('/api/interpreter'))return Response.json({elements:[]});
    return Response.json({code:'Ok',routes:[{distance:300000,duration:20000,
      legs:[{distance:150000,duration:10000},{distance:150000,duration:10000}],
      geometry:{coordinates:[[9,45],[10,46],[9,45]]}}]});
  }});
  assert.equal(result.distance_km,300);
  assert.equal(result.charging_plan.feasible,null);
  assert.equal(result.charging_data_available,true);
  assert.equal(result.coverage.complete,true);
  assert.equal(result.coverage.exhaustive,false);
  const search=calls.find(c=>c.url.includes('/api/interpreter'));
  assert.ok(search);
  assert.match(search.body,/socket%3Atype2_combo/);
  assert.match(search.body,/nwr/);
  assert.equal(result.sent_to_vehicle,false);
});

test('road route longer than 1000 km remains supported without charging requests when energy sufficient',async()=>{
  let calls=0;
  const result=await planChargingRoadTrip({...input,batteryPercent:100,
    usableCapacityKwh:250,consumptionKwhPer100Km:1,reservePercent:10},{fetcher:async(url)=>{
      calls++;assert.match(url,/route\/v1/);
      return Response.json({code:'Ok',routes:[{distance:1500000,duration:60000,
        legs:[{distance:750000,duration:30000},{distance:750000,duration:30000}]}]});
    }});
  assert.equal(result.distance_km,1500);
  assert.equal(result.charging_plan.feasible,true);
  assert.equal(calls,1);
});
