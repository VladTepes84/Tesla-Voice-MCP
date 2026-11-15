// OpenStreetMap charging stations are candidates, not verified availability.
const positive = v => /^(yes|[1-9]\d*)$/i.test(String(v ?? ''));
const clean = v => String(v ?? '').replace(/[\x00-\x1f<>]/g, ' ').slice(0, 200);
export function normalizeOsmCharging(data, {includeAc=false}={}) {
 if (!Array.isArray(data?.elements) || data.remark) throw Error('invalid_osm_charging');
 return data.elements.flatMap(e => {
  const t=e.tags||{}, lat=e.lat??e.center?.lat, lon=e.lon??e.center?.lon;
  if (!['node','way','relation'].includes(e.type) || !Number.isSafeInteger(e.id) || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat)>90 || Math.abs(lon)>180 || ['private','no','customers'].includes(String(t.access||'').toLowerCase()) || ['yes','true','1'].includes(String(t.disused||'').toLowerCase()) || t.operational_status==='broken') return [];
  const types=[...(positive(t['socket:type2_combo'])?['CCS2']:[]),
   ...(['socket:chademo','socket:type1_combo','socket:tesla_supercharger'].some(k=>positive(t[k]))?['DC']:[]),
   ...(includeAc&&['socket:type2','socket:type1','socket:schuko','socket:cee_7_4','socket:BS1363'].some(k=>positive(t[k]))?['AC']:[])];
  return types.map(connectorType=>({id:`osm:${e.type}:${e.id}:${connectorType}`,lat,lon,name:clean(t.name),operator:clean(t.operator||t.brand),network:clean(t.network),brand:clean(t.brand),connectorType,ccs2:connectorType==='CCS2',power_kw:null,availability:'unknown',tariff:null,source:'OPENSTREETMAP',source_url:`https://www.openstreetmap.org/${e.type}/${e.id}`,source_updated_at:e.timestamp||null,fetched_at:new Date().toISOString(),motorway_access:'unknown'}));
 });
}
export function osmAreaQuery(center, radiusKm) {
 if (!Number.isFinite(center?.lat)||!Number.isFinite(center?.lon)||Math.abs(center.lat)>90||Math.abs(center.lon)>180||!Number.isFinite(radiusKm)||radiusKm<1||radiusKm>20) throw Error('invalid_map_arguments');
 return `[out:json][timeout:6];nwr[amenity=charging_station](around:${Math.round(radiusKm*1000)},${center.lat},${center.lon});out meta center 500;`;
}
