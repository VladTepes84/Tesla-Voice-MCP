import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Local artifact preparation only: no registration, credentials, or deployment.
const root = fileURLToPath(new URL('.', import.meta.url));
const out = resolve(root, 'dist');
const config = JSON.parse(await readFile(resolve(root, '.openai/hosting.json'), 'utf8'));
if ((config.project_id !== undefined && (typeof config.project_id !== 'string' || !config.project_id)) || JSON.stringify(config.capabilities) !== '["mcp"]' || config.d1 !== null || config.r2 !== null) throw new Error('Configurazione locale inattesa');
await rm(out, { recursive: true, force: true });
await mkdir(resolve(out, 'server'), { recursive: true });
await mkdir(resolve(out, '.openai'), { recursive: true });
await copyFile(resolve(root, 'worker.mjs'), resolve(out, 'server/index.js'));
await copyFile(resolve(root, '.openai/hosting.json'), resolve(out, '.openai/hosting.json'));
console.log('Pacchetto locale preparato, non distribuito.');
