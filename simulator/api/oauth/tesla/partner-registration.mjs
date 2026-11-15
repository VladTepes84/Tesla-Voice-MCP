import { route } from '../../../lib/runtime.mjs';
// One-use, same-origin confirmation page. GET is read-only; only its explicit
// POST confirmation can invoke the separately gated Tesla Partner API call.
export default { fetch: route('partnerRegistration') };
