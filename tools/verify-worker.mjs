#!/usr/bin/env node

// Verifies the Cloudflare Worker entrypoint (src/worker.mjs) preserves the
// sidecar routing contract for /api/health, /api/sentry-config, and the
// retired /api/canary/api/v1/errors tombstone, and that non-API paths keep
// 404ing like the assets-only deployment.
//
// Usage: node tools/verify-worker.mjs

import assert from 'node:assert/strict';

import worker from '../src/worker.mjs';

const SITE = 'https://www.trumpgoggles.com';
const TOMBSTONE_PATH = '/api/canary/api/v1/errors';

function makeRequest(path, options = {}) {
  return new Request(`${SITE}${path}`, options);
}

async function main() {
  process.env.NODE_ENV = 'production';
  delete process.env.SENTRY_DSN;
  delete process.env.SENTRY_ENVIRONMENT;
  delete process.env.SENTRY_RELEASE;

  // --- GET|HEAD /api/health ------------------------------------------------
  let response = await worker.fetch(makeRequest('/api/health'));
  assert.equal(response.status, 200, 'liveness must not fail closed');
  assert.equal(
    response.headers.get('Cache-Control'),
    'no-cache, no-store, must-revalidate'
  );
  let body = await response.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.service, 'trump-goggles-splash');
  assert.equal(body.checks.liveness, 'ok');
  assert.equal(body.observability.canary.status, 'retired');
  assert.equal(JSON.stringify(body).includes('dependencies'), false);

  response = await worker.fetch(makeRequest('/api/health', { method: 'HEAD' }));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '');

  response = await worker.fetch(makeRequest('/api/health', { method: 'POST' }));
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('Allow'), 'GET, HEAD');

  // --- GET|HEAD /api/sentry-config ----------------------------------------
  response = await worker.fetch(makeRequest('/api/sentry-config'));
  assert.equal(response.status, 200);
  body = await response.json();
  assert.equal(body.enabled, false);
  assert.equal('dsn' in body, false, 'no placeholder DSN may exist');
  assert.equal(body.environment, 'production');

  response = await worker.fetch(makeRequest('/api/sentry-config', { method: 'HEAD' }));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '');

  response = await worker.fetch(makeRequest('/api/sentry-config', { method: 'POST' }));
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('Allow'), 'GET, HEAD');

  process.env.SENTRY_DSN = 'https://public@example.invalid/1';
  process.env.SENTRY_ENVIRONMENT = 'staging';
  response = await worker.fetch(makeRequest('/api/sentry-config'));
  body = await response.json();
  assert.equal(body.enabled, true);
  assert.equal(body.dsn, 'https://public@example.invalid/1');
  assert.equal(body.environment, 'staging');
  delete process.env.SENTRY_DSN;
  delete process.env.SENTRY_ENVIRONMENT;

  // --- /api/canary/api/v1/errors tombstone ---------------------------------
  for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']) {
    response = await worker.fetch(makeRequest(TOMBSTONE_PATH, { method }));
    assert.equal(response.status, 410, `${method} must be a tombstone`);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
    assert.deepEqual(await response.json(), { status: 'retired', service: 'canary' });
  }

  response = await worker.fetch(makeRequest(TOMBSTONE_PATH, { method: 'HEAD' }));
  assert.equal(response.status, 410);
  assert.equal(await response.text(), '');

  // The tombstone must not read a request body at all: a pull-counted stream
  // must record zero pulls.
  let pulls = 0;
  response = await worker.fetch(
    new Request(`${SITE}${TOMBSTONE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: new ReadableStream(
        {
          pull(controller) {
            pulls += 1;
            controller.enqueue(new Uint8Array(4096));
          },
        },
        { highWaterMark: 0 }
      ),
      duplex: 'half',
    })
  );
  assert.equal(response.status, 410);
  assert.equal(pulls, 0, 'tombstone bodies must not be read');

  // No forwarding can exist: a poisoned global fetch must never be called.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('worker must not call fetch for the tombstone');
  };
  response = await worker.fetch(
    makeRequest(TOMBSTONE_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'must not forward' }),
    })
  );
  assert.equal(response.status, 410);
  globalThis.fetch = originalFetch;

  // --- Non-API fallthrough -------------------------------------------------
  response = await worker.fetch(makeRequest('/api/unknown'));
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, 'Not found');
  response = await worker.fetch(makeRequest('/api'));
  assert.equal(response.status, 404);
  response = await worker.fetch(makeRequest('/api/canary'));
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, 'Not found');

  for (const path of ['/server.js', '/missing', '/src/worker.mjs']) {
    response = await worker.fetch(makeRequest(path));
    assert.equal(response.status, 404, `${path} must 404`);
    assert.equal(await response.text(), '', `${path} must not leak a body`);
  }

  console.log('trump-goggles Worker verification passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});