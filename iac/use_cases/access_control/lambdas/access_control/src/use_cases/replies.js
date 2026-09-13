'use strict';

const { STATUS } = require('../domain/decisions');

/**
 * The reply shapes the administration use cases share.
 *
 * They live apart from either use case so that neither has to import the other
 * for a helper — a sideways dependency that says nothing about the design and
 * makes the pair look coupled when it is not.
 */

function badRequest(message) {
  return { status: STATUS.BAD_REQUEST, body: { error: 'Bad Request', message } };
}

function notFound(message, extra = {}) {
  return { status: STATUS.NOT_FOUND, body: { error: 'Not Found', message, ...extra } };
}

function conflict(message, extra = {}) {
  return { status: STATUS.CONFLICT, body: { error: 'Conflict', message, ...extra } };
}

module.exports = { badRequest, notFound, conflict };
