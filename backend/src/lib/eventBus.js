/**
 * lib/eventBus.js
 *
 * A single in-process Node EventEmitter shared across the whole backend.
 * This is the decoupling point chosen for notifications: any service can
 * emit() an event from lib/events.js without importing
 * notifications.service.js directly, and notifications.service.js is the
 * only file that listens for these events and turns them into rows in the
 * `notifications` table (see MODULE 11 in schema.sql).
 *
 * Scope/limits (intentional for MVP):
 * - In-process only. If the backend ever runs as more than one instance,
 *   this stops working and needs to become a real queue (Redis pub/sub,
 *   etc.) — noted here so nobody is surprised later.
 * - Fire-and-forget. Emitting is synchronous; listeners should not throw.
 *   If a listener needs to do async work (e.g. write to DB), it should
 *   handle its own errors and log them — a thrown/rejected listener must
 *   never take down the request that emitted the event.
 * - This bus is for cross-module notifications only. Do not use it for
 *   core business logic decisions (e.g. payout.service.js must directly
 *   call disputes.service.js's exported function for FR-45f, NOT listen
 *   for a dispute event — that dependency needs to be a real synchronous
 *   check, not a maybe-arrives-later event).
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
