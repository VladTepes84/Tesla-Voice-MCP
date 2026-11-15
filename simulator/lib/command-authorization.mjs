import { hash, random, seal, unseal } from './security.mjs';
import { prepareOperation } from './operation-plans.mjs';

const CONFIRMATION_TTL_SECONDS = 120;
const confirmationKey = ticket => 'vehicle-command-confirmation:' + hash(ticket);

// Two-step owner-bound authorization ledger. Tickets bind the single command,
// owner and vehicle. A separate confirmation phrase is required before execution.
export function createCommandAuthorization({ store, key, now = Date.now, operationOptions = () => ({}) }) {
  async function prepare(subject, vehicleFingerprint, operation, args) {
    if (typeof subject !== 'string' || !subject ||
        typeof vehicleFingerprint !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(vehicleFingerprint))
      throw Error('invalid_authorization_context');
    const plan = prepareOperation(operation, args, await operationOptions(subject, operation, args));
    const ticket = random();
    const storageKey = confirmationKey(ticket);
    const expiresAt = now() + CONFIRMATION_TTL_SECONDS * 1000;
    const value = seal({ subject: hash(subject), vehicleFingerprint, operation,
      args: plan.args, expiresAt }, key, storageKey);
    await store.put(storageKey, value, CONFIRMATION_TTL_SECONDS);
    const confirmationPhrase = `CONFERMO ${operation} ${ticket.slice(0, 6)}`;
    return { ticket, operation, args: plan.args, risk: plan.risk,
      confirmation_required: true, expires_at: new Date(expiresAt).toISOString(),
      confirmation_phrase: confirmationPhrase, execution_enabled: false };
  }

  async function confirm(subject, ticket, confirmationPhrase) {
    if (typeof subject !== 'string' || !subject ||
        typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ticket) ||
        typeof confirmationPhrase !== 'string' || confirmationPhrase.length > 96)
      throw Error('invalid_confirmation');
    const storageKey = confirmationKey(ticket);
    const stored = await store.get(storageKey);
    if (!stored) throw Error('confirmation_expired');
    let record;
    try { record = unseal(stored, key, storageKey); }
    catch { throw Error('confirmation_invalid'); }
    if (record.subject !== hash(subject)) throw Error('confirmation_owner_mismatch');
    if (!Number.isFinite(record.expiresAt) || record.expiresAt <= now()) throw Error('confirmation_expired');
    const expectedPhrase = `CONFERMO ${record.operation} ${ticket.slice(0, 6)}`;
    if (confirmationPhrase !== expectedPhrase) throw Error('confirmation_phrase_mismatch');
    // GETDEL makes confirmation single-use across concurrent serverless workers.
    if (await store.take(storageKey) !== stored) throw Error('confirmation_already_used');
    const plan = prepareOperation(record.operation, record.args, await operationOptions(subject, record.operation, record.args));
    return { operation: plan.operation, args: plan.args, risk: plan.risk,
      vehicle_fingerprint: record.vehicleFingerprint,
      confirmed_at: new Date(now()).toISOString(), owner_confirmed: true,
      execution_enabled: false, note: 'Confirmation recorded. No command was sent to the vehicle.' };
  }

  return { prepare, confirm };
}
