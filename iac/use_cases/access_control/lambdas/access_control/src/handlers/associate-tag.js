'use strict';

/**
 * associate-tag — the tenant's administration surface.
 *
 *     POST <function url>   header  x-api-key: <key from SSM>
 *     body {"op": "associate" | "provision", "tag": ..., "chatId": ..., ...}
 *
 * Two operations, routed by a body field. Not by the path: a Lambda Function URL
 * ignores the path entirely, so path routing would look like it worked while
 * always taking the same branch.
 *
 *   provision   creates a tag                     201, or 409 if it exists
 *   associate   binds an existing tag to a chat   200, 404, or 409 on a name clash
 *
 * `provision` exists because the deployed system had no way at all to put a tag
 * into production: `associate` required the tag to exist and the only thing that
 * created tags was auto-registration, which is a development flag and off in
 * production by design.
 *
 * Credential: the same x-api-key as tag-scan. A separate administration key was
 * evaluated and dropped as over-engineering for a single tenant; the two limits
 * that leaves — a compromised gateway can provision and bind, and any chatId can
 * claim any existing tag — are written down in the repository README as known
 * limits and future work, not discovered in a defence.
 *
 * Composition root: the only file here that builds AWS clients and reads env.
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { SSMClient } = require('@aws-sdk/client-ssm');

const { SsmParameterReader } = require('../platform/ssm-parameter');
const { ApiKeyVerifier } = require('../platform/api-key');
const { loadConfig, validateConfig } = require('../platform/config');
const { response, header, parseBody } = require('../platform/http');
const { STATUS } = require('../domain/decisions');
const { DynamoTagRepository } = require('../adapters/dynamo/tag-repository');
const { AssociateTagUseCase } = require('../use_cases/associate-tag');
const { ProvisionTagUseCase } = require('../use_cases/provision-tag');

const OPERATIONS = ['associate', 'provision'];

const dynamo = new DynamoDBClient({});
const ssm = new SSMClient({});
const parameters = new SsmParameterReader(ssm);

let verifier = null;

function getVerifier(parameterName) {
  if (!verifier || verifier.parameterName !== parameterName) {
    verifier = new ApiKeyVerifier(parameters, parameterName);
  }
  return verifier;
}

exports.handler = async (event) => {
  const config = loadConfig();

  const problems = validateConfig(config, 'associate-tag');
  if (problems.length > 0) {
    console.error('Misconfigured deployment:', problems.join('; '));
    return response(STATUS.INTERNAL_ERROR, { error: 'Internal Server Error' });
  }

  try {
    const received = header(event, 'x-api-key') ?? '';
    if (!(await getVerifier(config.apiKeyParameterName).matches(received))) {
      console.warn('Rejected API key on the administration endpoint', {
        present: received !== '',
        sourceIp: event?.requestContext?.http?.sourceIp,
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

  const body = parseBody(event);
  if (body === null) {
    return response(STATUS.BAD_REQUEST, { error: 'Bad Request', message: 'Invalid JSON body' });
  }

  const operation = String(body.op ?? 'associate').trim().toLowerCase();
  if (!OPERATIONS.includes(operation)) {
    return response(STATUS.BAD_REQUEST, {
      error: 'Bad Request',
      message: `Unsupported op: ${body.op}. Use one of: ${OPERATIONS.join(', ')}`,
    });
  }

  // The field names clients have used over time, all accepted. Normalising them
  // here keeps the aliases out of the use cases and out of the domain.
  const input = {
    tag: body.tag,
    allowed: body.allowed,
    chatId: body.chatId ?? body.chat_id,
    tagName: body.tagName ?? body.tag_name,
    ownerName: body.ownerName ?? body.name,
    ownerLastName: body.ownerLastName ?? body.lastName ?? body.lastname,
  };

  try {
    const tagRepository = new DynamoTagRepository(dynamo, config);
    const useCase =
      operation === 'provision'
        ? new ProvisionTagUseCase({ tagRepository })
        : new AssociateTagUseCase({ tagRepository });

    const result = await useCase.execute(input);
    return response(result.status, result.body);
  } catch (error) {
    console.error(`Tag administration failed (${operation})`, error);
    return response(STATUS.INTERNAL_ERROR, { error: 'Internal Server Error' });
  }
};

exports.__resetForTests = () => {
  verifier = null;
  parameters.clear();
};
