import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeItalianShard} from './lib/italian-stations.mjs';
import {normalizeIrve,normalizeBnetza} from './lib/european-stations.mjs';
import {normalizeSfoe} from './lib/national-stations.mjs';
import {chargingPower,optimizePathCharging,chargingPolicy} from './lib/charging-optimization.mjs';
import {selectCandidates,computeNationalPlan} from './lib/national-routing.mjs';
import {chooseChargingPath} from './lib/charging-route.mjs';
import {planSmartTrip} from './lib/smart-trip.mjs';
import {tripNavigation,tripDestinationHandoff} from './lib/trip-navigation.mjs';
import {chargingPreferences} from './lib/charging-preferences.mjs';
const input={origin:{lat:45,lon:9},destination:{lat:46,lon:10},roundTrip:false,batteryPercent:39,usableCapacityKwh:68,consumptionKwhPer100Km:13,reservePercent:15,chargingTargetPercent:85,maxChargingStops:6,efficiencyPercent:90,objective:'cost',allowAcCharging:true,vehicleAcPowerKw:11,maximumAcStopMinutes:180};
const ac={id:'ac',lat:45.5,lon:9.5,operator:'Free To X',connectorType:'AC',ccs2:false,power_kw:22};
const dc={...ac,id:'dc',connectorType:'CCS2',ccs2:true,power_kw:150};
test('AC Type 2 adapters require explicit connector and AC-associated power, opt-in preserves CCS2 default',()=>{
 const now=Date.parse('2026-11-04T12:00:00Z');
 const doc={_source:'GSE PUN',_source_url:'https://www.piattaformaunicanazionale.it/idr',_license:'CC BY 4.0',_snapshot_date:'2026-11-04',_generated_at:'2026-11-04T07:00:00Z',punti:[{id_evse:'IT*TEST*AC',lat:45.5,lon:9.5,cpo:'Free To X',standard_connettore:'IEC_62196_T2',corrente:'AC',stato:'Attivo',publication_status:'PUBLISHED',potenza_w:22000}]};
 assert.equal(normalizeItalianShard(doc,{now}).length,0);
 const it=normalizeItalianShard(doc,{now,includeAc:true})[0];assert.equal(it.connectorType,'AC');assert.equal(it.ccs2,false);assert.equal(it.power_kw,22);
 assert.equal(normalizeItalianShard({...doc,punti:[{...doc.punti[0],corrente:'DC'}]},{now,includeAc:true}).length,0);
 const fr={id_pdc_itinerance:'FR*TEST*AC',coordonneesXY:'[9.5,45.5]',condition_acces:'Accès libre',prise_type_combo_ccs:'false',prise_type_2:'true',puissance_nominale:'22'};
 assert.equal(normalizeIrve(fr).length,0);assert.equal(normalizeIrve(fr,{}, {includeAc:true})[0].connectorType,'AC');
 assert.equal(normalizeIrve({...fr,prise_type_chademo:'true'}, {},{includeAc:true}).length,0);
 const de={Betreiber:'Free To X',Breitengrad:'48','Längengrad':'10',Steckertypen1:'AC Steckdose Typ 2','Nennleistung Stecker1':'22'};
 assert.equal(normalizeBnetza(de).length,0);assert.equal(normalizeBnetza(de,{}, {includeAc:true})[0].power_kw,22);
 const ch={EVSEData:[{OperatorName:'Free To X',EVSEDataRecord:[{EvseID:'CH*TEST*AC',Accessibility:'Publicly accessible',GeoCoordinates:{Google:'46 9'},Plugs:['Type 2 Outlet'],ChargingFacilities:[{powertype:'AC_3_PHASE',power:22},{powertype:'DC',power:150}]}]}]};
 assert.equal(normalizeSfoe(ch).length,0);assert.equal(normalizeSfoe(ch,{includeAc:true})[0].power_kw,22);
});
test('AC power is capped by vehicle and dwell accounts for efficiency; missing data cannot fabricate energy',()=>{
 assert.equal(chargingPower(ac,input),11);
 assert.equal(chargingPower(ac,{...input,vehicleAcPowerKw:undefined}),null);
 assert.equal(chargingPower(ac,{...input,efficiencyPercent:undefined}),null);
 for(const patch of [{vehicleAcPowerKw:undefined},{maximumAcStopMinutes:undefined},{efficiencyPercent:undefined}])assert.throws(()=>chargingPolicy({...input,...patch}));
 const r=optimizePathCharging({input:{...input,maximumAcStopMinutes:30},points:[{}, {},ac],path:[0,2,1],legs:[{distance:1000,duration:60},{distance:200000,duration:9000}]});
 if(r.feasible){assert.ok(r.stops.every(s=>s.energy_to_battery_kwh<=4.5&&s.theoretical_minimum_charging_minutes<=30));}
});
async function plan(minutes=180,onlyAc=false){
 const stations=onlyAc?[ac]:[ac,dc],points=[input.origin,input.destination,...stations];
 const distances=points.map((p,i)=>points.map((q,j)=>i===j?0:i===0&&j===1?250000:i===0&&j>=2?80000:i>=2&&j===1?170000:1000000));
 return computeNationalPlan({input:{...input,maximumAcStopMinutes:minutes},catalog:{stations,countries:['IT']},line:[[9,45],[10,46]],baseResult:{distance_km:250},
 maps:{routing:async()=>({distances})},choosePath:chooseChargingPath,estimate:()=>({}),route:async()=>({distance:250000,duration:7200,legs:[{distance:80000,duration:3600},{distance:170000,duration:3600}]})});
}
test('with adequate dwell a feasible stop preserves reserve without inventing prices',async()=>{
 const r=await plan();assert.equal(r.charging_plan.feasible,true);
 const s=r.charging_plan.stops[0];assert.equal(s.tariff_source,'unknown');assert.equal(s.estimated_cost_eur,null);
 assert.ok(s.theoretical_minimum_charging_minutes<=180);assert.ok(r.legs.every(l=>l.arrival_kwh>=10.2));
 assert.ok(r.charging_plan.alternatives.some(p=>p.station_ids.includes('dc')));
});
test('with only 30 minutes AC cannot supply missing energy, so DC is recommended',async()=>{
 const r=await plan(30);assert.equal(r.charging_plan.feasible,true);assert.equal(r.charging_plan.stops[0].connectorType,'CCS2');assert.equal(r.charging_plan.stops[0].tariff_source,'unknown');
});
test('AC alone with inadequate dwell never certifies a feasible route',async()=>{
 const r=await plan(30,true);assert.notEqual(r.charging_plan.feasible,true);
});
test('candidate sampling retains DC when hundreds of AC points crowd the corridor',()=>{
 const stations=[dc,...Array.from({length:100},(_,i)=>({...ac,id:'ac'+i,lon:9.1+i*.008,lat:45.1+i*.008}))];
 const r=selectCandidates(stations,[[9,45],[10,46]],10000,12,{input});
 assert.ok(r.selected.some(s=>s.ccs2));assert.ok(r.selected.some(s=>s.connectorType==='AC'));assert.ok(r.selected.length<=12);
 assert.equal(selectCandidates([ac,dc],[[9,45],[10,46]],2000,12).selected.length,1);
});
test('AC charging preserves the target while station price remains unknown',()=>{
 const r=optimizePathCharging({input:{...input,maximumAcStopMinutes:400},points:[{}, {},ac],path:[0,2,1],legs:[{distance:100000,duration:3600},{distance:300000,duration:10000}]});
 assert.equal(r.feasible,true);assert.equal(r.stops[0].tariff_mode,null);assert.equal(r.estimated_cost_eur,null);assert.ok(r.stops[0].departure_percent<85);
});
test('road orchestrator ignores saved AC enablement and never asks AC dwell details',async()=>{
 const now=()=>Date.parse('2026-11-04T12:00:00Z');
 const backend={preferences:{get:async()=>({preferences:{allowAcCharging:true,vehicleAcPowerKw:11,maximumAcStopMinutes:180}})}};
 const r=await planSmartTrip({origin:input.origin,destination:input.destination,batteryPercent:39,externalMapsConsent:true,simulatedBattery:true},{backend,subject:'owner',now,
 plan:async(args)=>{assert.equal(args.allowAcCharging,false);assert.equal(args.vehicleAcPowerKw,undefined);return{charging_plan:{feasible:true,stops:[dc]},navigation_destinations:[{lat:dc.lat,lon:dc.lon},input.destination]};}});
 assert.equal(r.charging_recommendation.connector_scope,'CCS2_DC');assert.equal(r.charging_recommendation.ac_charging.enabled,false);
 await assert.rejects(planSmartTrip({origin:input.origin,destination:input.destination,allowAcCharging:true},{}),/invalid_map_arguments/);
});
test('encrypted multi-stop saved plan does not downgrade to a single destination handoff',async()=>{
 const records=new Map(),now=()=>Date.parse('2026-11-04T12:00:00Z'),config={issuer:'fixture',key:Buffer.alloc(32,9)};
 const store={get:async k=>records.get(k),put:async(k,v)=>records.set(k,v)};
 const plans=tripNavigation({store,config,now});
 const saved=await plans.save('owner',{destinations:[{lat:45.5,lon:9.5},{lat:46,lon:10}],itinerary:{charging_plan:{feasible:true}}});
 const r=await plans.get('owner',saved.id,{destinationIndex:1});assert.equal(r.navigation_handoff.command_request,null);assert.equal(r.navigation_handoff.reason,'multi_stop_requires_verified_waypoints');
 assert.equal(r.single_destination_fallback_allowed,false);
 assert.equal((await plans.get('other',saved.id)).available,false);
 assert.equal((await plans.get('owner',saved.id,{destinationIndex:2})).navigation_handoff.command_request,null);
 await assert.rejects(plans.get('owner',saved.id,{destinationIndex:-1}),/invalid_arguments/);
 assert.equal(tripDestinationHandoff([{lat:100,lon:9}]).available,false);
});
