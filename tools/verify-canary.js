#!/usr/bin/env node

const assert = require('node:assert/strict');

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

async function verifyHealthRoute() {
  const health = require('../api/health');

  delete process.env.CANARY_API_KEY;
  process.env.NODE_ENV = 'production';

  let response = makeResponse();
  health({ method: 'GET' }, response);
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.observability.canary.status, 'not_configured');

  process.env.NODE_ENV = 'development';
  process.env.VERCEL_ENV = 'production';
  response = makeResponse();
  health({ method: 'GET' }, response);
  assert.equal(response.statusCode, 200);
  delete process.env.VERCEL_ENV;

  process.env.CANARY_API_KEY = 'test-key';
  process.env.CANARY_SERVICE_NAME = 'trump-goggles-splash';

  response = makeResponse();
  health({ method: 'GET' }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.dependencies.canary, 'configured');
}

async function verifyRelayRoute() {
  const relay = require('../api/canary/api/v1/errors');
  let forwarded;

  delete process.env.CANARY_ENDPOINT;

  global.fetch = async (url, init) => {
    forwarded = { url, init, body: JSON.parse(init.body) };
    return new Response('{}', { status: 202 });
  };

  let response = makeResponse();
  await relay(
    {
      method: 'POST',
      url: '/api/canary/api/v1/errors?token=secret',
      headers: {
        host: 'www.trumpgoggles.com',
        origin: 'https://www.trumpgoggles.com',
        'content-length': '230',
        'user-agent': 'node-test',
        referer: 'https://www.trumpgoggles.com/?api_key=abc',
        'x-vercel-forwarded-for': '127.0.0.1',
      },
      body: {
        message:
          'user test@example.com failed with Bearer abc123 and token=secret',
        error_class: 'SmokeTest',
        stack_trace: 'fetch https://example.com/path?token=secret#frag',
        severity: 'info',
        context: {
          authorization: 'Bearer abc123',
          nested: {
            email: 'admin@example.com',
            dsn: 'sntryu_abc123456',
          },
        },
        fingerprint: ['trump-goggles', 'token=secret'],
      },
    },
    response
  );

  assert.equal(response.statusCode, 202);
  assert.equal(forwarded.url, 'https://canary.mistystep.io/api/v1/errors');
  assert.equal(forwarded.body.service, 'trump-goggles-splash');
  assert.equal(forwarded.body.message.includes('test@example.com'), false);
  assert.equal(forwarded.body.message.includes('Bearer abc123'), false);
  assert.equal(forwarded.body.stack_trace.includes('?token='), false);
  assert.equal(forwarded.body.context.authorization, '[redacted]');
  assert.equal(forwarded.body.context.nested.email, '[EMAIL_REDACTED]');
  assert.equal(forwarded.body.context.nested.dsn, '[redacted]');
  assert.equal(forwarded.body.fingerprint[1], 'token=[REDACTED]');

  response = makeResponse();
  await relay(
    {
      method: 'POST',
      headers: {
        host: 'www.trumpgoggles.com',
        origin: 'https://evil.example',
        'content-length': '24',
        'x-vercel-forwarded-for': '127.0.0.2',
      },
      body: { message: 'blocked' },
    },
    response
  );
  assert.equal(response.statusCode, 403);

  process.env.VERCEL_URL = 'old-preview.vercel.app';
  response = makeResponse();
  await relay(
    {
      method: 'POST',
      headers: {
        host: 'old-preview.vercel.app',
        origin: 'https://old-preview.vercel.app',
        'content-length': '31',
        'x-vercel-forwarded-for': '127.0.0.9',
      },
      body: { message: 'retired origin blocked' },
    },
    response
  );
  assert.equal(response.statusCode, 403);
  delete process.env.VERCEL_URL;

  for (let attempt = 1; attempt <= 31; attempt += 1) {
    response = makeResponse();
    await relay(
      {
        method: 'POST',
        headers: {
          host: 'www.trumpgoggles.com',
          origin: 'https://www.trumpgoggles.com',
          'content-length': '27',
          'do-connecting-ip': '198.51.100.10',
          'x-vercel-forwarded-for': `198.51.100.${attempt}`,
        },
        body: { message: 'rate limit chain' },
      },
      response
    );
    assert.equal(response.statusCode, attempt <= 30 ? 202 : 429);
  }

  // Client-supplied headers must not rotate the relay bucket: the sidecar
  // anchors on the platform-set do-connecting-ip, and the Workers adapter
  // supplies trustedClientIp from the edge-set cf-connecting-ip.
  for (let attempt = 1; attempt <= 31; attempt += 1) {
    response = makeResponse();
    await relay(
      {
        method: 'POST',
        headers: {
          host: 'trumpgoggles.mistystep.io',
          origin: 'https://trumpgoggles.mistystep.io',
          'content-length': '26',
          'do-connecting-ip': '203.0.113.7',
          'cf-connecting-ip': `198.51.100.${attempt}`,
          'x-forwarded-for': `198.51.100.${attempt}`,
        },
        body: { message: 'spoof resistance' },
      },
      response
    );
    assert.equal(response.statusCode, attempt <= 30 ? 202 : 429);
  }

  for (let attempt = 1; attempt <= 31; attempt += 1) {
    response = makeResponse();
    await relay(
      {
        method: 'POST',
        headers: {
          host: 'trumpgoggles.mistystep.io',
          origin: 'https://trumpgoggles.mistystep.io',
          'content-length': '26',
          'cf-connecting-ip': `198.51.100.${attempt}`,
          'x-forwarded-for': `198.51.100.${attempt}`,
        },
        trustedClientIp: '203.0.113.8',
        body: { message: 'adapter trusted ip' },
      },
      response
    );
    assert.equal(response.statusCode, attempt <= 30 ? 202 : 429);
  }

  response = makeResponse();
  await relay(
    {
      method: 'POST',
      headers: {
        host: 'evil.example',
        origin: 'https://evil.example',
        'content-length': '32',
        'x-vercel-forwarded-for': '127.0.0.3',
      },
      body: { message: 'blocked host spoof' },
    },
    response
  );
  assert.equal(response.statusCode, 403);

  response = makeResponse();
  await relay(
    {
      method: 'POST',
      headers: {
        host: 'evil.example',
        origin: 'https://www.trumpgoggles.com',
        'content-length': '43',
        'x-vercel-forwarded-for': '127.0.0.4',
      },
      body: { message: 'blocked canonical origin host spoof' },
    },
    response
  );
  assert.equal(response.statusCode, 403);

  response = makeResponse();
  await relay(
    {
      method: 'POST',
      headers: {
        host: 'evil.example',
        'x-forwarded-host': 'www.trumpgoggles.com',
        origin: 'https://www.trumpgoggles.com',
        'content-length': '43',
        'x-vercel-forwarded-for': '127.0.0.5',
      },
      body: { message: 'blocked forwarded host spoof' },
    },
    response
  );
  assert.equal(response.statusCode, 403);
}

async function main() {
  await verifyHealthRoute();
  await verifyRelayRoute();
  console.log('trump-goggles canary verification passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
