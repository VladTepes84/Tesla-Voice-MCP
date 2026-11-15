const operatorKey = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
import { chargingPolicy, optimizePathCharging, chargingPower } from './charging-optimization.mjs';
// Bounded local progressive search; only routing calls determine reachability.
export function corridorProjection(site,line){
 let best=Infinity,progress=0,traveled=0;
 const scale=111000*Math.cos(site.lat*Math.PI/180);
 for(let i=1;i<line.length;i++){
  const ax=(line[i-1][0]-site.lon)*scale,ay=(line[i-1][1]-site.lat)*111000;
  const dx=(line[i][0]-line[i-1][0])*scale,dy=(line[i][1]-line[i-1][1])*111000;
  const length=Math.hypot(dx,dy),t=Math.max(0,Math.min(1,-(ax*dx+ay*dy)/(length*length||1)));
  const distance=Math.hypot(ax+t*dx,ay+t*dy);
  if(distance<best){best=distance;progress=traveled+t*length;}traveled+=length;
 }
 return {corridor_m:best,progress_m:progress};
}
export function selectCandidates(stations,line,radius,limit=12,{deadline=Infinity,input={}}={}){
 const groups=new Map();let truncated=false;
 for(const site of stations){
  if(Date.now()>=deadline){truncated=true;break;}
  const eligibleAc=input.allowAcCharging===true&&site.connectorType==='AC'&&site.ccs2!==true&&chargingPower(site,input)!==null;
  if((!site.ccs2&&!eligibleAc)||!Number.isFinite(site.lat)||!Number.isFinite(site.lon))continue;
  const projected=corridorProjection(site,line);if(projected.corridor_m>radius)continue;
  // Avoid filling the bounded search with multiple sockets at the same location.
  // Preserve their identifiers as alternatives; do not assert simultaneous stalls.
  const key=site.lat.toFixed(4)+':'+site.lon.toFixed(4)+':'+operatorKey(site.operator)+':'+(site.ccs2?'CCS2':'AC');
  const old=groups.get(key),item={...site,...projected};
  if(!old)groups.set(key,{...item,alternative_evse_ids:[]});
  else if((site.power_kw||0)>(old.power_kw||0))groups.set(key,{...item,alternative_evse_ids:[old.id,...old.alternative_evse_ids]});
  else old.alternative_evse_ids.push(site.id);
 }
 const ordered=[...groups.values()].sort((a,b)=>a.progress_m-b.progress_m||a.corridor_m-b.corridor_m);
 // Sample geographic progress, not record quantiles: dense cities must not
 // evict the sparse early/mid-route charging opportunities.
 const sample=(items,count)=>{
  if(items.length<=count)return [...items];
  const result=[],end=items.at(-1).progress_m,used=new Set();
  for(let i=0;i<count;i++){
   const anchor=end*i/Math.max(1,count-1);let best,bestScore=Infinity;
   for(const item of items){if(used.has(item))continue;
    const score=Math.abs(item.progress_m-anchor)+item.corridor_m*0.3;
    if(score<bestScore){best=item;bestScore=score;}
   }
   if(best){result.push(best);used.add(best);}
  }return result;
 };
 const dc=ordered.filter(s=>s.ccs2),ac=ordered.filter(s=>!s.ccs2);
 // AC-rich city catalogs must not displace all road-trip fast chargers.
 const acSlots=input.allowAcCharging&&dc.length&&ac.length?Math.min(ac.length,Math.max(1,Math.floor(limit/3))):0;
 const selected=acSlots?[...sample(dc,Math.min(dc.length,limit-acSlots)),...sample(ac,Math.min(ac.length,limit-Math.min(dc.length,limit-acSlots)))]:sample(ordered,limit);
 selected.sort((a,b)=>a.progress_m-b.progress_m);
 return {selected,total:ordered.length,truncated};
}
export async function computeNationalPlan({input,catalog,line,maps,route,baseResult,choosePath,estimate,deadline=Infinity}){
 const waypoints=input.stops||[],stationStart=2+waypoints.length;
 const stages=[],base={...baseResult,station_data:{countries:catalog.countries,sources:catalog.sources||[],attribution:catalog.attribution,coverage_complete:false},charging_data_available:catalog.stations.length>0};
 let last=[],lastReason='no_national_compatible_sites',bestAlternative=[];
 for(const radius of [2000,5000,10000]){
  if(Date.now()>=deadline){lastReason='request_budget_exhausted';break;}
  const {selected,total,truncated}=selectCandidates(catalog.stations,line,radius,12,{deadline,input});
  last=selected;
  const stage={corridor_metres:radius,mapped_locations:total,selected_locations:selected.length,candidate_selection_limited:truncated||total>selected.length,mapped_location_count_partial:truncated};stages.push(stage);
  if(truncated){lastReason='request_budget_exhausted';break;}
  if(!selected.length)continue;
  const points=[input.origin,input.destination,...waypoints,...selected];
  try{
   const table=await maps.routing('/table/v1/driving/'+points.map(p=>p.lon+','+p.lat).join(';')+'?annotations=distance',d=>d.code==='Ok'&&Array.isArray(d.distances)&&d.distances.length===points.length&&d.distances.every(row=>Array.isArray(row)&&row.length===points.length&&row.every(v=>v===null||typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=10000000)));
   const matrix=table.distances;
   bestAlternative=selected.map((s,i)=>({...s,road_distance_from_origin_km:matrix[0][i+stationStart]===null?null:matrix[0][i+stationStart]/1000,
    road_detour_via_destination_km:[matrix[0][i+stationStart],matrix[i+stationStart][1],matrix[0][1]].every(v=>v!==null)?Math.max(0,(matrix[0][i+stationStart]+matrix[i+stationStart][1]-matrix[0][1])/1000):null}));
   const policy=chargingPolicy(input),searchInput={...input,waypointCount:waypoints.length,deadline,consumptionKwhPer100Km:input.consumptionKwhPer100Km*(1+policy.consumption_margin_percent/100)};
   searchInput.stationChargingLimits=points.map(s=>s.connectorType==='AC'&&s.ccs2!==true?
     Math.floor((chargingPower(s,input)||0)*input.maximumAcStopMinutes/30*(input.efficiencyPercent??0)/100):null);
   const choice=choosePath({...searchInput,distances:matrix});
   stage.path_found=choice.found;stage.search_truncated=!!choice.search_truncated;
   if(!choice.found){lastReason='no_feasible_path_in_selected_candidates';continue;}
   const paths=[choice.path],seen=new Set([JSON.stringify(choice.path)]);
   if(input.objective==='cost'&&policy.efficiency_percent!==null){
    const priced=points.map((site,i)=>i<stationStart||false);
    const pricedMatrix=matrix.map((row,i)=>row.map((v,j)=>priced[i]&&priced[j]?v:null));
    const alternative=choosePath({...searchInput,distances:pricedMatrix});
    const key=JSON.stringify(alternative.path);
    if(alternative.found&&!seen.has(key)){paths.push(alternative.path);seen.add(key);}
   }
   for(const blocked of [...new Set(choice.path.filter(i=>i>=stationStart))]){
    if(paths.length>=3)break;
    const masked=matrix.map((row,i)=>row.map((v,j)=>i===blocked||j===blocked?null:v));
    const alternative=choosePath({...searchInput,distances:masked});
    if(alternative.found&&!seen.has(JSON.stringify(alternative.path))){paths.push(alternative.path);seen.add(JSON.stringify(alternative.path));}
   }
   const plans=[];
   for(const path of paths){
    try{
     const final=await route(path.map(i=>points[i]),'false');
     const optimized=optimizePathCharging({input,legs:final.legs,path,points,stationStart});
     if(!optimized.feasible)continue;
     plans.push({final,optimized,path});
    }catch{stage.alternative_verification_incomplete=true;break;}
   }
   if(!plans.length){lastReason='final_route_breaches_reserve_or_arrival_soc';continue;}
   const allTime=plans.every(p=>p.optimized.theoretical_minimum_charging_minutes!==null),allCost=plans.every(p=>p.optimized.estimated_cost_eur!==null);
   let objective=input.objective||'balanced';
   // Unknown prices never become zero or invalidate comparisons among known quotes.
   // Prefer an affordable known-price plan only inside explicit convenience bounds.
   const shortest=Math.min(...plans.map(p=>p.final.distance)),fastestDrive=Math.min(...plans.map(p=>p.final.duration));
   const convenience={maximum_extra_distance_km:5,maximum_extra_driving_minutes:15};
   const knownComparable=plans.filter(p=>p.optimized.estimated_cost_eur!==null&&
     p.final.distance<=shortest+convenience.maximum_extra_distance_km*1000&&
     p.final.duration<=fastestDrive+convenience.maximum_extra_driving_minutes*60);
   const partialEconomic=objective==='cost'&&!allCost&&knownComparable.length>0;
   const economicEligible=new Set(knownComparable);
   if(objective==='cost'&&!allCost&&!partialEconomic||objective==='time'&&!allTime)objective='energy';
   const preferredStops=p=>input.preferFreeToXMotorway===false?0:p.optimized.stops.filter(s=>operatorKey(s.operator)==='freetox'&&s.motorway_access==='reported').length;
   const rank=p=>{
    const o=p.optimized,km=p.final.distance/1000,time=p.final.duration/60+(o.theoretical_minimum_charging_minutes||0);
    return objective==='cost'?[partialEconomic&&!economicEligible.has(p)?1:0,o.estimated_cost_eur??Infinity,o.minimum_purchased_kwh,km,-preferredStops(p)]:objective==='time'?[time,o.charging_stops,km,-preferredStops(p)]:
     objective==='energy'?[o.minimum_purchased_kwh,o.charging_stops,km,-preferredStops(p)]:[o.charging_stops,km,o.minimum_purchased_kwh,allTime?time:0,-preferredStops(p)];
   };
   plans.sort((a,b)=>{const x=rank(a),y=rank(b);for(let i=0;i<x.length;i++)if(Math.abs(x[i]-y[i])>1e-9)return x[i]-y[i];return 0;});
   const {final,optimized,path}=plans[0];
   const pricedPlans=plans.filter(p=>p.optimized.estimated_cost_eur!==null);
   const lowestPriced=pricedPlans.sort((a,b)=>a.optimized.estimated_cost_eur-b.optimized.estimated_cost_eur||a.final.distance-b.final.distance)[0];
   return {...base,source:(catalog.sources||[]).some(s=>s.country==='OSM'&&s.status==='ok')?'NATIONAL_OSM_CCS2_ROAD_ROUTE':'NATIONAL_CCS2_ROAD_ROUTE',distance_km:final.distance/1000,direct_distance_km:base.distance_km,
    road_detour_km:Math.max(0,final.distance/1000-base.distance_km),duration_minutes_without_live_traffic:final.duration/60,
    energy:estimate({...input,distanceKm:final.distance/1000}),legs:optimized.legs,sites:bestAlternative,
    coverage:{complete:false,exhaustive:false,search_stages:stages,limitation:'Only bounded candidates/alternatives tested; live access and occupancy unknown.'},
    navigation_destinations:path.slice(1).map(index=>({lat:points[index].lat,lon:points[index].lon})),
    navigation_handoff:{command:'navigation_request',via_existing_tool:'execute_requested_vehicle_command',requires_explicit_user_request:true,sent_to_vehicle:false,multi_stop_transport_supported:false,next_destination:{lat:points[path[1]].lat,lon:points[path[1]].lon}},
    charging_plan:{...optimized,lowest_priced_verified_alternative:lowestPriced?{
      station_ids:lowestPriced.optimized.stops.map(s=>s.id),estimated_cost_eur:lowestPriced.optimized.estimated_cost_eur,
      distance_km:lowestPriced.final.distance/1000}:null,objective_used:objective,objective_limited:partialEconomic||optimized.objective_limited||objective!==(input.objective||'balanced'),economic_comparison:{scope:allCost?'verified_alternatives_with_known_tariffs':partialEconomic?'known_tariffs_within_convenience_bounds':'unavailable',unknown_price_alternatives:plans.filter(p=>p.optimized.estimated_cost_eur===null).length,convenience_bounds:convenience,global_cheapest_verified:false},planned_road_energy_kwh:optimized.legs.reduce((sum,l)=>sum+l.energy_kwh,0),
     alternatives:plans.map(p=>({station_ids:p.optimized.stops.map(s=>s.id),charging_stops:p.optimized.charging_stops,distance_km:p.final.distance/1000,
      road_detour_km:Math.max(0,p.final.distance/1000-base.distance_km),energy_to_battery_kwh:p.optimized.energy_to_battery_kwh,
      estimated_purchased_kwh:p.optimized.estimated_purchased_kwh,estimated_cost_eur:p.optimized.estimated_cost_eur,
      price_status:p.optimized.estimated_cost_eur===null?'unknown':'personal_contract_estimate',operators:p.optimized.stops.map(s=>s.operator),motorway_free_to_x_stops:preferredStops(p),
      theoretical_minimum_total_minutes:p.optimized.theoretical_minimum_charging_minutes===null?null:p.final.duration/60+p.optimized.theoretical_minimum_charging_minutes,
      estimated_arrival_kwh:p.optimized.estimated_arrival_kwh})),
     comparison_limits:[...(!allCost?[partialEconomic?'Only known-price alternatives within explicit detour bounds are ranked economically; unknown-price plans are retained, not assumed more expensive.':'Tariffs or charging efficiency missing: no economic ranking.']:[]),...(!allTime?['Some station powers unknown: no time ranking.']:[]),'Nameplate-power times are lower bounds, not a Tesla charging curve.','Free To X motorway preference is a tie-break only when access is reported; no unknown motorway access or cheaper price assumed.'],
     selection_basis:'bounded_alternatives_with_minimum_required_charging; requested objective, explicit reserve and arrival SOC'}};

  }catch{stage.routing_available=false;lastReason='national_candidate_routing_unavailable';break;}
 }
 return {...base,sites:bestAlternative.length?bestAlternative:last,coverage:{complete:false,exhaustive:false,search_stages:stages},
  charging_plan:{feasible:null,stops:[],reason:lastReason},limitation:'No energetically verified plan in this limited catalog/search. This is not proof that no feasible route exists.'};
}
