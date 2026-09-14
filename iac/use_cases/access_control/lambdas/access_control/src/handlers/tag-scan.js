'use strict';

/**
 * tag-scan — a reader saw a tag.
 *
 * Contract with the Fog gateway:
 *     POST <function url>          header  x-api-key: <key from SSM>
 *     body {"tag": "<epc>"}        optional "nodeId", "timestamp", "eventId"
 *
 * The gateway sends only `tag` today (finding G1); `nodeId` and `timestamp` are
 * accepted now so the day it forwards them nothing has to be redeployed. Both
 * are optional, and both are 400 if present and not a string — the SDK would
 * otherwise write them as the empty string and answer 200.
 *
 * `eventId` (or the `Idempotency-Key` header) is what makes a retried POST
 * collapse onto one row. To stay range-queryable it should be
 * `<13-digit epoch ms>#<unique>`; failing that, send `timestamp` with it and
 * the prefix is derived from the reader's clock. One that is not a string, is
 * over 128 characters, or begins with an implausible epoch is a 400 — never a
 * coerced sort key and never a 500. See domain/event.js.
 *
 * This file is a composition root, and the only kind of file that is one: it is
 * where AWS clients are constructed, where process.env is read, and where the
 * dependency graph is wired. Nothing under use_cases/ or domain/ imports an
 * adapter, an AWS SDK or an environment variable — a rule that architecture.test.js
 * enforces, and the same rule the Fog gateway's own composition root follows.
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { SSMClient } = require('@aws-sdk/client-ssm');

const { SsmParameterReader } = require('../platform/ssm-parameter');
const { ApiKeyVerifier } = require('../platform/api-key');
const { loadConfig, validateConfig } = require('../platform/config');

/** What this handler cannot run without, mapped to the variable that sets it. */
const REQUIREMENTS = {
  tagsTable: 'TAGS_TABLE_NAME',
  eventsTable: 'EVENTS_TABLE_NAME',
  apiKeyParameterName: 'API_KEY_PARAMETER_NAME',
};
const { response, header, parseBody } = require('../platform/http');
const { STATUS } = require('../domain/decisions');
const { normaliseTag, normaliseEventId, normaliseTraceField } = require('../domain/event');
const { createMessages } = require('../domain/messages');
const { DynamoTagRepository } = require('../adapters/dynamo/tag-repository');
const { DynamoEventRepository } = require('../adapters/dynamo/event-repository');
const { createMessenger } = require('../adapters/messaging/registry');
const { ScanTagUseCase } = require('../use_cases/scan-tag');

// Built once per execution environment. The parameter reader is shared by every
// credential this function needs — one cache, keyed by parameter name.
const dynamo = new DynamoDBClient({});
const ssm = new SSMClient({});
const parameters = new SsmParameterReader(ssm);

// Keyed by parameter name: without that, a verifier built for one deployment
// would be reused after the name changed, and the check would be a lie.
let verifier = null;

function getVerifier(parameterName) {
  if (!verifier || verifier.parameterName !== parameterName) {
    verifier = new ApiKeyVerifier(parameters, parameterName);
  }
  return verifier;
}

exports.handler = async (event) => {
  const config = loadConfig();

  const problems = validateConfig(config, REQUIREMENTS);
  if (problems.length > 0) {
    console.error('Misconfigured deployment:', problems.join('; '));
    return response(STATUS.INTERNAL_ERROR, { error: 'Internal Server Error' });
  }

  // 1. Authenticate the caller.
  try {
    const received = header(event, 'x-api-key') ?? '';
    if (!(await getVerifier(config.apiKeyParameterName).matches(received))) {
      // The gateway collapses a 401 into `503 upstream_error` before the node
      // sees it (relay_tag_read.py:147), so at the reader a wrong key looks
      // exactly like an outage. This line is the only place the difference is
      // recorded — do not remove it without replacing it.
      console.warn('Rejected API key', {
        present: received !== '',
        sourceIp: event?.requestContext?.http?.sourceIp,
        userAgent: event?.requestContext?.http?.userAgent,
        parameter: config.apiKeyParameterName,
      });
      return response(STATUS.UNAUTHORIZED, {
        error: 'Unauthorized',
        message: 'Invalid or missing API key',
      });
    }
  } catch (error) {
    console.error('API key check failed', error);
    return response(STATUS.INTERNAL_ERROR, { error: 'Internal Server Error' });
  }

  // 2. Read and validate the request.
  const body = parseBody(event);
  if (body === null) {
    return response(STATUS.BAD_REQUEST, { error: 'Bad Request', message: 'Invalid JSON body' });
  }
  if (body.tag === undefined || body.tag === null) {
    return response(STATUS.BAD_REQUEST, {
      error: 'Bad Request',
      message: 'Missing required field: tag',
    });
  }

  // Everything that ends up in DynamoDB is checked here, together, before any of
  // it is used — and checked rather than coerced, because every coercion
  // available is wrong in a way that answers 200: `String(x)` turns an object
  // into the sort key "[object Object]", and the AWS SDK turns a non-string
  // `{ S: x }` into the empty string, which blanks the very field the event row
  // exists for. It belongs in the handler and not in the use case for the same
  // reason the tag does: it is a statement about the request, not about access.
  //
  // `Date.now()` rather than the use case's injected clock: this is the
  // composition root, and the bound being checked is 24 h wide, so the two
  // cannot disagree in any way that matters.
  const fields = {
    tag: normaliseTag(body.tag),
    eventId: normaliseEventId(body.eventId ?? header(event, 'idempotency-key'), Date.now()),
    nodeId: normaliseTraceField(body.nodeId ?? body.node_id, 'nodeId'),
    timestamp: normaliseTraceField(body.timestamp ?? body.ts, 'timestamp'),
  };
  const invalid = Object.values(fields).find((field) => !field.ok);
  if (invalid) {
    return response(STATUS.BAD_REQUEST, { error: 'Bad Request', message: invalid.reason });
  }
  const { tag, eventId, nodeId, timestamp } = fields;

  // 3. Compose and run. An unsupported provider throws here rather than leaving
  // a deployment that quietly notifies nobody.
  let result;
  try {
    const useCase = new ScanTagUseCase({
      tagRepository: new DynamoTagRepository(dynamo, config),
      eventRepository: new DynamoEventRepository(dynamo, config),
      messenger: createMessenger(config.messagingProvider, {
        tokenProvider: () => parameters.get(config.messagingTokenParameterName),
        whatsappPhoneNumberId: config.whatsappPhoneNumberId,
      }),
      messages: createMessages(config),
      config,
    });

    result = await useCase.execute({
      tag: tag.value,
      nodeId: nodeId.value,
      clientTimestamp: timestamp.value,
      idempotencyKey: eventId.value,
    });
  } catch (error) {
    // Labelled by what it is, not by what it usually is: wrapping the whole use
    // case and calling every failure "DynamoDB" hid decision-logic bugs behind
    // a storage message during bring-up.
    console.error('Tag scan failed', error);
    return response(STATUS.INTERNAL_ERROR, { error: 'Internal Server Error' });
  }

  // One structured line per scan, and the reason it is worth its ingestion cost:
  // without it the only per-request evidence in CloudWatch is the runtime's
  // REPORT line, which carries a duration and no idea what was decided. A
  // latency could be attributed to a decision only by matching time windows.
  // With the event id here and as the row's sort key, a measurement run joins
  // log to row exactly.
  //
  // `duplicate` is the conditional write reporting the event was already stored
  // — a retried POST that collapsed onto the first. It is the only evidence
  // idempotency ever fires, and it can only happen when the caller sends a key.
  console.info('Tag scan', {
    tag: tag.value,
    eventId: result.eventId,
    decision: result.decision,
    status: result.status,
    duplicate: result.duplicate,
    nodeId: nodeId.value,
  });

  return response(result.status, result.body);
};

// Exposed for tests that need to clear the cold-start caches.
exports.__resetForTests = () => {
  verifier = null;
  parameters.clear();
};
