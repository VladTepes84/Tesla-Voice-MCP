import test from 'node:test';
import assert from 'node:assert/strict';
import { reserveTeslaRequests, readTeslaRequestBudget, effectiveTeslaRequestLimit } from './lib/request-budget.mjs';
import { persistentStore } from './lib/store.mjs';

const now = () => Date.UTC(2026, 10, 1, 12);
test('budget snapshot reads all shared slots without reserving or exposing values', async () => {
  const reads = [];
  const result = await readTeslaRequestBudget({
    env: { TESLA_DAILY_READ_LIMIT: '10' }, now,
    store: { get: async key => { reads.push(key); return key.endsWith(':0') || key.endsWith(':9') ? '1' : null; } }
  });
  assert.equal(reads.length, 51);
  assert.equal(new Set(reads).size, 51);
  assert.deepEqual(result, { available: true, day_utc: '2026-11-01', limit: 10,
    reserved: 2, remaining: 8, resets_at: '2026-11-02T00:00:00.000Z', reservation: false });
});

test('budget snapshot rejects invalid configuration and uncertain storage without leaking errors', async () => {
  let reads = 0;
  const store = { get: async () => { reads++; return null; } };
  assert.deepEqual(await readTeslaRequestBudget({ store, env: { TESLA_DAILY_READ_LIMIT: '51' }, now }),
    { available: false, reason: 'configuration' });
  assert.equal(reads, 0);
  for (const get of [async () => { throw Error('PRIVATE_REDIS_ERROR'); }, async () => 'PRIVATE_UNEXPECTED_VALUE']) {
    const result = await readTeslaRequestBudget({ store: { get }, env: { TESLA_DAILY_READ_LIMIT: '10' }, now });
    assert.deepEqual(result, { available: false, reason: 'storage_or_clock' });
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  }
});

test('budget snapshot changes day at UTC midnight and counts reservations above a lowered limit', async () => {
  const env = { TESLA_DAILY_READ_LIMIT: '2' };
  const store = { get: async key => key.startsWith('read-budget:2026-11-01:') ? '1' : null };
  const before = await readTeslaRequestBudget({ store, env, now });
  assert.equal(before.reserved, 50);
  assert.equal(before.remaining, 0);
  const after = await readTeslaRequestBudget({ store, env, now: () => Date.UTC(2026, 10, 2) });
  assert.equal(after.reserved, 0);
  assert.equal(after.remaining, 2);
});
function memoryStore() {
  const keys = new Set();
  return {
    keys,
    get: async key => keys.has(key) ? '1' : null,
    once: async (key, ttl) => {
      assert.equal(ttl, 172800);
      if (keys.has(key)) return false;
      keys.add(key);
      return true;
    }
  };
}

test('multi-request flows reserve separate slots from the shared UTC-day budget', async () => {
  const store = memoryStore(), env = { TESLA_DAILY_READ_LIMIT: '3' };
  await reserveTeslaRequests({ store, env, now, count: 2 });
  await reserveTeslaRequests({ store, env, now });
  assert.deepEqual([...store.keys].sort(), [
    'read-budget:2026-11-01:0',
    'read-budget:2026-11-01:1',
    'read-budget:2026-11-01:2'
  ]);
  await assert.rejects(reserveTeslaRequests({ store, env, now }), /budget/);
  assert.equal(store.keys.size, 3);
});

test('an incomplete reservation never permits callers to start a multi-request flow', async () => {
  const store = memoryStore(), env = { TESLA_DAILY_READ_LIMIT: '10' };
  for (let slot = 0; slot < 9; slot++) store.keys.add(`read-budget:2026-11-01:${slot}`);
  let outbound = 0;
  await assert.rejects(async () => {
    await reserveTeslaRequests({ store, env, now, count: 2 });
    outbound++;
  }, /budget/);
  assert.equal(outbound, 0);
  assert.equal(store.keys.size, 10);
});

test('concurrent multi-request reservations cannot exceed the configured daily cap', async () => {
  const store = memoryStore(), env = { TESLA_DAILY_READ_LIMIT: '10' };
  let outbound = 0;
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, async () => {
    await reserveTeslaRequests({ store, env, now, count: 2 });
    outbound += 2;
  }));
  assert.ok(attempts.filter(x => x.status === 'fulfilled').length <= 5);
  assert.ok(outbound <= 10);
  assert.ok(store.keys.size <= 10);
});

test('invalid limits and unavailable Redis fail closed before reserving a slot', async () => {
  const store = memoryStore();
  for (const env of [
    {},
    { TESLA_DAILY_READ_LIMIT: '0' },
    { TESLA_DAILY_READ_LIMIT: '51' },
    { TESLA_DAILY_READ_LIMIT: '1' }
  ]) {
    await assert.rejects(reserveTeslaRequests({ store, env, now, count: env.TESLA_DAILY_READ_LIMIT === '1' ? 2 : 1 }), /configuration/);
  }
  await assert.rejects(reserveTeslaRequests({ env: { TESLA_DAILY_READ_LIMIT: '10' }, now }), /budget_store_unavailable/);
  assert.equal(store.keys.size, 0);
});

const env50 = { TESLA_DAILY_READ_LIMIT: '50' };

test('hard ceiling accepts fifty and rejects invalid limits', () => {
  for (const limit of [1, 10, 20, 50])
    assert.equal(effectiveTeslaRequestLimit({ TESLA_DAILY_READ_LIMIT: String(limit) }, now()), limit);
  for (const limit of ['', '0', '51', 'NaN'])
    assert.ok(Number.isNaN(effectiveTeslaRequestLimit({ TESLA_DAILY_READ_LIMIT: limit }, now())));
  assert.ok(Number.isNaN(effectiveTeslaRequestLimit(env50, NaN)));
  assert.equal(effectiveTeslaRequestLimit({ VERCEL_ENV: 'production', TESLA_DAILY_READ_LIMIT: '50' }, now()), Infinity);
  assert.equal(effectiveTeslaRequestLimit({ VERCEL_ENV: 'production' }, now()), Infinity);
  assert.ok(Number.isNaN(effectiveTeslaRequestLimit({ VERCEL_ENV: 'production' }, NaN)));
});

test('budget snapshot scans all fifty slots and preserves reservations if the limit is lowered', async () => {
  const store = memoryStore();
  for (let slot = 0; slot < 20; slot++) store.keys.add(`read-budget:2026-11-01:${slot}`);
  let reads = 0;
  store.get = async key => { reads++; return store.keys.has(key) ? '1' : null; };
  const raised = await readTeslaRequestBudget({ store, env: env50, now });
  assert.equal(reads, 51);
  assert.equal(raised.limit, 50);
  assert.equal(raised.reserved, 20);
  assert.equal(raised.remaining, 30);
  const lowered = await readTeslaRequestBudget({ store, env: { TESLA_DAILY_READ_LIMIT: '10' }, now });
  assert.equal(lowered.reserved, 20);
  assert.equal(lowered.remaining, 0);
});

test('fifty existing reservations block all new requests without being reset', async () => {
  const store = memoryStore();
  for (let slot = 0; slot < 50; slot++) store.keys.add(`read-budget:2026-11-01:${slot}`);
  store.get = async key => store.keys.has(key) ? '1' : null;
  const attempts = await Promise.allSettled(Array.from({ length: 40 }, () =>
    reserveTeslaRequests({ store, env: env50, now })));
  assert.equal(attempts.filter(x => x.status === 'fulfilled').length, 0);
  assert.equal(store.keys.size, 50);
  assert.equal((await readTeslaRequestBudget({ store, env: env50, now })).remaining, 0);
  await assert.rejects(reserveTeslaRequests({ store, env: env50, now }), /budget/);
  assert.equal(store.keys.size, 50);
});

test('fifty-request budget admits exactly fifty concurrent callers', async () => {
  const store = memoryStore();
  const attempts = await Promise.allSettled(Array.from({ length: 70 }, () =>
    reserveTeslaRequests({ store, env: env50, now })));
  assert.equal(attempts.filter(x => x.status === 'fulfilled').length, 50);
  assert.equal(store.keys.size, 50);
  await assert.rejects(reserveTeslaRequests({ store, env: env50, now }), /budget/);
});

test('multi-request flows share the fifty-request ceiling', async () => {
  const store = memoryStore();
  for (let request = 0; request < 25; request++)
    await reserveTeslaRequests({ store, env: env50, now, count: 2 });
  assert.equal(store.keys.size, 50);
  await assert.rejects(reserveTeslaRequests({ store, env: env50, now, count: 2 }), /budget/);
});

test('sparse reservations in historical slots reduce concurrent capacity', async () => {
  const store = memoryStore();
  for (const slot of [12, 24, 49]) store.keys.add(`read-budget:2026-11-01:${slot}`);
  const attempts = await Promise.allSettled(Array.from({ length: 60 }, () =>
    reserveTeslaRequests({ store, env: env50, now })));
  assert.equal(attempts.filter(x => x.status === 'fulfilled').length, 47);
  assert.equal(store.keys.size, 50);
  assert.ok(store.keys.has('read-budget:2026-11-01:12'));
  assert.ok(store.keys.has('read-budget:2026-11-01:24'));
  assert.ok(store.keys.has('read-budget:2026-11-01:49'));
});

test('high historical slots still count when lower slots are empty', async () => {
  const store = memoryStore();
  for (let slot = 30; slot < 40; slot++) store.keys.add(`read-budget:2026-11-01:${slot}`);
  const attempts = await Promise.allSettled(Array.from({ length: 50 }, () =>
    reserveTeslaRequests({ store, env: env50, now })));
  assert.equal(attempts.filter(x => x.status === 'fulfilled').length, 40);
  assert.equal(store.keys.size, 50);
  for (let slot = 30; slot < 40; slot++) assert.ok(store.keys.has(`read-budget:2026-11-01:${slot}`));
});

function redisRestSimulator(day, existingSlots = []) {
  const prefix = 'tesla-voice:v1:';
  const values = new Map(existingSlots.map(slot => [
    `${prefix}read-budget:${day}:${slot}`, '1'
  ]));
  const commands = [];
  const fetcher = async (url, options) => {
    assert.equal(String(url), 'https://redis.simulator.invalid/');
    assert.equal(options.method, 'POST');
    const args = JSON.parse(options.body);
    commands.push(args[0]);
    let result;
    if (args[0] === 'GET') {
      result = values.get(args[1]) ?? null;
    } else if (args[0] === 'EVAL') {
      const [, script, keyCount, ...rest] = args;
      assert.match(script, /redis\.call\('GET',KEYS\[i\]\)/);
      assert.match(script, /used\+n>tonumber\(ARGV\[1\]\)/);
      assert.match(script, /redis\.call\('SET',free\[i\],'1','EX',172800\)/);
      const keys = rest.slice(0, Number(keyCount));
      const limit = Number(rest[keys.length]);
      const count = Number(rest[keys.length + 1]);
      let used = 0;
      const free = [];
      for (let i = 0; i < keys.length; i++) {
        const value = values.get(keys[i]);
        if (value !== undefined) {
          if (value !== '1') { result = -1; break; }
          used++;
        } else if (i < limit) {
          free.push(keys[i]);
        }
      }
      if (result === undefined) {
        if (used + count > limit || free.length < count) {
          result = 0;
        } else {
          for (let i = 0; i < count; i++) values.set(free[i], '1');
          result = 1;
        }
      }
    } else {
      throw Error('unsupported_simulated_redis_command');
    }
    return new Response(JSON.stringify({ result }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  };
  const store = persistentStore({
    TOKEN_STORE_REST_URL: 'https://redis.simulator.invalid',
    TOKEN_STORE_REST_TOKEN: 'simulation-only'
  }, fetcher);
  return { store, values, commands, prefix };
}

test('Redis simulation admits fifty concurrent requests and preserves existing sparse reservations', async () => {
  const existing = [0, 2, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31, 33, 35, 37, 49];
  const { store, values, commands, prefix } = redisRestSimulator('2026-11-01', existing);
  const attempts = await Promise.allSettled(Array.from({ length: 60 }, () =>
    reserveTeslaRequests({ store, env: env50, now })));
  assert.equal(attempts.filter(x => x.status === 'fulfilled').length, 30);
  assert.equal(values.size, 50);
  for (const slot of existing)
    assert.equal(values.get(`${prefix}read-budget:2026-11-01:${slot}`), '1');
  assert.equal((await readTeslaRequestBudget({ store, env: env50, now })).remaining, 0);
  await assert.rejects(reserveTeslaRequests({ store, env: env50, now }), /budget/);
  assert.equal(values.size, 50);
  assert.ok(commands.every(command => command === 'GET' || command === 'EVAL'));
});

test('Redis simulation reserves concurrent multi-request batches atomically up to fifty', async () => {
  const { store, values } = redisRestSimulator('2026-11-01', [7, 49]);
  const attempts = await Promise.allSettled(Array.from({ length: 30 }, () =>
    reserveTeslaRequests({ store, env: env50, now, count: 2 })));
  assert.equal(attempts.filter(x => x.status === 'fulfilled').length, 24);
  assert.equal(values.size, 50);
  await assert.rejects(reserveTeslaRequests({ store, env: env50, now, count: 2 }), /budget/);
  assert.equal(values.size, 50);
});

test('persistent Redis store rejects limits above fifty before evaluating a reservation', async () => {
  const { store, values, commands } = redisRestSimulator('2026-11-01');
  await assert.rejects(store.reserveTeslaBudget('2026-11-01', 51, 1), /configuration/);
  assert.equal(commands.length, 0);
  assert.equal(values.size, 0);
});
