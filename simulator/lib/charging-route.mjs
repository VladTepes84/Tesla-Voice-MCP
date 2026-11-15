import { PLANNER_BUDGET_MS, CATALOG_BUDGET_MS } from './request-deadline.mjs';
import { chargingPolicy, optimizePathCharging } from './charging-optimization.mjs';
import { loadEuropeanStations } from './european-stations.mjs';
import { computeNationalPlan } from './national-routing.mjs';
import { loadSwissStations } from './national-stations.mjs';
import { mapClient } from './map-providers.mjs';
import { chargingCorridorQuery } from './charging-corridor.mjs';
import { estimateTripEnergy } from './energy-estimate.mjs';
import { roadTripTools } from './road-trip.mjs';
import { normalizeOsmCharging } from './osm-charging.mjs';

const base = roadTripTools.find(t => t.name === 'plan_road_trip');
const fields = ['origin','destination','roundTrip','batteryPercent','usableCapacityKwh','consumptionKwhPer100Km','reservePercent','externalMapsConsent'];
const routePreferencesSchema={type:'object',additionalProperties:false,properties:{
 avoidTolls:{type:'boolean'},avoidHighways:{type:'boolean'},avoidMotorways:{type:'boolean'},
 preferredRoads:{type:'array',maxItems:5,items:{type:'string',minLength:2,maxLength:100}}
}};
export const chargingRouteTool = {
  name:'plan_charging_road_trip',
  description:'Plans trips using DC/HPC CCS2 only, including Superchargers. AC is available only in a separate user-requested area search with find_charging_sites and connectorType AC; do not include AC sites as trip stops. Uses progressive search and reserve checks for each leg. Treat unknown prices and availability as unknown; do not use personal saved tariffs. Does not send commands or destinations to Tesla.',
  inputSchema:{type:'object',properties:{...Object.fromEntries(fields.map(k=>[k,base.inputSchema.properties[k]])),stops:base.inputSchema.properties.stops,routePreferences:routePreferencesSchema,allowAcCharging:{type:'boolean',const:false},vehicleAcPowerKw:{type:'number',minimum:0.1,maximum:100},maximumAcStopMinutes:{type:'number',minimum:1,maximum:1440},arrivalPercent:{type:'number',minimum:0,maximum:100},consumptionMarginPercent:{type:'number',minimum:0,maximum:50},efficiencyPercent:{type:'number',minimum:1,maximum:100},objective:{type:'string',enum:['balanced','energy','time','cost']},batterySource:{type:'string',enum:['user_supplied','simulated','cached','live']},batterySampledAt:{type:'string',format:'date-time'},preferFreeToXMotorway:{type:'boolean'},chargingTargetPercent:{type:'number',minimum:1,maximum:100},maxChargingStops:{type:'integer',minimum:1,maximum:6}},required:[...fields.filter(k=>k!=='externalMapsConsent'),'chargingTargetPercent','maxChargingStops'],additionalProperties:false},
  annotations:base.annotations,securitySchemes:base.securitySchemes
};
const finite = (n,a,b) => typeof n === 'number' && Number.isFinite(n) && n>=a && n<=b;
function validPoint(p) { return p && Object.getPrototypeOf(p)===Object.prototype && Object.keys(p).every(k=>['lat','lon'].includes(k)) && finite(p.lat,-90,90) && finite(p.lon,-180,180); }
const attribution='© OpenStreetMap contributors, ODbL; routing by OSRM. Availability and tariffs are not verified.';

// Distances are road metres, not straight-line estimates. Energy is rounded
// conservatively to half-kWh units, with reserve required on every edge.
export function chooseChargingPath({ deadline=Infinity, waypointCount=0, arrivalPercent, stationChargingLimits, distances, batteryPercent, usableCapacityKwh, consumptionKwhPer100Km, reservePercent, chargingTargetPercent, maxChargingStops, roundTrip }) {
  const size=distances.length;
  if(stationChargingLimits!==undefined&&(!Array.isArray(stationChargingLimits)||stationChargingLimits.length!==size||stationChargingLimits.some(v=>v!==null&&(!Number.isInteger(v)||v<0))))throw Error('invalid_map_arguments');
  if (!Number.isInteger(waypointCount)||waypointCount<0||waypointCount>8||size<2+waypointCount || size>14+waypointCount || distances.some(row=>!Array.isArray(row)||row.length!==size||row.some(d=>d!==null&&!finite(d,0,10000000)))) throw Error('map_provider_unavailable');
  const initial=Math.floor(usableCapacityKwh*batteryPercent/50), target=Math.floor(usableCapacityKwh*chargingTargetPercent/50), reserve=Math.ceil(usableCapacityKwh*reservePercent/50);
  const goalReserve=Math.max(reserve,Math.ceil(usableCapacityKwh*(arrivalPercent??reservePercent)/50));
  const queue=[], best=new Map();
  // A bounded priority search must not re-sort the entire frontier for each
  // expanded state. Keep the same stop/distance order with a binary min-heap.
  let sequence=0;
  const less=(a,b)=>a.stops<b.stops || a.stops===b.stops && (a.distance<b.distance || a.distance===b.distance && a.sequence<b.sequence);
  const enqueue=state=>{
    const value={...state,sequence:sequence++};let i=queue.length;queue.push(value);
    while(i>0){const parent=(i-1)>>1;if(!less(value,queue[parent]))break;queue[i]=queue[parent];i=parent;}queue[i]=value;
  };
  const dequeue=()=>{
    const first=queue[0],last=queue.pop();
    if(queue.length){let i=0;while(2*i+1<queue.length){let child=2*i+1;if(child+1<queue.length&&less(queue[child+1],queue[child]))child++;if(!less(queue[child],last))break;queue[i]=queue[child];i=child;}queue[i]=last;}
    return first;
  };
  const stationStart=2+waypointCount;
  const goals=[...Array.from({length:waypointCount},(_,i)=>i+2),1,...(roundTrip?[0]:[])];
  const stations=Array.from({length:size-stationStart},(_,i)=>i+stationStart);
  enqueue({node:0,phase:0,energy:initial,mask:0,stops:0,distance:0,path:[0]});
  let examined=0;
  while(queue.length && examined++<100000) {
    if(Date.now()>=deadline)return {found:false,search_truncated:true,budget_exhausted:true};
    const s=dequeue(), key=[s.node,s.phase,s.energy,s.mask].join(':');
    const prior=best.get(key);
    if(prior && (prior.stops<s.stops || prior.stops===s.stops && prior.distance<=s.distance)) continue;
    best.set(key,{stops:s.stops,distance:s.distance});
    const goal=goals[s.phase];
    if(goal===undefined)return {found:true,path:s.path,charging_stops:s.stops};
    for(const next of [goal,...stations]) {
      const charging=next>=stationStart, bit=charging?1<<(next-stationStart):0;
      if(next===s.node || charging && ((s.mask&bit)||s.stops>=maxChargingStops)) continue;
      const distance=distances[s.node][next];if(distance===null)continue;
      const arrival=s.energy-Math.ceil(distance*consumptionKwhPer100Km/50000);
      if(arrival<(next===goal&&s.phase===goals.length-1?goalReserve:reserve) || charging&&arrival>=target)continue;
      enqueue({node:next,phase:s.phase+(charging?0:1),energy:charging?Math.min(target,arrival+(stationChargingLimits?.[next]??target)):arrival,mask:charging?s.mask|bit:0,
        stops:s.stops+(charging?1:0),distance:s.distance+distance,path:[...s.path,next]});
    }
  }
  return {found:false,search_truncated:queue.length>0};
}

async function buildChargingRoadTrip(input,{fetcher=fetch,stationCatalog=null,catalogLoader=null,budgetMs=PLANNER_BUDGET_MS,catalogBudgetMs=CATALOG_BUDGET_MS,osmCharging=null}={}) {
  if(!input || Object.getPrototypeOf(input)!==Object.prototype || Object.keys(input).some(k=>!Object.hasOwn(chargingRouteTool.inputSchema.properties,k))) throw Error('invalid_map_arguments');
  if(input.allowAcCharging===true)throw Error('invalid_map_arguments');
  if(input.externalMapsConsent!==true)throw Error('map_consent_required');
  if(!validPoint(input.origin)||!validPoint(input.destination)||typeof input.roundTrip!=='boolean'||!finite(input.chargingTargetPercent,1,100)||input.chargingTargetPercent<=input.reservePercent||!Number.isInteger(input.maxChargingStops)||input.maxChargingStops<1||input.maxChargingStops>6)throw Error('invalid_map_arguments');
  if(input.stops!==undefined&&(!Array.isArray(input.stops)||input.stops.length>8||!input.stops.every(validPoint)))throw Error('invalid_map_arguments');
  estimateTripEnergy({...input,distanceKm:0});
  const policy=chargingPolicy(input);
  const started=Date.now(),deadline=started+budgetMs;
  let maps=mapClient(fetcher,{deadline,routePreferences:input.routePreferences??{}});
  const route=async(points,overview)=>{
    const data=await maps.routing(`/route/v1/driving/${points.map(p=>`${p.lon},${p.lat}`).join(';')}?overview=${overview}&geometries=geojson&steps=false&alternatives=false&radiuses=${points.map(()=>1000).join(';')}`, data=>{
      const r=data.routes?.[0];
      return data.code==='Ok' && r && finite(r.distance,0,10000000) && finite(r.duration,0,10000000) && Array.isArray(r.legs) && r.legs.length===points.length-1 && r.legs.every(l=>finite(l.distance,0,1000000)&&finite(l.duration,0,10000000)) &&
        Math.abs(r.legs.reduce((sum,l)=>sum+l.distance,0)-r.distance)<=Math.max(2,r.legs.length*0.1);
    });
    return data.routes[0];
  };
  const original=[input.origin,...(input.stops||[]),input.destination,...(input.roundTrip?[input.origin]:[])];
  const direct=await route(original,'simplified');
  const energy=estimateTripEnergy({...input,distanceKm:direct.distance/1000});
  const baseResult={request_budget:{limit_ms:budgetMs,routing_deadline_reset:false},battery_input:{source:input.batterySource??'user_supplied',sampled_at:input.batterySampledAt??null,provenance:'CALLER_REPORTED_NOT_INDEPENDENTLY_VERIFIED',vehicle_read_performed:false},energy_assumptions:policy,source:'OSRM_ROAD_ROUTE',round_trip:input.roundTrip,distance_km:direct.distance/1000,duration_minutes_without_live_traffic:direct.duration/60,legs:direct.legs.map(l=>({distance_km:l.distance/1000,duration_minutes:l.duration/60})),energy,diagnostics:maps.diagnostics,routing_preferences:maps.routePreferenceReport(),sent_to_vehicle:false,tariffs_verified:false,availability_verified:false,plan_compatibility_verified:false,attribution,fix_map_url:'https://www.openstreetmap.org/fixthemap'};
  const initialStored=Math.floor(input.usableCapacityKwh*input.batteryPercent/50)/2;
  const directRequired=direct.legs.reduce((sum,l)=>sum+Math.ceil(l.distance*input.consumptionKwhPer100Km*(1+policy.consumption_margin_percent/100)/50000)/2,0);
  baseResult.direct_energy_assessment={initial_kwh:initialStored,planned_energy_kwh:directRequired,
    estimated_arrival_percent:(initialStored-directRequired)*100/input.usableCapacityKwh,
    reserve_percent:input.reservePercent,arrival_target_percent:policy.arrival_percent,
    charging_required:initialStored-directRequired<Math.ceil(input.usableCapacityKwh*policy.arrival_percent/50)/2,
    consumption_margin_percent:policy.consumption_margin_percent};
  let discoveredSites=null;
  const degraded=reason=>({...baseResult,sites:discoveredSites||[],charging_data_available:discoveredSites!==null,charging_plan:{feasible:null,reason,stops:[]},limitation:'Road route calculated; charging stops are unverified. Do not depart without identifying a charging site reachable before the reserve.'});
  const directUnits=direct.legs.reduce((sum,l)=>sum+Math.ceil(l.distance*input.consumptionKwhPer100Km*(1+policy.consumption_margin_percent/100)/50000),0);
  if(!baseResult.direct_energy_assessment.charging_required){
    const path=original.map((_,i)=>i);
    const optimized=optimizePathCharging({input,legs:direct.legs,path,points:original,stationStart:original.length});
    if(optimized.feasible)return {...baseResult,legs:optimized.legs,
      navigation_destinations:original.slice(1),charging_plan:{...optimized,planned_road_energy_kwh:directUnits/2}};
  }
  try {
  const line=direct.geometry?.coordinates;
  if(!Array.isArray(line)||line.length<2||line.some(p=>!Array.isArray(p)||p.length!==2||!finite(p[0],-180,180)||!finite(p[1],-90,90)))throw Error('map_provider_unavailable');
  if(stationCatalog||fetcher===fetch||catalogLoader!==null||input.stops?.length) {
    const useOsm=!!osmCharging||(!stationCatalog && !catalogLoader && fetcher===fetch);
    const osmPromise=useOsm?Promise.resolve().then(()=>(osmCharging||maps.charging)(chargingCorridorQuery(line).query)).then(data=>({data}),()=>({failed:true})):null;
    const catalog=stationCatalog||await (catalogLoader||loadEuropeanStations)({fetcher,deadline:Math.min(deadline-Math.min(5000,budgetMs/3),started+catalogBudgetMs),includeAc:false});
    if(useOsm){
      try {
        const {coverage}=chargingCorridorQuery(line);
        const {data}=await osmPromise;
        const sites=normalizeOsmCharging(data);
        catalog.stations=[...catalog.stations,...sites];
        catalog.sources=[...(catalog.sources||[]),{country:'OSM',status:'ok',download_complete:false,station_count:sites.length,coverage}];
        catalog.attribution=[catalog.attribution,'© OpenStreetMap contributors, ODbL'].filter(Boolean).join('; ');
      } catch {catalog.sources=[...(catalog.sources||[]),{country:'OSM',status:'unavailable',download_complete:false}];}
    }
    baseResult.diagnostics.push(...(catalog.sources||[]).map(s=>({stage:'catalog',country:s.country,outcome:s.status==='ok'?(s.download_complete?'complete':'partial'):'unavailable',reason:s.issue||s.reason||null})));
    // The same absolute deadline covers initial routing, catalogs and all alternatives.
    return await computeNationalPlan({input,catalog,line,maps,route,baseResult,choosePath:chooseChargingPath,estimate:estimateTripEnergy,deadline});
  }
  const sample=line.filter((_,i)=>i%Math.max(1,Math.ceil(line.length/127))===0);if(sample.at(-1)!==line.at(-1))sample.push(line.at(-1));
  // A bounded union of narrow, route-aligned windows works across national borders.
  // Large European trips are explicitly marked incomplete, not falsely certified.
  const { query, coverage: corridorCoverage } = chargingCorridorQuery(line);
  const corridorDistance = (lat,lon) => {
    const scale=111000*Math.cos(lat*Math.PI/180);
    let best=Infinity;
    for(let i=1;i<line.length;i++) {
      const ax=(line[i-1][0]-lon)*scale,ay=(line[i-1][1]-lat)*111000;
      const bx=(line[i][0]-lon)*scale,by=(line[i][1]-lat)*111000;
      const dx=bx-ax,dy=by-ay;
      const t=Math.max(0,Math.min(1,-(ax*dx+ay*dy)/(dx*dx+dy*dy||1)));
      best=Math.min(best,Math.hypot(ax+t*dx,ay+t*dy));
    }
    return best;
  };
  const catalog=stationCatalog || (fetcher===fetch ? await loadSwissStations({fetcher}) : null);
  let data,sites;
  if(catalog) {
    sites=catalog.stations.filter(s=>s.ccs2===true&&corridorDistance(s.lat,s.lon)<=2000);
    data={elements:sites};
    baseResult.station_data={countries:catalog.countries,source_url:catalog.source_url,source_updated_at:catalog.source_updated_at,attribution:catalog.attribution};
  } else {
    // Injected legacy fixtures only; real default requests use the national adapter.
    data=await maps.charging(query);
    if(!Array.isArray(data.elements)||data.remark)throw Error('map_provider_unavailable');
  sites=data.elements.flatMap(e=>{
    const tags=e.tags||{},lat=e.lat??e.center?.lat,lon=e.lon??e.center?.lon;
    if(!finite(lat,-90,90)||!finite(lon,-180,180)||!['node','way','relation'].includes(e.type)||!Number.isSafeInteger(e.id)||!/^(yes|[1-9]\d*)$/i.test(tags['socket:type2_combo']||'')||['private','no','customers'].includes(tags.access)||tags.disused==='yes'||corridorDistance(lat,lon)>2000)return [];
    return [{lat,lon,name:String(tags.name||'').slice(0,120),operator:String(tags.operator||tags.brand||'').slice(0,120),source_url:`https://www.openstreetmap.org/${e.type}/${e.id}`,availability:'unknown',tariff:null}];
  }).slice(0,500);
  }
  // Spread a bounded candidate set along the simplified road line, rather than
  // relying on OSM identifier order. This is explicitly incomplete coverage.
  const progress = site => {
    let nearest=Infinity,index=0;
    sample.forEach(([lon,lat],i)=>{const d=(lat-site.lat)**2+((lon-site.lon)*Math.cos(site.lat*Math.PI/180))**2;if(d<nearest){nearest=d;index=i;}});
    return index;
  };
  const ordered=sites.map((site,i)=>({site,index:progress(site),i})).sort((a,b)=>a.index-b.index||a.i-b.i).map(x=>x.site);
  const selected=ordered.length<=8?ordered:Array.from({length:8},(_,i)=>ordered[Math.floor(i*(ordered.length-1)/7)]);
  discoveredSites=selected;
  const points=[input.origin,input.destination,...selected];
  if(!selected.length)return {...degraded('no_mapped_ccs2_sites'),charging_data_available:true,coverage:{...corridorCoverage,mapped_candidates:0,exhaustive:false}};
  // A limited sample cannot certify route feasibility; return real sites as candidates.
  if(!corridorCoverage.complete||data.elements.length>=500)return {...degraded('charging_corridor_search_incomplete_or_truncated'),charging_data_available:true,coverage:{...corridorCoverage,mapped_candidates:sites.length,selected_candidates:selected.length,exhaustive:false}};
  const table=await maps.routing(`/table/v1/driving/${points.map(p=>`${p.lon},${p.lat}`).join(';')}?annotations=distance`,data=>data.code==='Ok'&&Array.isArray(data.distances)&&data.distances.length===points.length&&data.distances.every(row=>Array.isArray(row)&&row.length===points.length&&row.every(d=>d===null||finite(d,0,10000000))));
  if(table.code!=='Ok'||!Array.isArray(table.distances)||table.distances.length!==points.length)throw Error('map_provider_unavailable');
  const choice=chooseChargingPath({...input,distances:table.distances});
  const coverage={...corridorCoverage,mapped_candidates:sites.length,selected_candidates:selected.length,map_result_truncated:data.elements.length>=500,exhaustive:false};
  if(!choice.found)return {...baseResult,charging_data_available:true,sites:selected,source:'OSRM_OSM_CHARGING_ROUTE',charging_plan:{feasible:false,reason:'no_plan_with_selected_candidates',search_truncated:choice.search_truncated},coverage,tariffs_verified:false,availability_verified:false,sent_to_vehicle:false,attribution};
  const routed=choice.path.map(i=>points[i]);
  const final=await route(routed,'false');
  let stored=Math.floor(input.usableCapacityKwh*input.batteryPercent/50);
  const reserve=Math.ceil(input.usableCapacityKwh*input.reservePercent/50),target=Math.floor(input.usableCapacityKwh*input.chargingTargetPercent/50),stops=[];
  for(let i=0;i<final.legs.length;i++) {
    stored-=Math.ceil(final.legs[i].distance*input.consumptionKwhPer100Km/50000);
    if(stored<reserve)return {...baseResult,charging_data_available:true,sites:selected,source:'OSRM_OSM_CHARGING_ROUTE',charging_plan:{feasible:false,reason:'final_route_does_not_meet_reserve',blocked_leg:i},coverage,sent_to_vehicle:false,attribution};
    const node=choice.path[i+1];
    if(node>=2) {stops.push({...points[node],after_leg:i,energy_to_battery_kwh:Math.max(0,target-stored)/2});stored=Math.max(stored,target);}
  }
  return {...baseResult,navigation_destinations:routed.slice(1).map(p=>({lat:p.lat,lon:p.lon})),charging_data_available:true,sites:selected,source:'OSRM_OSM_CHARGING_ROUTE',round_trip:input.roundTrip,distance_km:final.distance/1000,energy:estimateTripEnergy({...input,distanceKm:final.distance/1000}),legs:final.legs.map(l=>({distance_km:l.distance/1000,duration_minutes:l.duration/60})),duration_minutes_without_live_traffic:final.duration/60,charging_plan:{feasible:true,stops,estimated_arrival_kwh:stored/2,model:'conservative_0.5_kwh_grid',selection_basis:'fewest_stops_then_pairwise_road_distance'},energy_assumptions:{consumption_kwh_per_100km:input.consumptionKwhPer100Km,usable_capacity_kwh:input.usableCapacityKwh,reserve_percent:input.reservePercent,charging_target_percent:input.chargingTargetPercent,weather_and_elevation_modeled:false},coverage,tariffs_verified:false,availability_verified:false,sent_to_vehicle:false,attribution};
  } catch { return degraded('charging_provider_or_optimization_unavailable'); }
}

// Server-side elapsed time, distinct from MCP/Vercel fetch-tool overhead.
export async function planChargingRoadTrip(input,options={}){
 const started=Date.now();
 const result=await buildChargingRoadTrip(input,options);
 return {...result,request_budget:{...result.request_budget,elapsed_ms:Date.now()-started}};
}
