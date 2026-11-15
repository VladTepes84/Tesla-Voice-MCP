import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeSfoe,loadSwissStations,SFOE_SOURCE} from './lib/national-stations.mjs';
const row={EvseID:'CH*TEST*1',Accessibility:'Paying publicly accessible',GeoCoordinates:{Google:'46.43 9.76'},Plugs:['CCS Combo 2 Plug (Cable Attached)'],ChargingFacilities:[{power:'150.0',powertype:'DC'}],ChargingStationNames:[{lang:'en',value:'Fixture'}]};
const data={EVSEData:[{OperatorName:'Fixture operator',EVSEDataRecord:[row]}]};
test('SFOE normalizes observed OICP CCS2 shape with source and honest timestamps',()=>{
 const [s]=normalizeSfoe(data,{updatedAt:'2026-11-04T08:00:00.000Z'});
 assert.equal(s.lat,46.43);assert.equal(s.lon,9.76);assert.equal(s.power_kw,150);assert.equal(s.ccs2,true);assert.equal(s.availability,'unknown');assert.equal(s.record_updated_at,null);assert.equal(s.source_url,SFOE_SOURCE);
});
test('AC, private access, bad coordinates and CCS1 are not CCS2 candidates',()=>{
 for(const patch of [{Plugs:['Type 2 Outlet']},{Plugs:['CCS Combo 1 Plug']},{Accessibility:'Private'},{GeoCoordinates:{Google:'None None'}}]){
 assert.equal(normalizeSfoe({EVSEData:[{EVSEDataRecord:[{...row,...patch}]}]}).length,0);
 }
 assert.throws(()=>normalizeSfoe({features:[]}),/national_station_schema/);
});
test('national data is coalesced and cached without a second HTTP request',async()=>{
 let calls=0;const fetcher=async(url,opts)=>{calls++;assert.equal(url,SFOE_SOURCE);assert.equal(opts.redirect,'error');return Response.json(data);};
 await Promise.all([loadSwissStations({fetcher}),loadSwissStations({fetcher})]);
 await loadSwissStations({fetcher});assert.equal(calls,1);
});
