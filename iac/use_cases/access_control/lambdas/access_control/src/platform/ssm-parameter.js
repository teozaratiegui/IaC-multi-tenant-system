'use strict';

const { GetParameterCommand } = require('@aws-sdk/client-ssm');

/** How long a fetched value is reused before SSM is consulted again. */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

/**
 * Reads SecureString parameters, cached per name with a TTL.
 *
 * One reader serves every credential this package needs — the API key, the
 * messaging bot token and the webhook secret. That is the point: the deployed
 * code had a second, separate cache for the bot token with a single unkeyed
 * slot and no expiry, so whichever parameter was read first was handed to every
 * later caller and a rotation never converged.
 *
 * The TTL is the rotation story. Cached for the whole life of the execution
 * environment, a rotated credential would keep being refused by every warm
 * container until AWS happened to recycle it — and the gateway turns the
 * resulting 401 into `503 upstream_error`
 * (thesis-sketch/src/core/use_cases/relay_tag_read.py:147), so at the node it
 * looks exactly like the backend being down. With a TTL a rotation converges on
 * its own within TTL_MS, at the cost of one GetParameter per container per
 * interval: SSM Standard is free and the KMS decrypt is ~US$0.03/10k calls.
 */
class SsmParameterReader {
  constructor(ssmClient, { ttlMs = DEFAULT_TTL_MS, now = Date.now } = {}) {
    this.ssm = ssmClient;
    this.ttlMs = ttlMs;
    this.now = now;
    /** @type {Map<string, {value: string, fetchedAt: number}>} */
    this.cache = new Map();
  }

  /** @returns {Promise<string>} the decrypted value, or '' when the parameter has none. */
  async get(name) {
    if (!name) throw new Error('SsmParameterReader.get requires a parameter name');

    const entry = this.cache.get(name);
    if (entry && this.now() - entry.fetchedAt < this.ttlMs) return entry.value;

    const result = await this.ssm.send(
      new GetParameterCommand({ Name: name, WithDecryption: true }),
    );
    const value = result.Parameter?.Value ?? '';
    // Only a successful read is cached: a throttled call must not pin an empty
    // value for the next five minutes.
    this.cache.set(name, { value, fetchedAt: this.now() });
    return value;
  }

  /** Drops every cached value. Used by tests and by nothing in production. */
  clear() {
    this.cache.clear();
  }
}

module.exports = { SsmParameterReader, DEFAULT_TTL_MS };
