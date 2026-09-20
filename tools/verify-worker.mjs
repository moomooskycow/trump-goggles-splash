#!/usr/bin/env node

// Verifies the Cloudflare Worker entrypoint (src/worker.mjs) preserves the
// sidecar routing contract for /api/health and /api/canary/api/v1/errors,
// and that non-API paths keep 404ing like the assets-only deployment.
//
// Usage: node tools/verify-worker.mjs

import assert from 'node:assert/strict';

import worker from '../src/worker.mjs';
import relay from '../api/canary/api/v1/errors.js';

async function main() {
  assert.equal(relay.MAX_BODY_BYTES, 32768, 'relay body cap must be exported');

  const SITE = 'https://www.trumpgoggles.com';

  function makeRequest(path, options = {}) {
    return new Request(`${SITE}${path}`, options);
  }

  function captureForward() {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response('{}', { status: 202 });
    };
    return calls;
  }

  function relayRequest(overrides = {}) {
    const headers = {
      'Content-Type': 'application/json',
      Origin: SITE,
      Referer: `${SITE}/`,
      ...overrides.headers,
    };
    return makeRequest('/api/canary/api/v1/errors', {
      method: 'POST',
      headers,
      body: JSON.stringify({ message: 'worker smoke', ...overrides.payload }),
    });
  }

  // --- GET|HEAD /api/health ------------------------------------------------
  process.env.CANARY_API_KEY = 'worker-test-key';
  process.env.CANARY_SERVICE_NAME = 'trump-goggles-splash';
  process.env.NODE_ENV = 'production';

  let response = await worker.fetch(makeRequest('/api/health'));
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get('Cache-Control'),
    'no-cache, no-store, must-revalidate'
  );
  let body = await response.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.service, 'trump-goggles-splash');
  assert.equal(body.dependencies.canary, 'configured');
  assert.equal(body.observability.canary.status, 'configured');

  delete process.env.CANARY_API_KEY;
  response = await worker.fetch(makeRequest('/api/health'));
  assert.equal(response.status, 503, 'production without a key must fail closed');
  body = await response.json();
  assert.equal(body.status, 'error');
  assert.equal(body.error, 'Canary is not configured');

  process.env.NODE_ENV = 'development';
  response = await worker.fetch(makeRequest('/api/health'));
  assert.equal(response.status, 200);
  body = await response.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.dependencies.canary, 'not_configured');
  process.env.NODE_ENV = 'production';

  process.env.CANARY_API_KEY = 'worker-test-key';
  response = await worker.fetch(makeRequest('/api/health', { method: 'HEAD' }));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '');
  assert.equal(response.headers.get('Cache-Control'), 'no-cache, no-store, must-revalidate');

  response = await worker.fetch(makeRequest('/api/health', { method: 'POST' }));
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('Allow'), 'GET, HEAD');

  // --- POST /api/canary/api/v1/errors --------------------------------------
  let calls = captureForward();
  response = await worker.fetch(makeRequest('/api/canary/api/v1/errors'));
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('Allow'), 'POST');
  assert.equal(calls.length, 0, 'non-POST must not forward');

  response = await worker.fetch(
    makeRequest('/api/canary/api/v1/errors', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
        Referer: 'https://evil.example/',
      },
      body: JSON.stringify({ message: 'blocked origin' }),
    })
  );
  assert.equal(response.status, 403, 'untrusted origins must be rejected');
  assert.equal(calls.length, 0, 'untrusted origins must not forward');

  response = await worker.fetch(
    makeRequest('/api/canary/api/v1/errors', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
        Referer: 'https://evil.example/',
      },
      body: JSON.stringify({ message: 'a'.repeat(40000) }),
    })
  );
  assert.equal(
    response.status,
    403,
    'trust is checked before size, matching the sidecar order'
  );
  assert.equal(calls.length, 0, 'untrusted oversized payloads must not forward');

  calls = captureForward();
  response = await worker.fetch(
    relayRequest({
      payload: {
        message: 'user test@example.com failed with token=secret',
        error_class: 'WorkerTest',
      },
    })
  );
  assert.equal(response.status, 202);
  assert.equal((await response.json()).status, 'accepted');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://canary.mistystep.io/api/v1/errors');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer worker-test-key');
  const forwarded = JSON.parse(calls[0].init.body);
  assert.equal(forwarded.service, 'trump-goggles-splash');
  assert.equal(forwarded.environment, 'production');
  assert.equal(forwarded.context.source, 'browser.relay');
  assert.equal(forwarded.message.includes('test@example.com'), false);
  assert.equal(forwarded.message.includes('token=secret'), false);

  // The current Worker custom domain is an allowed relay origin.
  calls = captureForward();
  response = await worker.fetch(
    new Request('https://trumpgoggles.mistystep.io/api/canary/api/v1/errors', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://trumpgoggles.mistystep.io',
        Referer: 'https://trumpgoggles.mistystep.io/',
      },
      body: JSON.stringify({ message: 'mistystep host' }),
    })
  );
  assert.equal(response.status, 202);
  assert.equal(calls.length, 1);

  // Staging deployments allow their workers.dev origin via NEXT_PUBLIC_SITE_URL.
  const STAGING = 'https://trump-goggles-splash-staging.misty-step.workers.dev';
  process.env.NEXT_PUBLIC_SITE_URL = STAGING;
  calls = captureForward();
  response = await worker.fetch(
    new Request(`${STAGING}/api/canary/api/v1/errors`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: STAGING,
        Referer: `${STAGING}/`,
      },
      body: JSON.stringify({ message: 'staging origin' }),
    })
  );
  assert.equal(response.status, 202);
  delete process.env.NEXT_PUBLIC_SITE_URL;

  // Rate limiting keys on cf-connecting-ip: rotating x-forwarded-for must
  // not reset the bucket.
  calls = captureForward();
  for (let attempt = 1; attempt <= 31; attempt += 1) {
    response = await worker.fetch(
      makeRequest('/api/canary/api/v1/errors', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: SITE,
          'cf-connecting-ip': '198.51.100.77',
          'x-forwarded-for': `203.0.113.${attempt}`,
        },
        body: JSON.stringify({ message: 'rate limit worker' }),
      })
    );
    assert.equal(response.status, attempt <= 30 ? 202 : 429, `attempt ${attempt}`);
  }
  assert.ok(response.headers.get('Retry-After'), '429 must include Retry-After');

  response = await worker.fetch(relayRequest({ payload: { message: 'a'.repeat(40000) } }));
  assert.equal(response.status, 413, 'oversized payloads must be rejected');

  // The cap counts UTF-8 bytes (HTTP semantics): a multibyte stream without a
  // content-length header must still be rejected even though its decoded
  // length is under the cap.
  const encoder = new TextEncoder();
  const multibyte = JSON.stringify({ message: 'é'.repeat(20000) }); // >32768 bytes, <32768 code units
  assert.ok(encoder.encode(multibyte).byteLength > relay.MAX_BODY_BYTES);
  assert.ok(multibyte.length < relay.MAX_BODY_BYTES);
  response = await worker.fetch(
    new Request(`${SITE}/api/canary/api/v1/errors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: SITE },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(multibyte));
          controller.close();
        },
      }),
      duplex: 'half',
    })
  );
  assert.equal(response.status, 413, 'byte-length cap must reject multibyte payloads');

  // The reader must stop and cancel as soon as the cap is crossed instead of
  // buffering the whole stream.
  let pulled = 0;
  let cancelled = false;
  response = await worker.fetch(
    new Request(`${SITE}/api/canary/api/v1/errors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: SITE },
      body: new ReadableStream({
        pull(controller) {
          pulled += 1;
          if (pulled > 1000) {
            controller.close();
            return;
          }
          controller.enqueue(new Uint8Array(4096));
        },
        cancel() {
          cancelled = true;
        },
      }),
      duplex: 'half',
    })
  );
  assert.equal(response.status, 413, 'streamed oversize must be rejected');
  assert.ok(pulled <= 12, `reader must stop early (pulled ${pulled} chunks)`);
  assert.equal(cancelled, true, 'stream must be cancelled after the cap is crossed');

  response = await worker.fetch(
    makeRequest('/api/canary/api/v1/errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: SITE },
      body: 'not-json',
    })
  );
  assert.equal(response.status, 400, 'invalid JSON must be rejected');

  response = await worker.fetch(relayRequest({ payload: { message: '' } }));
  assert.equal(response.status, 400, 'missing message must be rejected');

  globalThis.fetch = async () => {
    throw new Error('network down');
  };
  response = await worker.fetch(relayRequest());
  assert.equal(response.status, 502, 'forward failures must fail closed');

  delete process.env.CANARY_API_KEY;
  response = await worker.fetch(relayRequest());
  assert.equal(response.status, 503, 'unconfigured relay must fail closed');

  // --- Non-API fallthrough -------------------------------------------------
  process.env.CANARY_API_KEY = 'worker-test-key';
  response = await worker.fetch(makeRequest('/api/unknown'));
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, 'Not found');
  response = await worker.fetch(makeRequest('/api'));
  assert.equal(response.status, 404);

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
