import { route } from '../../../lib/runtime.mjs';
// Short-lived browser handoff, backed by single-use AES-GCM-protected ticket.
// No user secrets or Tesla tokens in the query; GET redirects to Tesla OAuth.
export default { fetch: route('launch') };
