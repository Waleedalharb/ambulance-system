/**
 * Event Bus — Internal Domain Event Dispatcher (Slice 1)
 * ═══════════════════════════════════════════════════════════
 * Tiny wrapper around a single Node EventEmitter.
 * The Operations Engine owns one instance; services emit domain
 * events into it, and subscribers (broadcast, indicators, timeline)
 * react without the services knowing who is listening.
 *
 * Every payload is auto-enriched:
 *   { event_id, type, occurred_at, ...data }
 *
 * No external dependencies.
 */

const { EventEmitter } = require('events');

function createEventBus() {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(50); // plenty of headroom for future subscribers

    let counter = 0;

    return {
        /**
         * Emit a domain event.
         * @param {string} type - Domain event name (e.g. 'DispatchLogCreated')
         * @param {Object} data - Event-specific fields
         * @returns {Object} the enriched payload that was dispatched
         */
        emit(type, data = {}) {
            const payload = {
                event_id: `${Date.now()}-${process.pid}-${++counter}`,
                type,
                occurred_at: new Date().toISOString(),
                ...data
            };
            try {
                // A throwing subscriber must NEVER break the write path.
                emitter.emit(type, payload);
            } catch (err) {
                console.error(`[EventBus] Subscriber error on '${type}':`, err.message);
            }
            return payload;
        },

        /**
         * Subscribe to a domain event.
         * @param {string} event - Domain event name
         * @param {Function} fn - handler(payload)
         */
        on(event, fn) {
            emitter.on(event, fn);
        }
    };
}

module.exports = { createEventBus };
