import test from 'node:test';
import assert from 'node:assert/strict';
import {parseFreeToXCardTariffs,getFreeToXCardTariffs,FREE_TO_X_CARD_SOURCE} from './lib/public-tariffs.mjs';
const html='<h2>Costi di ricarica con carta alle stazioni Free To X</h2><h3>Corrente Alternata</h3><p>€0,50/kWh</p><h3>Corrente Continua</h3><p>€0,65/kWh</p><h3>Ricarica ad Alta Potenza</h3><p>€0,79/kWh</p><h3>Quanto costa ricaricare con carta?</h3><p>AC: €0,50/kWh</p>';
test('public tariffs retain payment method, official source and retrieval time',async()=>{
  const r=await getFreeToXCardTariffs({now:()=>Date.UTC(2026,10,3),fetcher:async(url,opts)=>{
    assert.equal(url,FREE_TO_X_CARD_SOURCE);assert.equal(opts.redirect,'error');assert.equal(opts.cache,'no-store');return new Response(html);
  }});
  assert.deepEqual(r.tariffs.map(t=>t.eurPerKwh),[0.5,0.65,0.79]);assert.equal(r.payment_method,'direct_card_POS');
  assert.equal(r.retrieved_at,'2026-11-03T00:00:00.000Z');assert.equal(r.station_price_verified,false);
});
test('missing, duplicated and malformed official prices fail without defaults',()=>{
  for(const v of [html.replace('€0,65/kWh','not available'),html.replace('€0,65/kWh','€-1,00/kWh'),html.replace('<h3>Quanto costa','Corrente Continua €0,65/kWh <h3>Quanto costa'),'unrelated'])assert.throws(()=>parseFreeToXCardTariffs(v),/tariff_provider_unavailable/);
});
test('provider rejection never returns remote content or retries',async()=>{
  let calls=0;
  await assert.rejects(getFreeToXCardTariffs({fetcher:async()=>{calls++;return new Response('PRIVATE',{status:503});}}),/^Error: tariff_provider_unavailable$/);
  assert.equal(calls,1);
});
