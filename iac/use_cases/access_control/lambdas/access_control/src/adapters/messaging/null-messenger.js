'use strict';

/**
 * The messenger for a tenant that has no messaging at all.
 *
 * It exists so that "messaging is off" is a composition-time choice rather than
 * an `if (messagingEnabled)` repeated at every call site. The scan path runs the
 * same code whether or not a channel is configured; the send simply reports that
 * nobody was reachable, and the event row records `notified: false`.
 */
function createNullMessenger() {
  return {
    provider: 'none',
    async send() {
      return {
        success: false,
        provider: 'none',
        errorMessage: 'Messaging is not configured for this tenant',
      };
    },
  };
}

module.exports = { createNullMessenger };
