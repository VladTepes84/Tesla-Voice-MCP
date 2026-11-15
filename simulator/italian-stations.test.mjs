import test from 'node:test';import assert from 'node:assert/strict';
import {normalizeItalianShard} from './lib/italian-stations.mjs';
import {selectCandidates} from './lib/national-routing.mjs';
const now=Date.parse('2026-11-04T12:00:00Z');
const row={id_evse:'IT*FIX*1',lat:45.5,lon:9.3,cpo:'Fixture',standard_connettore:'IEC_62196_T2_COMBO',corrente:'DC',stato:'Attivo',publication_status:'PUBLISHED',potenza_w:150000};
const doc={_source:'GSE - Piattaforma Unica Nazionale (PUN)',_source_url:'https://www.piattaformaunicanazionale.it/idr',_license:'CC BY 4.0 ex art.52',_snapshot_date:'2026-11-04',_generated_at:'2026-11-04T07:05:29Z',punti:[row]};
test('official Italian shard retains explicit CCS2, matched watts, origin and snapshot not live status',()=>{
 const [s]=normalizeItalianShard(doc,{now,url:'https://cruscotto-italia.dati.gov.it/data/pun/015146.json'});
 assert.equal(s.power_kw,150);assert.equal(s.availability,'unknown');assert.equal(s.country,'IT');assert.ok(s.source_url);assert.equal(s.record_updated_at,null);
});
test('Italian DC alone, CCS1, unpublished/out-of-order points and stale snapshots are excluded',()=>{
 for(const patch of [{standard_connettore:'CHADEMO'},{standard_connettore:'IEC_62196_T1_COMBO'},{publication_status:'WAITING_VALIDATION_DATA'},{stato:'Non Attivo'},{potenza_w:0}])
 assert.equal(normalizeItalianShard({...doc,punti:[{...row,...patch}]},{now}).length,0);
 assert.throws(()=>normalizeItalianShard({...doc,_snapshot_date:'2020-01-01'},{now}),/stale/);
});
test('geographic sampling preserves sparse early charging opportunities despite dense destination sockets',()=>{
 const sites=[{id:'early',lat:45,lon:9.1,ccs2:true},{id:'middle',lat:45,lon:9.4,ccs2:true},...Array.from({length:50},(_,i)=>({id:'end'+i,lat:45,lon:9.8+i*.003,ccs2:true}))];
 const r=selectCandidates(sites,[[9,45],[10,45]],2000,12);
 assert.ok(r.selected.some(s=>s.id==='early'));assert.ok(r.selected.some(s=>s.id==='middle'));assert.ok(r.selected.length<=12);
});
