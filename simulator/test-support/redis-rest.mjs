import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';

function decode(buffer, offset = 0) {
  const end = buffer.indexOf('\r\n', offset);
  if (end < 0) return;
  const type = String.fromCharCode(buffer[offset]), value = buffer.toString('utf8', offset + 1, end), next = end + 2;
  if (type === '+') return { value, next };
  if (type === '-') return { error: value, next };
  if (type === ':') return { value: Number(value), next };
  if (type === '$') {
    const size = Number(value);
    if (size === -1) return { value: null, next };
    if (buffer.length < next + size + 2) return;
    return { value: buffer.toString('utf8', next, next + size), next: next + size + 2 };
  }
  if (type === '*') {
    if (Number(value) === -1) return { value: null, next };
    const items = []; let cursor = next;
    for (let i = 0; i < Number(value); i++) {
      const part = decode(buffer, cursor); if (!part) return;
      if (part.error) return part;
      items.push(part.value); cursor = part.next;
    }
    return { value: items, next: cursor };
  }
  throw Error('invalid_test_resp');
}
export async function localRedis() {
  const dir = await mkdtemp(join(tmpdir(), 'tesla-command-status-')), socket = join(dir, 'redis.sock');
  const binary = process.env.TESLA_TEST_REDIS_SERVER || 'redis-server';
  const child = spawn(binary, ['--port','0','--unixsocket',socket,'--unixsocketperm','700','--save','','--appendonly','no','--loglevel','warning'], { stdio: ['ignore','pipe','pipe'] });
  let startupError; child.on('error', error => { startupError = error; });
  const command = (...args) => new Promise((resolve, reject) => {
    const connection = createConnection(socket); let bytes = Buffer.alloc(0);
    connection.on('error', reject); connection.setTimeout(2000, () => connection.destroy(Error('test_redis_timeout')));
    connection.on('connect', () => {
      const chunks = [Buffer.from('*' + args.length + '\r\n')];
      for (const arg of args) { const data = Buffer.from(String(arg)); chunks.push(Buffer.from('$'+data.length+'\r\n'),data,Buffer.from('\r\n')); }
      connection.write(Buffer.concat(chunks));
    });
    connection.on('data', data => {
      bytes = Buffer.concat([bytes,data]); const response = decode(bytes);
      if (response) { connection.end(); response.error ? reject(Error(response.error)) : resolve(response.value); }
    });
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (startupError) break;
    try { ready = await command('PING') === 'PONG'; if (ready) break; } catch { /* Wait for this local child only. */ }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  if (!ready) { child.kill(); await rm(dir,{recursive:true,force:true}); throw Error('Redis integration requires a local redis-server: ' + (startupError?.code || 'startup_failed')); }
  const calls = [];
  return { command, calls, socket,
    // Only the REST envelope is adapted. Redis executes the actual commands/Lua.
    fetcher: async (url, options) => {
      if (url !== 'https://redis.fixture.invalid/' || options.headers.authorization !== 'Bearer fixture-store' || options.redirect !== 'error') throw Error('unexpected_redis_transport');
      const args = JSON.parse(options.body); calls.push(args);
      try { return Response.json({ result: await command(...args) }); }
      catch (error) { return Response.json({ error: error.message }); }
    },
    close: async () => { const exited = new Promise(resolve => child.once('exit',resolve)); child.kill('SIGTERM'); await exited; await rm(dir,{recursive:true,force:true}); }
  };
}
