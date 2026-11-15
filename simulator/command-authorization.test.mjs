import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommandAuthorization } from './lib/command-authorization.mjs';

function memoryStore() {
  const items = new Map();
  return {
    items,
    async put(key, value) { items.set(key, value); },
    async get(key) { return items.get(key) ?? null; },
    async take(key) { const value = items.get(key) ?? null; items.delete(key); return value; }
  };
}

test('vehicle command ticket binds owner, vehicle, operation and exact arguments; phrase is one-use', async () => {
  let time = 1_800_000_000_000;
  const store = memoryStore();
  const authorization = createCommandAuthorization({ store, key: Buffer.alloc(32, 9), now: () => time });
  const prepared = await authorization.prepare('owner-a', 'a'.repeat(43), 'set_charge_limit', { percent: 80 });
  assert.equal(prepared.execution_enabled, false);
  assert.equal(prepared.confirmation_required, true);
  assert.equal(prepared.confirmation_phrase, `CONFERMO set_charge_limit ${prepared.ticket.slice(0, 6)}`);

  await assert.rejects(authorization.confirm('owner-b', prepared.ticket, prepared.confirmation_phrase), /owner_mismatch/);
  await assert.rejects(authorization.confirm('owner-a', prepared.ticket, 'CONFERMO door_unlock 000000'), /phrase_mismatch/);
  assert.equal(store.items.size, 1, 'invalid confirmation attempts do not consume a valid ticket');

  const confirmed = await authorization.confirm('owner-a', prepared.ticket, prepared.confirmation_phrase);
  assert.equal(confirmed.operation, 'set_charge_limit');
  assert.deepEqual(confirmed.args, { percent: 80 });
  assert.equal(confirmed.vehicle_fingerprint, 'a'.repeat(43));
  assert.equal(confirmed.owner_confirmed, true);
  assert.equal(confirmed.execution_enabled, false);
  await assert.rejects(authorization.confirm('owner-a', prepared.ticket, prepared.confirmation_phrase), /expired|used/);
});

test('expired tickets cannot authorize commands', async () => {
  let time = 1_800_000_000_000;
  const authorization = createCommandAuthorization({ store: memoryStore(), key: Buffer.alloc(32, 4), now: () => time });
  const prepared = await authorization.prepare('owner', 'b'.repeat(43), 'door_lock', {});
  time += 120_001;
  await assert.rejects(authorization.confirm('owner', prepared.ticket, prepared.confirmation_phrase), /expired/);
});

test('asynchronous waypoint validation keeps Google ID proofs bound to the command owner',async()=>{
 const ids=['GoogleAlpha0001','GoogleBeta0001'];
 const args={waypoints:ids.map(id=>'refId:'+id).join(',')};
 const authorization=createCommandAuthorization({store:memoryStore(),key:Buffer.alloc(32,12),
  operationOptions:async(subject,operation,receivedArgs)=>{
   assert.equal(operation,'navigation_waypoints_request');assert.deepEqual(receivedArgs,args);
   return {nativeWaypointsEnabled:true,googlePlacesVerifiedIds:subject==='owner-a'?ids:[]};
  }});
 const prepared=await authorization.prepare('owner-a','c'.repeat(43),'navigation_waypoints_request',args);
 const confirmed=await authorization.confirm('owner-a',prepared.ticket,prepared.confirmation_phrase);
 assert.deepEqual(confirmed.args,args);assert.equal(confirmed.execution_enabled,false);
 await assert.rejects(authorization.prepare('owner-b','c'.repeat(43),'navigation_waypoints_request',args),/place_id_unverified/);
});
