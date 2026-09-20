#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function startApp(environment) {
  const probe = http.createServer();
  const port = await listen(probe);
  await close(probe);

  const child = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', `file://${__dirname}/`).pathname,
    env: {
      ...process.env,
      PORT: String(port),
      NEXT_PUBLIC_SITE_URL: `http://127.0.0.1:${port}`,
      ...environment,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`server exited ${child.exitCode}: ${stderr}`);
    }
    try {
      await fetch(`http://127.0.0.1:${port}/api/health`);
      return { child, port };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  child.kill('SIGTERM');
  throw new Error(`server did not become ready: ${stderr}`);
}

async function stopApp(child) {
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
}

async function verifyRetiredAndDisabled() {
  const { child, port } = await startApp({
    NODE_ENV: 'production',
    SENTRY_DSN: '',
  });

  try {
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(health.status, 200, 'liveness must not fail closed');
    const healthBody = await health.json();
    assert.equal(healthBody.status, 'ok');
    assert.equal(healthBody.checks.liveness, 'ok');
    assert.equal(healthBody.observability.canary.status, 'retired');

    const healthHead = await fetch(`http://127.0.0.1:${port}/api/health`, {
      method: 'HEAD',
    });
    assert.equal(healthHead.status, 200);
    assert.equal(await healthHead.text(), '');

    const healthPost = await fetch(`http://127.0.0.1:${port}/api/health`, {
      method: 'POST',
    });
    assert.equal(healthPost.status, 405);

    const config = await fetch(`http://127.0.0.1:${port}/api/sentry-config`);
    assert.equal(config.status, 200);
    const configBody = await config.json();
    assert.equal(configBody.enabled, false);
    assert.equal('dsn' in configBody, false, 'no placeholder DSN may exist');

    const tombstone = await fetch(
      `http://127.0.0.1:${port}/api/canary/api/v1/errors`
    );
    assert.equal(tombstone.status, 410);
    assert.equal(tombstone.headers.get('cache-control'), 'no-store');
    assert.equal(tombstone.headers.get('access-control-allow-origin'), null);
    assert.deepEqual(await tombstone.json(), { status: 'retired', service: 'canary' });

    const tombstonePost = await fetch(
      `http://127.0.0.1:${port}/api/canary/api/v1/errors`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'nobody reads this' }),
      }
    );
    assert.equal(tombstonePost.status, 410);

    const tombstoneHead = await fetch(
      `http://127.0.0.1:${port}/api/canary/api/v1/errors`,
      { method: 'HEAD' }
    );
    assert.equal(tombstoneHead.status, 410);
    assert.equal(await tombstoneHead.text(), '');

    const missing = await fetch(`http://127.0.0.1:${port}/missing`);
    assert.equal(missing.status, 404);
  } finally {
    await stopApp(child);
  }
}

async function verifyInjectableConfig() {
  const { child, port } = await startApp({
    NODE_ENV: 'production',
    SENTRY_DSN: 'https://public@example.invalid/1',
    SENTRY_ENVIRONMENT: 'staging',
    SENTRY_RELEASE: 'test-release-sha',
  });

  try {
    const config = await fetch(`http://127.0.0.1:${port}/api/sentry-config`);
    assert.equal(config.status, 200);
    const body = await config.json();
    assert.equal(body.enabled, true);
    assert.equal(body.dsn, 'https://public@example.invalid/1');
    assert.equal(body.environment, 'staging');
    assert.equal(body.release, 'test-release-sha');

    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(health.status, 200, 'telemetry config must not gate liveness');
  } finally {
    await stopApp(child);
  }
}

async function main() {
  await verifyRetiredAndDisabled();
  await verifyInjectableConfig();
  console.log('trump-goggles DigitalOcean server adapter verification passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});