#!/usr/bin/env node
/**
 * Optional integration test against a deployed Function URL.
 *
 * Set ACCESS_CONTROL_URL and ACCESS_CONTROL_API_KEY, or put them in a `.env` file next to this script
 * (loaded automatically via dotenv). Then: npm run test:integration
 * If either var is missing, exits 0 with a skip message (safe for CI without secrets).
 */

const path = require('path');
// Load .env from this folder (npm run sets cwd here; path keeps it reliable)
require('dotenv').config({ path: path.join(__dirname, '.env') });

const url = process.env.ACCESS_CONTROL_URL;
const apiKey = process.env.ACCESS_CONTROL_API_KEY;

async function main() {
  if (!url || !apiKey) {
    console.log(
      'Skip integration test: set ACCESS_CONTROL_URL and ACCESS_CONTROL_API_KEY',
    );
    process.exit(0);
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({ tag: 'integration-test-tag', timestamp: new Date().toISOString() }),
  });

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  console.log('HTTP', res.status, body);

  if (res.status === 401 || res.status === 403 || res.status === 404) {
    console.error(
      'Unexpected auth/not-found — ensure DynamoDB has the tag or use dev auto-register.',
    );
    process.exit(1);
  }

  if (res.status >= 400) {
    process.exit(1);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
