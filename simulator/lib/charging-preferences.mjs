import { hash, seal, unseal } from './security.mjs';

const number = (minimum, maximum) => ({ type: 'number', minimum, maximum });
const fields = {
  chargingMapsConsent: {type:'boolean'},
  usableCapacityKwh: number(1, 250), consumptionKwhPer100Km: number(1, 100), efficiencyPercent: number(1, 100),
  allowAcCharging: {type:'boolean'}, vehicleAcPowerKw: number(0.1,100), maximumAcStopMinutes: number(1,1440),
  reservePercent: number(0, 99), chargingTargetPercent: number(1, 100)
};
const securitySchemes = [{ type: 'oauth2', scopes: ['battery:read'] }];
export const preferencesTools = [
  { name: 'get_charging_preferences', description: 'Reads persistent charging preferences for this account. initialized=false means no values have been saved yet.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, securitySchemes,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: 'set_charging_preferences', description: 'Updates only the supplied fields in this account’s preferences. Use only values explicitly confirmed by the user. Trip plans use DC/HPC CCS2 only. Historical AC settings do not enable AC in trips; AC is available only in a separate user-requested area search using find_charging_sites with connectorType AC. Set chargingMapsConsent in a separate call: true saves revocable consent to send places and routes to public services for charging searches and trip planning; false revokes it. This does not authorize Tesla reads, navigation dispatch, or Google Places. No POS price list is imported.',
    inputSchema: { type: 'object', properties: fields, minProperties: 1, additionalProperties: false }, securitySchemes,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }
];

function exact(value, allowed) {
  return value && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).every(key => Object.hasOwn(allowed, key));
}
function validNumber(value, schema) {
  return typeof value === 'number' && Number.isFinite(value) && value >= schema.minimum && value <= schema.maximum;
}
function validate(value) {
  if (!exact(value, fields) || !Object.keys(value).length) throw Error('invalid_charging_preferences');
  for (const [key, item] of Object.entries(value)) {
    if(key==='allowAcCharging'||key==='chargingMapsConsent'){if(typeof item!=='boolean')throw Error('invalid_charging_preferences');
    } else if (!validNumber(item, fields[key])) throw Error('invalid_charging_preferences');
  }
  if ((value.chargingTargetPercent ?? 85) <= (value.reservePercent ?? 15)) throw Error('invalid_charging_preferences');
}

export function chargingPreferences({ config, store, now }) {
  const keyFor = subject => 'charging-preferences:' + hash(config.issuer + '\n' + subject);
  const consentKeyFor = subject => 'charging-map-consent:' + hash(config.issuer + '\n' + subject);
  async function get(subject) {
    const key = keyFor(subject), consentKey=consentKeyFor(subject);
    const [encrypted, consentEncrypted] = await Promise.all([store.get(key),store.get(consentKey)]);
    if (!encrypted && !consentEncrypted) return { initialized: false, preferences: null, updated_at: null };
    try {
      const record = encrypted?unseal(encrypted, config.key, key):{preferences:{},updated_at:null};
      if(encrypted) {
        const {freeToX, personalConnectorTariffs, personalTariffs, ...safePreferences} = record.preferences;
        record.preferences = safePreferences;
        if (Object.keys(safePreferences).length) validate(safePreferences);
      }
      if(consentEncrypted){
        const consent=unseal(consentEncrypted,config.key,consentKey);
        if(typeof consent.chargingMapsConsent!=='boolean')throw Error('invalid_charging_preferences');
        record.preferences={...record.preferences,chargingMapsConsent:consent.chargingMapsConsent};
      }
      return { initialized: true, ...record };
    } catch { throw Error('store'); }
  }
  async function set(subject, patch) {
    if (!exact(patch, fields) || !Object.keys(patch).length) throw Error('invalid_charging_preferences');
    if(Object.hasOwn(patch,'chargingMapsConsent')){
      if(Object.keys(patch).length!==1||typeof patch.chargingMapsConsent!=='boolean')throw Error('invalid_charging_preferences');
      const key=consentKeyFor(subject),lock=await store.lock(key);
      try {await lock.savePermanent(seal({chargingMapsConsent:patch.chargingMapsConsent},config.key,key));return await get(subject);}
      finally {await lock.release().catch(()=>{});}
    }
    const key = keyFor(subject), lock = await store.lock(key);
    try {
      const {chargingMapsConsent,...existing}=(await get(subject)).preferences||{};
      const preferences = { ...existing, ...patch };
      validate(preferences);
      const record = { preferences, updated_at: new Date(now()).toISOString() };
      await lock.savePermanent(seal(record, config.key, key));
      return await get(subject);
    } finally { await lock.release().catch(() => {}); }
  }
  return { get, set };
}

