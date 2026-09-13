'use strict';

const { DECISION, statusForDecision } = require('../domain/decisions');
const { buildEventId } = require('../domain/event');

/** What goes on the event row when the tag had no channel to notify at all. */
const NO_CHANNEL = 'NONE';

/**
 * A reader saw a tag: decide, record, and tell the owner if it should not have
 * moved.
 *
 * One constraint shapes every answer here: the Fog gateway caches the
 * `(status, body)` pair per tag for 300 s and does not key that cache by node
 * (thesis-sketch/src/infrastructure/cache/cache_service.py). So the answer must
 * depend on the tag alone. A rule like "this reader may open that door" would be
 * served from cache to the wrong reader and has to live in the gateway; and
 * whether the owner could be reached — which is about configuration, not about
 * this scan — stays off the body and goes on the event row.
 *
 * The same cache also rate-limits the alerts: a second scan of the same tag
 * inside 300 s never reaches this function, so an owner gets at most one alert
 * every five minutes per tag. That is desirable, and it is a documented
 * consequence rather than a discovery — it is the other face of finding G18.
 *
 * Receives ports, never adapters: nothing in this file knows about DynamoDB,
 * SSM, Telegram or process.env.
 */
class ScanTagUseCase {
  constructor({ tagRepository, eventRepository, messenger, messages, config, now = () => new Date() }) {
    this.tags = tagRepository;
    this.events = eventRepository;
    this.messenger = messenger;
    this.messages = messages;
    this.config = config;
    this.now = now;
  }

  /**
   * @param {{tag: string, nodeId?: string, clientTimestamp?: string,
   *          idempotencyKey?: string}} request
   * @returns {Promise<{status: number, body: object, duplicate: boolean}>}
   *   `duplicate` is true when the conditional write found the event already
   *   there — the only evidence that idempotency actually fired. The caller
   *   logs it; it never changes the status, because a suppressed retry is a
   *   success for the node that is waiting for an answer.
   */
  async execute(request) {
    const context = this.contextFor(request);
    const record = await this.tags.findById(context.tagId);

    if (!record) {
      if (this.config.autoRegisterTags) {
        // 'exists' means another invocation created it in the same instant —
        // two doors, one new tag. The loser of that race still gets an answer.
        await this.tags.provision({
          tagId: context.tagId,
          allowed: true,
          registeredAt: context.isoTime,
        });
        return this.answer(context, DECISION.REGISTERED, {
          message: 'Tag registered and allowed (AUTO_REGISTER_TAGS)',
        });
      }

      return this.answer(context, DECISION.UNKNOWN, {
        message: 'Tag not found',
        error: 'Not Found',
      });
    }

    if (record.allowed) {
      return this.answer(context, DECISION.ALLOW, { ok: true, message: 'Access allowed' });
    }

    const notification = await this.notifyOwner(record, context);
    return this.answer(context, DECISION.DENY, {
      message: 'Tag not allowed',
      error: 'Denied',
    }, notification);
  }

  /**
   * Best-effort alert to the tag's owner.
   *
   * Two things make "best-effort" true rather than aspirational: the send is
   * bounded by the messenger's own timeout, and anything it throws is caught
   * here. Without the bound, a provider that accepts the connection and never
   * answers would spend the whole 4 s budget *after* the decision is made, the
   * gateway would give up at 5 s and retry, and — since it sends no idempotency
   * key (finding G3) — that retry would land as a second event row.
   */
  async notifyOwner(record, context) {
    if (!record.chatId) return { notified: false, notifyChannel: NO_CHANNEL };

    try {
      const result = await this.messenger.send({
        to: record.chatId,
        text: this.messages.unauthorizedAlert(record, context.isoTime),
      });
      if (!result?.success) {
        console.warn('Owner notification failed', {
          tag: context.tagId,
          provider: this.messenger.provider,
          reason: result?.errorMessage,
        });
      }
      return { notified: Boolean(result?.success), notifyChannel: this.messenger.provider };
    } catch (error) {
      // A port implementation is not supposed to throw, but the access decision
      // must not depend on every adapter honouring that.
      console.error('Owner notification threw', error);
      return { notified: false, notifyChannel: this.messenger.provider };
    }
  }

  /** Everything about one scan that does not depend on the decision. */
  contextFor(request) {
    const timestamp = this.now();
    const epochMs = timestamp.getTime();
    return {
      tagId: request.tag,
      epochMs,
      isoTime: timestamp.toISOString(),
      nodeId: request.nodeId,
      clientTimestamp: request.clientTimestamp,
      eventId: buildEventId({
        epochMs,
        idempotencyKey: request.idempotencyKey,
        dedupWindowMs: this.config.dedupWindowMs,
      }),
    };
  }

  /**
   * Records the event and shapes the reply.
   *
   * The row is written after the notification attempt so it can carry what
   * actually happened; the attempt is bounded, so this costs the reader at most
   * the messenger's timeout.
   */
  async answer(context, decision, { ok, message, error }, notification = {}) {
    const written = await this.events.record({ ...context, decision, ...notification });
    return {
      status: statusForDecision(decision),
      duplicate: !written,
      body: {
        ...(ok ? { ok } : {}),
        tag: context.tagId,
        ...(context.nodeId ? { nodeId: context.nodeId } : {}),
        timestamp: context.clientTimestamp ?? context.isoTime,
        message,
        ...(error ? { error } : {}),
      },
    };
  }
}

module.exports = { ScanTagUseCase };
