#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function makeResponse() {
  return {
    headers: {},
    statusCode: 200,
    body: undefined,
    ended: false,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      this.ended = true;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
}

function clearSentryEnv() {
  delete process.env.SENTRY_DSN;
  delete process.env.SENTRY_ENVIRONMENT;
  delete process.env.SENTRY_RELEASE;
}

function verifyHealthContract() {
  const health = require('../api/health');
  process.env.NODE_ENV = 'production';
  clearSentryEnv();

  let response = makeResponse();
  health({ method: 'GET' }, response);
  assert.equal(response.statusCode, 200, 'liveness must not fail closed');
  assert.equal(response.body.status, 'ok');
  assert.equal(response.body.service, 'trump-goggles-splash');
  assert.equal(response.body.checks.liveness, 'ok');
  assert.equal(response.body.observability.canary.status, 'retired');
  assert.ok(!Number.isNaN(Date.parse(response.body.timestamp)), 'timestamp must parse');
  const serialized = JSON.stringify(response.body);
  assert.equal(serialized.includes('canary_config'), false);
  assert.equal(serialized.includes('dependencies'), false);
  assert.equal(serialized.includes('configured'), false, 'no fake telemetry flags');
  assert.equal(response.headers['cache-control'], 'no-cache, no-store, must-revalidate');

  response = makeResponse();
  health({ method: 'HEAD' }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, undefined, 'HEAD must not carry a body');
  assert.equal(response.ended, true);

  response = makeResponse();
  health({ method: 'POST' }, response);
  assert.equal(response.statusCode, 405);
  assert.equal(response.headers.allow, 'GET, HEAD');
}

function verifyTombstoneContract() {
  const tombstone = require('../api/canary/api/v1/errors');

  for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH']) {
    const response = makeResponse();
    tombstone({ method }, response);
    assert.equal(response.statusCode, 410, `${method} must be a tombstone`);
    assert.deepEqual(response.body, { status: 'retired', service: 'canary' });
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(
      Object.keys(response.headers).some((name) => name.startsWith('access-control')),
      false,
      'tombstones must not enable CORS'
    );
  }

  let response = makeResponse();
  tombstone({ method: 'HEAD' }, response);
  assert.equal(response.statusCode, 410);
  assert.equal(response.body, undefined, 'HEAD tombstone must not carry a body');

  // The handler must never read a request body: a trap getter proves it.
  const trapped = { method: 'POST' };
  Object.defineProperty(trapped, 'body', {
    get() {
      throw new Error('tombstone read the request body');
    },
  });
  response = makeResponse();
  tombstone(trapped, response);
  assert.equal(response.statusCode, 410);

  // No stream consumption either: a request without stream methods passes.
  response = makeResponse();
  tombstone({ method: 'POST', headers: {} }, response);
  assert.equal(response.statusCode, 410);

  const source = fs.readFileSync(
    path.join(ROOT, 'api', 'canary', 'api', 'v1', 'errors.js'),
    'utf8'
  );
  assert.equal(/fetch\s*\(/.test(source), false, 'tombstone must not forward');
  assert.equal(/CANARY_API_KEY|CANARY_ENDPOINT|forwardToCanary/.test(source), false);
  assert.equal(/JSON\.parse/.test(source), false, 'tombstone must not parse bodies');
}

function verifySentryConfigContract() {
  const config = require('../api/sentry-config');
  clearSentryEnv();
  process.env.NODE_ENV = 'production';

  let response = makeResponse();
  config({ method: 'GET' }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.enabled, false);
  assert.equal('dsn' in response.body, false, 'no placeholder DSN may exist');
  assert.equal(response.body.service, 'trump-goggles-splash');
  assert.equal(response.body.environment, 'production');
  assert.equal(response.body.release, null);
  assert.equal(response.headers['cache-control'], 'no-cache, no-store, must-revalidate');

  process.env.SENTRY_DSN = 'https://public@example.invalid/1';
  process.env.SENTRY_ENVIRONMENT = 'staging';
  process.env.SENTRY_RELEASE = 'test-release-sha';

  response = makeResponse();
  config({ method: 'GET' }, response);
  assert.equal(response.body.enabled, true);
  assert.equal(response.body.dsn, 'https://public@example.invalid/1');
  assert.equal(response.body.environment, 'staging');
  assert.equal(response.body.release, 'test-release-sha');

  response = makeResponse();
  config({ method: 'HEAD' }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, undefined, 'HEAD must not carry a body');

  response = makeResponse();
  config({ method: 'POST' }, response);
  assert.equal(response.statusCode, 405);
  assert.equal(response.headers.allow, 'GET, HEAD');

  clearSentryEnv();
}

function main() {
  verifyHealthContract();
  verifyTombstoneContract();
  verifySentryConfigContract();
  console.log('trump-goggles retirement verification passed');
}

main();