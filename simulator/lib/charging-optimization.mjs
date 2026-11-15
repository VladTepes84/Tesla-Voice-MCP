// Fixed road path, conservative half-kWh inventory. SOC target is a ceiling.
const finite=(x,a,b)=>typeof x==='number'&&Number.isFinite(x)&&x>=a&&x<=b;
export function chargingPower(site,input){
 if(!finite(site?.power_kw,0.1,1000))return null;
 if(site.connectorType==='AC'&&site.ccs2!==true){
  if(input.allowAcCharging!==true||!finite(input.vehicleAcPowerKw,0.1,100)||!finite(input.efficiencyPercent,1,100))return null;
  return Math.min(site.power_kw,input.vehicleAcPowerKw);
 }
 return site.power_kw;
}
export function chargingPolicy(input){
 if(input.allowAcCharging!==undefined&&typeof input.allowAcCharging!=='boolean'||
  input.vehicleAcPowerKw!==undefined&&!finite(input.vehicleAcPowerKw,0.1,100)||
  input.maximumAcStopMinutes!==undefined&&!finite(input.maximumAcStopMinutes,1,1440)||
  input.allowAcCharging===true&&(!finite(input.vehicleAcPowerKw,0.1,100)||!finite(input.maximumAcStopMinutes,1,1440)||!finite(input.efficiencyPercent,1,100)))throw Error('invalid_map_arguments');
 const arrival=input.arrivalPercent??input.reservePercent,margin=input.consumptionMarginPercent??5;
 if(!finite(arrival,input.reservePercent,100)||!finite(margin,0,50)||
   input.efficiencyPercent!==undefined&&!finite(input.efficiencyPercent,1,100)||
   input.objective!==undefined&&!['balanced','energy','time','cost'].includes(input.objective))throw Error('invalid_map_arguments');
 if(input.batterySource!==undefined&&!['user_supplied','simulated','cached','live'].includes(input.batterySource)||input.preferFreeToXMotorway!==undefined&&typeof input.preferFreeToXMotorway!=='boolean')throw Error('invalid_map_arguments');
 if(input.batterySampledAt!==undefined&&(typeof input.batterySampledAt!=='string'||!Number.isFinite(Date.parse(input.batterySampledAt))||Date.parse(input.batterySampledAt)>Date.now()+60000)||['cached','live'].includes(input.batterySource)&&!input.batterySampledAt)throw Error('invalid_map_arguments');
 return {arrival_percent:arrival,maximum_charging_soc_percent:input.chargingTargetPercent,reserve_percent:input.reservePercent,consumption_margin_percent:margin,
  efficiency_percent:input.efficiencyPercent??null,objective:input.objective??'balanced',energy_grid_kwh:0.5,ac_charging_enabled:input.allowAcCharging===true,vehicle_ac_power_kw:input.vehicleAcPowerKw??null,maximum_ac_stop_minutes:input.maximumAcStopMinutes??null,
  limitation:'Constant consumption with explicit margin; charging times are ideal lower bounds at station nameplate power, not a charging curve.'};
}
export function optimizePathCharging({input,legs,path,points,stationStart=2}){
 const policy=chargingPolicy(input),cap=input.usableCapacityKwh;
 if(legs.length!==path.length-1||legs.some(l=>!finite(l.distance,0,10000000)||!finite(l.duration,0,10000000)))return {feasible:false,reason:'invalid_road_legs',policy};
 const initial=Math.floor(cap*input.batteryPercent/50),maximum=Math.floor(cap*input.chargingTargetPercent/50),reserve=Math.ceil(cap*input.reservePercent/50),arrival=Math.ceil(cap*policy.arrival_percent/50);
 const costs=legs.map(l=>Math.ceil(l.distance*input.consumptionKwhPer100Km*(1+policy.consumption_margin_percent/100)/50000));
 const stations=path.slice(1).filter(i=>i>=stationStart).map(i=>points[i]);
 // No station price is assumed in the absence of a verified public source.
 const tariff=()=>null;
 const powerKnown=stations.every(s=>chargingPower(s,input)!==null);
 const pricesKnown=policy.efficiency_percent!==null&&stations.every(s=>!!tariff(s));
 const objective=policy.objective==='time'&&!powerKnown||policy.objective==='cost'&&!pricesKnown?'energy':policy.objective;
 const score=s=>objective==='cost'?[s.cost,s.added,s.charges,powerKnown?s.minutes:0]:objective==='time'?[s.minutes,s.added,s.charges]:
  objective==='energy'?[s.added,s.charges,powerKnown?s.minutes:0]:[s.charges,s.added,powerKnown?s.minutes:0,pricesKnown?s.cost:0];
 const less=(a,b)=>{const x=score(a),y=score(b);for(let i=0;i<x.length;i++){if(Math.abs(x[i]-y[i])>1e-9)return x[i]<y[i];}return false;};
 let states=new Map([[initial,{stored:initial,added:0,cost:0,minutes:0,charges:0,stops:[],legs:[]}]]);
 for(let i=0;i<legs.length;i++){
  const next=new Map(),node=path[i+1],last=i===legs.length-1;
  for(const s of states.values()){
   const remaining=s.stored-costs[i];if(remaining<(last?Math.max(reserve,arrival):reserve))continue;
   const roadLeg={distance_km:legs[i].distance/1000,duration_minutes:legs[i].duration/60,energy_kwh:costs[i]/2,arrival_kwh:remaining/2,reserve_met:true};
   const ac=node>=stationStart&&points[node]?.connectorType==='AC'&&points[node]?.ccs2!==true;
   const effectivePower=node>=stationStart?chargingPower(points[node],input):null;
   const capacityUpper=node>=stationStart&&!last?Math.max(0,maximum-remaining):0;
   // No AC energy without explicit vehicle limit and dwell budget. Floor to grid.
   const acUpper=ac&&input.allowAcCharging===true&&effectivePower!==null?Math.floor(effectivePower*input.maximumAcStopMinutes/30*policy.efficiency_percent/100):0;
   const upper=ac?Math.min(capacityUpper,acUpper):capacityUpper;
   for(let add=0;add<=upper;add++){
    const site=points[node],energy=add/2;
    const purchased=policy.efficiency_percent===null?null:energy/(policy.efficiency_percent/100);
    const t=node>=stationStart?tariff(site,purchased):null;
    const minutes=effectivePower!==null?(ac?purchased:energy)/effectivePower*60:null;
    const cost=add&&t&&purchased!==null?t.fixedFeeEur+t.eurPerKwh*purchased:0;
    const stop=add?{...site,after_leg:i,arrival_kwh:remaining/2,arrival_percent:remaining*50/cap,energy_to_battery_kwh:energy,
     minimum_purchased_kwh:energy,estimated_purchased_kwh:purchased,estimated_cost_eur:t&&purchased!==null?cost:null,
     effective_charging_power_kw:effectivePower,charging_time_model:ac?'constant_power_at_vehicle_ac_limit':'nameplate_lower_bound_not_charging_curve',tariff_source:t?.source??'unknown',tariff_mode:t?.mode??null,theoretical_minimum_charging_minutes:minutes,
     departure_kwh:(remaining+add)/2,departure_percent:(remaining+add)*50/cap}:null;
    const value={stored:remaining+add,added:s.added+add,cost:s.cost+cost,minutes:s.minutes+(minutes||0),charges:s.charges+(add?1:0),
     stops:stop?[...s.stops,stop]:s.stops,legs:[...s.legs,roadLeg]};
    const old=next.get(value.stored);if(!old||less(value,old))next.set(value.stored,value);
   }
  }
  states=next;if(!states.size)return {feasible:false,reason:'road_path_exceeds_soc_or_reserve',policy};
 }
 let best;for(const s of states.values())if(!best||less(s,best))best=s;
 if(!best)return {feasible:false,reason:'no_energy_state',policy};
 return {feasible:true,policy,objective_used:objective,objective_limited:objective!==policy.objective,stops:best.stops,legs:best.legs,
  energy_to_battery_kwh:best.added/2,minimum_purchased_kwh:best.added/2,estimated_purchased_kwh:policy.efficiency_percent===null?null:best.added/2/(policy.efficiency_percent/100),
  estimated_cost_eur:best.stops.every(stop=>stop.estimated_cost_eur!==null)?best.cost:null,theoretical_minimum_charging_minutes:powerKnown?best.minutes:null,
  estimated_arrival_kwh:best.stored/2,estimated_arrival_percent:best.stored*50/cap,charging_stops:best.charges};
}
