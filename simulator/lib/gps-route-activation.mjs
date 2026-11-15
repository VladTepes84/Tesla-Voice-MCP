import { matchesPublicOrigin } from './public-origin.mjs';
import {TESLA_P256_ORIGIN} from './partner-p256-identity.mjs';
// Selection of an EXPERIMENTAL wire schema, not proof of vehicle support.
export const GPS_ROUTE_ORDER_SCHEMA='teslemetry-2c45a2f9-replace0-append2';
export function gpsRouteCandidateEnabled(config) {
 return config.env.TESLA_GPS_ROUTE_CANDIDATE_ENABLED==='true' &&
  config.env.TESLA_GPS_ROUTE_ORDER_SCHEMA===GPS_ROUTE_ORDER_SCHEMA &&
  config.env.TESLA_FLEET_REGION==='eu' && config.env.TESLA_BACKEND_ENABLED==='true' &&
  config.env.TESLA_READ_ENABLED==='true' && config.env.TESLA_COMMANDS_ENABLED==='true' &&
  config.env.TESLA_COMMAND_EXECUTION_ENABLED==='true' && config.env.VERCEL_ENV==='production' && matchesPublicOrigin(config.origin,config.env) &&
  config.env.TESLA_REAL_RELEASE_APPROVED==='true';
}
