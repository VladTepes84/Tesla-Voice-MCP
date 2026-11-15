import { normalizeSfoe } from './lib/national-stations.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {CsvParser,normalizeIrve,normalizeBnetza,germanCsvLink} from './lib/european-stations.mjs';
import {selectCandidates,computeNationalPlan} from './lib/national-routing.mjs';
test('CSV handles UTF-8 fields, quoted commas/newlines and quote split across chunks',()=>{
 const rows=[],p=new CsvParser();p.write('a,b\n"one,',r=>rows.push(r));p.write('two\nline","a"',r=>rows.push(r));p.write('"b"\n',r=>rows.push(r));p.finish(r=>rows.push(r));
 assert.deepEqual(rows,[['a','b'],['one,two\nline','a"b']]);
});
test('IRVE retains actual connector, same-point kW, timestamp and transborder EVSE country',()=>{
 const r={id_pdc_itinerance:'IT*ABC*E1',coordonneesXY:'[9.1,45.5]',prise_type_combo_ccs:'TRUE',puissance_nominale:'150',condition_acces:'Accès libre',date_maj:'2026-11-01'};
 const [s]=normalizeIrve(r,{source:'FR_IRVE'});assert.equal(s.country,null);assert.equal(s.evse_country_prefix,'IT');assert.equal(s.power_kw,150);assert.equal(s.availability,'unknown');
 assert.equal(normalizeIrve({...r,condition_acces:'Accès réservé'}).length,0);assert.equal(normalizeIrve({...r,prise_type_combo_ccs:'false'}).length,0);
});
test('BNetzA associates CCS with the matching numbered point, never AC power or connection capacity',()=>{
 const r={Betreiber:'operator',Ort:'Munich',Breitengrad:'48,13','Längengrad':'11,58',Steckertypen1:'AC Steckdose Typ 2','P1 [kW]':'300',Steckertypen2:'DC Kupplung Combo 2','P2 [kW]':'50'};
 const [s]=normalizeBnetza(r);assert.equal(s.power_kw,50);assert.equal(s.country,'DE');
 assert.equal(normalizeBnetza({...r,Status:'In Wartung'}).length,0);
});
test('German file discovery accepts only official CSV download paths',()=>{
 assert.match(germanCsvLink('<a href="/SharedDocs/Downloads/register.csv?__blob=publicationFile&amp;v=1">'),/publicationFile&v=1/);
 assert.throws(()=>germanCsvLink('<a href="https://evil.invalid/x.csv">'),/link_not_found/);
});
test('local search widens and avoids duplicate sockets exhausting candidate slots',()=>{
 const line=[[9,45],[10,45]],stations=[{id:'a',country:'CH',lat:45.03,lon:9.5,ccs2:true,power_kw:50},{id:'b',country:'CH',lat:45.03,lon:9.5,ccs2:true,power_kw:150}];
 assert.equal(selectCandidates(stations,line,2000).selected.length,0);
 const found=selectCandidates(stations,line,5000).selected;assert.equal(found.length,1);assert.equal(found[0].id,'b');assert.deepEqual(found[0].alternative_evse_ids,['a']);
});
test('progressive search reports unknown feasibility for an unreachable real candidate',async()=>{
 const input={origin:{lat:45,lon:9},destination:{lat:45,lon:10},roundTrip:false,batteryPercent:39,usableCapacityKwh:68,consumptionKwhPer100Km:13,reservePercent:15,chargingTargetPercent:85,maxChargingStops:6};
 const result=await computeNationalPlan({input,catalog:{stations:[{id:'a',country:'CH',lat:45.03,lon:9.5,ccs2:true}],countries:['CH']},line:[[9,45],[10,45]],maps:{routing:async()=>({distances:[[0,100000,50000],[100000,0,50000],[50000,50000,0]]})},route:()=>assert.fail('final route'),baseResult:{distance_km:100},choosePath:()=>({found:false}),estimate:()=>{}});
 assert.equal(result.charging_plan.feasible,null);assert.equal(result.coverage.search_stages.length,3);assert.equal(result.coverage.complete,false);
});

test('the currently published German data subdomain is an official allowed download',()=>{
 assert.match(germanCsvLink('<a href="https://data.bundesnetzagentur.de/Bundesnetzagentur/DE/x.csv">'),/^https:\/\/data.bundesnetzagentur.de\//);
});

test('observed 2026 German schema uses same-point Nennleistung and actual EVSE identifiers',()=>{
 const row={Betreiber:'EnBW',Status:'In Betrieb',Ort:'Amstetten',Breitengrad:'48,578533','Längengrad':'9,87484',Steckertypen1:'DC Fahrzeugkupplung Typ Combo 2 (CCS)','Nennleistung Stecker1':'100','EVSE-ID1':'DE*EBW*E912316*1'};
 assert.equal(normalizeBnetza(row)[0].power_kw,100);assert.equal(normalizeBnetza(row)[0].id,'DE*EBW*E912316*1');
 assert.equal(normalizeBnetza({...row,Steckertypen1:'AC Typ 2;DC Combo 2','Nennleistung Stecker1':'300;50'})[0].power_kw,50);
 assert.equal(normalizeBnetza({...row,Steckertypen1:'AC Typ 2;DC Combo 2','Nennleistung Stecker1':'300'}).length,0);
});

test('SFOE includes standard free-public access and excludes restricted/test stations',()=>{
 const record={EvseID:'CH*TEST*1',GeoCoordinates:{Google:'46.43 9.76'},Plugs:['CCS Combo 2 Plug (Cable Attached)'],ChargingFacilities:[{power:'150',powertype:'DC'}]};
 const normalize=access=>normalizeSfoe({EVSEData:[{OperatorName:'fixture',EVSEDataRecord:[{...record,Accessibility:access}]}]});
 assert.equal(normalize('Free publicly accessible').length,1);assert.equal(normalize('Restricted access').length,0);assert.equal(normalize('Test Station').length,0);
});

test('a noncanonical optional SFOE field cannot discard the entire national feed',()=>{
 const stations=normalizeSfoe({EVSEData:[{OperatorName:'fixture',EVSEDataRecord:[null,{EvseID:'CH*TEST*2',Accessibility:'Free publicly accessible',GeoCoordinates:{Google:'46.43 9.76'},Plugs:['CCS Combo 2 Plug (Cable Attached)'],ChargingFacilities:{},ChargingStationNames:'Public fixture'}]}]});
 assert.equal(stations.length,1);assert.equal(stations[0].power_kw,null);assert.equal(stations[0].name,'Public fixture');
});

test('German CCS1 and unversioned Combo labels are never advertised as CCS2',()=>{
 const row={Betreiber:'Fixture',Status:'In Betrieb',Breitengrad:'48','Längengrad':'10','Nennleistung Stecker1':'150'};
 for(const Steckertypen1 of ['DC Combo 1 (CCS)','DC Combo','DC CCS','AC Typ 2'])assert.equal(normalizeBnetza({...row,Steckertypen1}).length,0);
 for(const Steckertypen1 of ['DC Fahrzeugkupplung Typ Combo 2 (CCS)','DC CCS2'])assert.equal(normalizeBnetza({...row,Steckertypen1})[0].ccs2,true);
});
