import { route } from '../../../lib/runtime.mjs';
export const handleTeslaCallback = route('callback');
export default { fetch: handleTeslaCallback };
