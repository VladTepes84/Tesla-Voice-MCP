import test from 'node:test';
import assert from 'node:assert/strict';
import { chargingPreferences, preferencesTools } from './lib/charging-preferences.mjs';
import { hash, seal } from './lib/security.mjs';

test('saved preferences reject personal tariffs while retaining trip settings', async () => {
 const rows=new Map(), config={issuer:'https://issuer.example.invalid/',key:Buffer.alloc(32,4)};
 const store={get:async k=>rows.get(k)??null, lock:async k=>({savePermanent:async v=>rows.set(k,v),release:async()=>{}})};
 const prefs=chargingPreferences({config,store,now:()=>0});
 await assert.rejects(prefs.set('user',{personalConnectorTariffs:{ac:{eurPerKwh:1,flatEur:1},dc:{eurPerKwh:1,flatEur:1}}}),/invalid_charging_preferences/);
 await assert.rejects(prefs.set('user',{personalTariffs:[]}),/invalid_charging_preferences/);
 assert.equal(Object.hasOwn(preferencesTools[1].inputSchema.properties,'personalTariffs'),false);
 await prefs.set('user',{reservePercent:20});
 assert.equal((await prefs.get('user')).preferences.reservePercent,20);
 const key='charging-preferences:'+hash(config.issuer+'\nuser');
 rows.set(key,seal({preferences:{reservePercent:25,freeToX:{private:'ignored'},personalTariffs:[{private:'ignored'}]},updated_at:null},config.key,key));
 assert.deepEqual((await prefs.get('user')).preferences,{reservePercent:25});
});
