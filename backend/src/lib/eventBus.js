/**
 * lib/eventBus.js
 *
 * A single in-process Node EventEmitter shared across the whole backend.
 * Notification events are decoupled from their producers; awaited
 * transaction-aware listeners coordinate effects that must commit or roll
 * back with the caller.
 *
 * Scope/limits (intentional for MVP):
 * - In-process only. If the backend ever runs as more than one instance,
 *   this stops working and needs to become a real queue (Redis pub/sub,
 *   etc.) — noted here so nobody is surprised later.
 * - emit() is fire-and-forget: listeners should handle and log their own
 *   errors. emitAsync() is only for awaited effects that must share the
 *   caller's transaction; those listeners use the supplied transaction
 *   and let failures propagate so the caller can roll back.
 * - Do not use events for decisions that gate a request (e.g. payout.service.js
 *   directly calls disputes.service.js for FR-45f). Transactional events
 *   coordinate effects after the decision has already been made.
 */

const { EventEmitter } = require('events');

const eventBus = new EventEmitter();

// Raise the default listener cap slightly since several modules may listen
// to the same event name over time; revisit if this warning ever fires.
eventBus.setMaxListeners(30);

/** Dispatch and await listeners that must participate in the caller's transaction. */
eventBus.emitAsync = async function emitAsync(eventName, ...args) {
  const listeners = this.rawListeners(eventName);
  for (const listener of listeners) {
    await listener.apply(this, args);
  }
  return listeners.length > 0;
};

module.exports = eventBus;
