'use strict';

const { ScanTagUseCase } = require('./scan-tag');
const { createMessages } = require('../domain/messages');

const FIXED_NOW = new Date('2026-09-12T17:32:05.000Z');

const MESSAGES = createMessages({
  orgDisplayName: 'acme',
  locale: 'es-AR',
  timeZone: 'America/Argentina/Buenos_Aires',
});

const BOUND_DENIED = {
  tagId: 'E280',
  allowed: false,
  chatId: '99',
  tagName: 'bici',
  tagNameNormalized: 'bici',
  ownerName: 'Teo',
  ownerLastName: 'Zaratiegui',
};

function makeTagRepository(record) {
  return {
    findById: jest.fn().mockResolvedValue(record),
    provision: jest.fn().mockResolvedValue('created'),
  };
}

function makeEventRepository() {
  return { record: jest.fn().mockResolvedValue(true) };
}

function makeMessenger(provider = 'telegram', result = { success: true }) {
  return {
    provider,
    send: jest.fn().mockResolvedValue({ provider, ...result }),
  };
}

function makeUseCase({ tagRepository, eventRepository, messenger, config = {}, now }) {
  return new ScanTagUseCase({
    tagRepository,
    eventRepository,
    messenger: messenger ?? makeMessenger('none', { success: false }),
    messages: MESSAGES,
    config: { autoRegisterTags: false, ...config },
    now: now ?? (() => FIXED_NOW),
  });
}

/**
 * A clock that moves, for anything about retries.
 *
 * A frozen `now` cannot tell a correct event id from one built out of the
 * arrival time: both are identical when time does not pass. That is exactly how
 * the duplicate-suppression bug survived a green test suite.
 */
function advancingClock(startIso, stepMs) {
  let current = Date.parse(startIso);
  return () => {
    const at = new Date(current);
    current += stepMs;
    return at;
  };
}

function recordedEvent(eventRepository) {
  return eventRepository.record.mock.calls[0][0];
}

describe('an allowed tag', () => {
  test('answers 200 and records an ALLOW event', async () => {
    const eventRepository = makeEventRepository();
    const result = await makeUseCase({
      tagRepository: makeTagRepository({ tagId: 'E280', allowed: true, chatId: '' }),
      eventRepository,
    }).execute({ tag: 'E280' });

    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(recordedEvent(eventRepository).decision).toBe('ALLOW');
  });

  test('nobody is notified about a tag that was allowed through', async () => {
    const messenger = makeMessenger();
    await makeUseCase({
      tagRepository: makeTagRepository({ tagId: 'E280', allowed: true, chatId: '99' }),
      eventRepository: makeEventRepository(),
      messenger,
    }).execute({ tag: 'E280' });

    expect(messenger.send).not.toHaveBeenCalled();
  });
});

describe('a known but disabled tag', () => {
  test('answers 422 with an owner to notify', async () => {
    const eventRepository = makeEventRepository();
    const result = await makeUseCase({
      tagRepository: makeTagRepository(BOUND_DENIED),
      eventRepository,
      messenger: makeMessenger(),
    }).execute({ tag: 'E280' });

    expect(result.status).toBe(422);
    expect(recordedEvent(eventRepository).decision).toBe('DENY');
  });

  test('answers 422 with no owner to notify — the same status, deliberately', async () => {
    // The deployed code split this into 403 (notifiable) and 422 (not). For the
    // reader they are one fact, and the gateway caches (status, body) per tag
    // for 300 s: a status that depended on the channel would be served stale
    // for five minutes after an associate-tag created the channel.
    const messenger = makeMessenger();
    const result = await makeUseCase({
      tagRepository: makeTagRepository({ ...BOUND_DENIED, chatId: '' }),
      eventRepository: makeEventRepository(),
      messenger,
    }).execute({ tag: 'E280' });

    expect(result.status).toBe(422);
    expect(messenger.send).not.toHaveBeenCalled();
  });

  test('the reply says Denied, never Forbidden', async () => {
    const result = await makeUseCase({
      tagRepository: makeTagRepository(BOUND_DENIED),
      eventRepository: makeEventRepository(),
    }).execute({ tag: 'E280' });

    expect(result.body.error).toBe('Denied');
    expect(JSON.stringify(result.body)).not.toContain('Forbidden');
  });
});

describe('an unknown tag', () => {
  test('answers 404 but still records the scan', async () => {
    // An unknown badge at the door is exactly what the audit trail exists for.
    const tagRepository = makeTagRepository(null);
    const eventRepository = makeEventRepository();
    const result = await makeUseCase({ tagRepository, eventRepository }).execute({ tag: 'ghost' });

    expect(result.status).toBe(404);
    expect(recordedEvent(eventRepository).decision).toBe('UNKNOWN');
    expect(tagRepository.provision).not.toHaveBeenCalled();
  });

  test('is registered and allowed when auto-registration is on', async () => {
    const tagRepository = makeTagRepository(null);
    const eventRepository = makeEventRepository();
    const result = await makeUseCase({
      tagRepository,
      eventRepository,
      config: { autoRegisterTags: true },
    }).execute({ tag: 'ghost' });

    expect(result.status).toBe(201);
    expect(tagRepository.provision).toHaveBeenCalledWith({
      tagId: 'ghost',
      allowed: true,
      registeredAt: FIXED_NOW.toISOString(),
    });
    expect(recordedEvent(eventRepository).decision).toBe('REGISTERED');
  });

  test('a tag created by another invocation in the same instant is not an error', async () => {
    // Two readers at two doors can scan the same new tag at once; the loser of
    // that race must still get an answer, not a 500.
    const tagRepository = makeTagRepository(null);
    tagRepository.provision.mockResolvedValue('exists');
    const result = await makeUseCase({
      tagRepository,
      eventRepository: makeEventRepository(),
      config: { autoRegisterTags: true },
    }).execute({ tag: 'ghost' });

    expect(result.status).toBe(201);
  });
});

describe('the notification', () => {
  test('carries the alert text the owner expects, to their chat', async () => {
    const messenger = makeMessenger();
    await makeUseCase({
      tagRepository: makeTagRepository(BOUND_DENIED),
      eventRepository: makeEventRepository(),
      messenger,
    }).execute({ tag: 'E280' });

    expect(messenger.send).toHaveBeenCalledWith({
      to: '99',
      text:
        'Alerta: Se detectó un movimiento no autorizado de su tag "bici" ' +
        'por parte del lector de acme a las 12/9/26 14:32:05',
    });
  });

  test('its outcome is recorded on the event row', async () => {
    const eventRepository = makeEventRepository();
    await makeUseCase({
      tagRepository: makeTagRepository(BOUND_DENIED),
      eventRepository,
      messenger: makeMessenger('telegram', { success: true }),
    }).execute({ tag: 'E280' });

    expect(recordedEvent(eventRepository)).toMatchObject({
      notified: true,
      notifyChannel: 'telegram',
    });
  });

  test('a denial nobody could be told about is written down as such', async () => {
    const eventRepository = makeEventRepository();
    await makeUseCase({
      tagRepository: makeTagRepository({ ...BOUND_DENIED, chatId: '' }),
      eventRepository,
      messenger: makeMessenger(),
    }).execute({ tag: 'E280' });

    expect(recordedEvent(eventRepository)).toMatchObject({
      notified: false,
      notifyChannel: 'NONE',
    });
  });

  test('never reaches the body, whatever happened', async () => {
    // The gateway caches (status, body) per tag for 300 s, so a body that
    // mentioned the notification would be replayed to readings that notified
    // nobody. The event row is where that fact is auditable.
    const notified = await makeUseCase({
      tagRepository: makeTagRepository(BOUND_DENIED),
      eventRepository: makeEventRepository(),
      messenger: makeMessenger('telegram', { success: true }),
    }).execute({ tag: 'E280' });

    const silent = await makeUseCase({
      tagRepository: makeTagRepository({ ...BOUND_DENIED, chatId: '' }),
      eventRepository: makeEventRepository(),
      messenger: makeMessenger('none', { success: false }),
    }).execute({ tag: 'E280' });

    expect(notified.body).toEqual(silent.body);
  });

  test('a messenger that fails still lets the reader get its answer', async () => {
    const eventRepository = makeEventRepository();
    const result = await makeUseCase({
      tagRepository: makeTagRepository(BOUND_DENIED),
      eventRepository,
      messenger: makeMessenger('telegram', { success: false, errorMessage: 'chat not found' }),
    }).execute({ tag: 'E280' });

    expect(result.status).toBe(422);
    expect(recordedEvent(eventRepository).notified).toBe(false);
  });

  test('a messenger that throws is caught, not propagated', async () => {
    // A port implementation is not supposed to throw, but the access decision
    // must not depend on every adapter honouring that.
    const messenger = { provider: 'telegram', send: jest.fn().mockRejectedValue(new Error('boom')) };
    const result = await makeUseCase({
      tagRepository: makeTagRepository(BOUND_DENIED),
      eventRepository: makeEventRepository(),
      messenger,
    }).execute({ tag: 'E280' });

    expect(result.status).toBe(422);
  });

  test('with messaging switched off the same path runs, and sends nothing', async () => {
    // No `if (messagingEnabled)` anywhere: the null messenger is selected once,
    // in the composition root.
    const { createNullMessenger } = require('../adapters/messaging/null-messenger');
    const eventRepository = makeEventRepository();
    const result = await makeUseCase({
      tagRepository: makeTagRepository(BOUND_DENIED),
      eventRepository,
      messenger: createNullMessenger(),
    }).execute({ tag: 'E280' });

    expect(result.status).toBe(422);
    expect(recordedEvent(eventRepository).notified).toBe(false);
    // 'NONE', not the null messenger's own lower-case provider name. The row is
    // queried, and `notifyChannel = 'NONE'` is precisely the audit question
    // "which denials could nobody be told about?": two spellings for one fact
    // made that query drop every tenant running without messaging, silently.
    expect(recordedEvent(eventRepository).notifyChannel).toBe('NONE');
  });

  test('"no channel" has one spelling, whichever way it came about', async () => {
    const { createNullMessenger } = require('../adapters/messaging/null-messenger');

    // Two different causes — the tag has no owner chat, or the tenant has no
    // messaging at all — and one audit fact.
    const noChat = makeEventRepository();
    await makeUseCase({
      tagRepository: makeTagRepository({ ...BOUND_DENIED, chatId: '' }),
      eventRepository: noChat,
      messenger: makeMessenger(),
    }).execute({ tag: 'E280' });

    const noMessaging = makeEventRepository();
    await makeUseCase({
      tagRepository: makeTagRepository(BOUND_DENIED),
      eventRepository: noMessaging,
      messenger: createNullMessenger(),
    }).execute({ tag: 'E280' });

    expect(recordedEvent(noChat).notifyChannel).toBe(recordedEvent(noMessaging).notifyChannel);
  });

  test('a real provider keeps its own name', async () => {
    // Normalising the sentinel must not normalise everything: the row says which
    // channel was used, and 'telegram' is the answer, not 'TELEGRAM'.
    const eventRepository = makeEventRepository();
    await makeUseCase({
      tagRepository: makeTagRepository(BOUND_DENIED),
      eventRepository,
      messenger: makeMessenger('telegram', { success: false }),
    }).execute({ tag: 'E280' });

    expect(recordedEvent(eventRepository).notifyChannel).toBe('telegram');
  });
});

describe('traceability', () => {
  test('the reader identity and its own timestamp travel into the event', async () => {
    const eventRepository = makeEventRepository();
    await makeUseCase({
      tagRepository: makeTagRepository({ tagId: 'E280', allowed: true }),
      eventRepository,
    }).execute({ tag: 'E280', nodeId: 'node-ab12cd34', clientTimestamp: '2026-09-12T17:32:04Z' });

    expect(recordedEvent(eventRepository)).toMatchObject({
      nodeId: 'node-ab12cd34',
      clientTimestamp: '2026-09-12T17:32:04Z',
      epochMs: FIXED_NOW.getTime(),
    });
  });

  test('an idempotency key survives a retry that arrives seconds later', async () => {
    // The gateway's Retry(total=3) fires after its own 5 s timeout, so the two
    // invocations of one physical scan are seconds apart. The id used to be
    // prefixed with the arrival time, which made it differ every time and the
    // conditional write in the repository collapse nothing. This test used to
    // pass with that bug because the clock was frozen.
    const eventRepository = makeEventRepository();
    // What the conditional write really answers: the first attempt lands, the
    // second finds the row already there. The default stub says `true` to
    // everything, and under that a collapsed retry and a second row look alike.
    eventRepository.record.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const useCase = makeUseCase({
      tagRepository: makeTagRepository({ tagId: 'E280', allowed: true }),
      eventRepository,
      now: advancingClock('2026-09-13T12:00:03.250Z', 5650),
    });

    const landed = await useCase.execute({ tag: 'E280', idempotencyKey: 'scan-7' });
    const collapsed = await useCase.execute({ tag: 'E280', idempotencyKey: 'scan-7' });

    const [first, second] = eventRepository.record.mock.calls.map((call) => call[0].eventId);
    expect(second).toBe(first);
    expect(landed.duplicate).toBe(false);
    expect(collapsed.duplicate).toBe(true);
    // Each *call* still carries its own arrival time — only the identity of the
    // event is pinned, not its timestamps. There is one row, and it keeps the
    // first attempt's `eventTime`, because the second write was the one refused.
    const times = eventRepository.record.mock.calls.map((call) => call[0].epochMs);
    expect(times[1]).toBeGreaterThan(times[0]);
  });

  test("with the reader's timestamp the stable id is also range-queryable", async () => {
    const eventRepository = makeEventRepository();
    const useCase = makeUseCase({
      tagRepository: makeTagRepository({ tagId: 'E280', allowed: true }),
      eventRepository,
      now: advancingClock('2026-09-13T12:00:03.250Z', 5650),
    });

    const scan = { tag: 'E280', idempotencyKey: 'scan-7', clientTimestamp: '2026-09-13T12:00:02Z' };
    await useCase.execute(scan);
    await useCase.execute(scan);

    const [first, second] = eventRepository.record.mock.calls.map((call) => call[0].eventId);
    expect(second).toBe(first);
    expect(first).toBe('1789300802000#scan-7');
  });

  test('a key that cannot be ordered is honoured, and said out loud', async () => {
    // It still deduplicates; it just falls outside `eventId BETWEEN` windows.
    // Silence here would mean a tag whose history looks complete and is not.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const eventRepository = makeEventRepository();
      await makeUseCase({
        tagRepository: makeTagRepository({ tagId: 'E280', allowed: true }),
        eventRepository,
      }).execute({ tag: 'E280', idempotencyKey: 'scan-7' });

      expect(recordedEvent(eventRepository).eventId).toBe('scan-7');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Unordered idempotency key'),
        expect.objectContaining({ tag: 'E280', hasClientTimestamp: false }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  test('no key at all stays ordered and stays silent', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const eventRepository = makeEventRepository();
      await makeUseCase({
        tagRepository: makeTagRepository({ tagId: 'E280', allowed: true }),
        eventRepository,
      }).execute({ tag: 'E280' });

      expect(recordedEvent(eventRepository).eventId).toMatch(/^\d{13}#.+$/);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test('the answer carries what the handler needs to log the scan', async () => {
    // The event id is the only thing that joins a CloudWatch REPORT to the row
    // it wrote; without it latency can be attributed to a decision only by
    // matching time windows.
    const eventRepository = makeEventRepository();
    const result = await makeUseCase({
      tagRepository: makeTagRepository({ tagId: 'E280', allowed: true }),
      eventRepository,
    }).execute({ tag: 'E280' });

    expect(result.decision).toBe('ALLOW');
    expect(result.eventId).toBe(recordedEvent(eventRepository).eventId);
    // And none of it leaks into the HTTP body, which the gateway caches per tag
    // for 300 s and would replay to unrelated readings.
    expect(result.body).not.toHaveProperty('eventId');
    expect(result.body).not.toHaveProperty('decision');
  });

  test('a suppressed duplicate is reported to the caller, not turned into an error', async () => {
    const eventRepository = makeEventRepository();
    eventRepository.record.mockResolvedValue(false);
    const result = await makeUseCase({
      tagRepository: makeTagRepository({ tagId: 'E280', allowed: true }),
      eventRepository,
    }).execute({ tag: 'E280' });

    expect(result.status).toBe(200);
    expect(result.duplicate).toBe(true);
  });
});

describe('answer stability', () => {
  test('the answer depends on the tag alone, never on the reader', async () => {
    const useCase = makeUseCase({
      tagRepository: makeTagRepository({ tagId: 'E280', allowed: true }),
      eventRepository: makeEventRepository(),
    });

    const first = await useCase.execute({ tag: 'E280', nodeId: 'node-a' });
    const second = await useCase.execute({ tag: 'E280', nodeId: 'node-b' });

    expect(first.status).toBe(second.status);
    expect(first.body.message).toBe(second.body.message);
  });

  test('every status it can produce survives the gateway relay', async () => {
    const { NODE_VISIBLE_STATUSES } = require('../domain/decisions');
    const cases = [
      [{ tagId: 'E280', allowed: true }, {}],
      [{ tagId: 'E280', allowed: false }, {}],
      [null, {}],
      [null, { autoRegisterTags: true }],
    ];

    for (const [record, config] of cases) {
      const result = await makeUseCase({
        tagRepository: makeTagRepository(record),
        eventRepository: makeEventRepository(),
        config,
      }).execute({ tag: 'E280' });
      expect(NODE_VISIBLE_STATUSES.has(result.status)).toBe(true);
    }
  });
});
