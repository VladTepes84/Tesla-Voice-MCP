import { route } from '../../../lib/runtime.mjs';
// Explicit same-origin consent gates the read-only Tesla Partner public-key check.
export default { fetch: route('partnerKeyCheck') };
