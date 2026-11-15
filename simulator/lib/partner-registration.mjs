import { configuredPublicOrigin, configuredPartnerDomain, matchesPublicOrigin } from './public-origin.mjs';
// Invoked only by the one-use, same-origin consent page after an explicit POST.
// Tesla Partner Registration is separate from vehicle pairing and may be billable.
// Keep the owner environment gate and permanent pre-request marker fail-closed.
import { persistentStore } from './store.mjs';
import { reserveTeslaRequests } from './request-budget.mjs';
import { readStoredTeslaP256Public, TESLA_P256_ORIGIN } from './partner-p256-identity.mjs';
import { TESLA_EU_FLEET_API, TESLA_PARTNER_TOKEN_ENDPOINT,
  PARTNER_KEY_LOOKUP_RESULT_KEY, PARTNER_REGISTER_RECOVERY_MARKER } from './partner-key-recovery.mjs';
import { TESLA_PUBLIC_KEY_PATH } from '../api/tesla-public-key.mjs';

export const PARTNER_REGISTER_MARKER = 'tesla-partner-register-eu-once-explicit-consent';
export const PARTNER_REGISTER_RESULT_KEY = 'tesla-partner-register-eu-result-v1';
export const TESLA_APP_DOMAIN = 'mcp.example.invalid'; // synthetic test fixture

function checkAllowed(env, approved) {
  if (!approved || env.TESLA_PARTNER_REGISTRATION_APPROVED !== 'true' ||
      env.VERCEL_ENV !== 'production' || !matchesPublicOrigin(env.APP_ORIGIN, env) ||
      env.TESLA_FLEET_REGION !== 'eu' ||
      !env.TESLA_CLIENT_ID || !env.TESLA_CLIENT_SECRET)
    throw Error('partner_registration_not_approved');
}

async function smallPublicPem(response) {
  if (response.status !== 200 ||
      Number(response.headers.get('content-length')) > 4096 ||
      !response.body) throw Error('partner_public_key_not_hosted');
  const reader = response.body.getReader();
  const chunks=[]; let size=0;
  while(true){
    const {done,value}=await reader.read();
    if(done) break;
    size+=value.byteLength;
    if(size>4096){await reader.cancel();throw Error('partner_public_key_not_hosted');}
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function registerTeslaPartnerEUOnce({
  env = process.env, fetcher = fetch, storeFactory = persistentStore,
  readPublic = readStoredTeslaP256Public, approved = false, recovery = false
} = {}) {
  checkAllowed(env, approved);
  const store = storeFactory(env, fetcher);
  let stored;
  try { stored = await readPublic({env,storeFactory:()=>store}); }
  catch { throw Error('partner_public_key_not_ready'); }
  // Verify the exact canonical, public URL before even reserving a billable
  // Tesla request. No query, no redirect, no other host.
  let served;
  try {
    served = await smallPublicPem(await fetcher(configuredPublicOrigin(env) + TESLA_PUBLIC_KEY_PATH,{
      method:'GET',redirect:'error',signal:AbortSignal.timeout(8000),
      headers:{accept:'text/plain'}
    }));
  } catch { throw Error('partner_public_key_not_hosted'); }
  if(served !== stored.publicPem) throw Error('partner_public_key_mismatch');

  // Persist authorization consumption permanently BEFORE contacting Fleet API.
  // A recovery attempt is allowed only after the official read-only lookup
  // confirmed that no Partner key is registered for this exact domain.
  let reserved=false;
  let marker=PARTNER_REGISTER_MARKER;
  try {
    if (recovery) {
      if (await store.get(PARTNER_REGISTER_MARKER) !== '1')
        throw Error('partner_registration_recovery_not_verified');
      const raw = await store.get(PARTNER_KEY_LOOKUP_RESULT_KEY);
      let lookup;
      try { lookup = JSON.parse(raw); } catch { throw Error('partner_registration_recovery_not_verified'); }
      if (lookup?.status !== 'not_found' || lookup?.key_matches !== false)
        throw Error('partner_registration_recovery_not_verified');
      marker=PARTNER_REGISTER_RECOVERY_MARKER;
    }
    if (await store.get(marker) === '1') throw Error('partner_registration_already_reserved');
    // Token exchange and registration are two Tesla requests. Reserve both
    // before permanently consuming the separate registration authorization.
    await reserveTeslaRequests({store,env,count:2});
    reserved = await store.putOncePermanent(marker,'1');
  } catch (err) {
    if (['budget','configuration','budget_store_unavailable','partner_registration_already_reserved'].includes(err?.message))
      throw err;
    throw Error('partner_registration_reservation_failed');
  }
  if(!reserved) throw Error('partner_registration_already_reserved');

  let partnerToken;
  try {
    const grant = new URLSearchParams({
      grant_type:'client_credentials',client_id:env.TESLA_CLIENT_ID,
      client_secret:env.TESLA_CLIENT_SECRET,audience:TESLA_EU_FLEET_API,
      scope:'openid vehicle_device_data'
    });
    const response=await fetcher(TESLA_PARTNER_TOKEN_ENDPOINT,{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),
      headers:{'content-type':'application/x-www-form-urlencoded'},
      body:grant.toString()
    });
    if(response.status!==200) throw Error('not-authorized');
    const data=await response.json();
    if(typeof data?.access_token!=='string' || !data.access_token ||
       data.access_token.length>8192) throw Error('invalid-token');
    partnerToken=data.access_token;
  } catch { throw Error('partner_registration_token_failed'); }

  let response;
  try {
    response=await fetcher(TESLA_EU_FLEET_API+'/api/1/partner_accounts',{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),
      headers:{authorization:'Bearer '+partnerToken,'content-type':'application/json',
        accept:'application/json'},
      body:JSON.stringify({domain:configuredPartnerDomain(env)})
    });
  } catch { throw Error('partner_registration_network_unverified'); }
  // Return only HTTP status, safe request trace and success; never upstream
  // response body, partner token or any other account information.
  const ok=response.status>=200 && response.status<300;
  const trace=response.headers.get('x-txid');
  const result={registered:ok,status:response.status};
  if(typeof trace==='string' && /^[a-zA-Z0-9_-]{8,100}$/.test(trace))
    result.trace=trace;
  return result;
}
