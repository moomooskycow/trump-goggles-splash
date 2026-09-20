#!/usr/bin/env node
'use strict';

// Exercises scripts/sentry.js in a vm sandbox with a fake DOM: proves the
// bootstrap honors the injectable config (disabled is a no-op; enabled loads
// the pinned official SDK and inits with privacy-safe options), and that the
// page never talks to any non-config URL on its own.
//
// Usage: node tools/verify-browser.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'scripts', 'sentry.js'), 'utf8');

const SDK_VERSION = '10.70.0';
const SDK_URL = `https://browser.sentry-cdn.com/${SDK_VERSION}/bundle.min.js`;
const CONFIG_PATH = '/api/sentry-config';

function flush(rounds = 12) {
  let chain = Promise.resolve();
  for (let i = 0; i < rounds; i += 1) {
    chain = chain.then(() => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  return chain;
}

function makeSandbox({ config, failFetch = false, ok = true, readyState = 'complete' }) {
  const appended = [];
  const fetches = [];
  const initCalls = [];
  const listeners = {};

  const sandbox = {
    console,
    Sentry: {
      init(options) {
        initCalls.push(options);
      },
    },
    fetch(url, options) {
      fetches.push({ url: String(url), options });
      if (failFetch) return Promise.reject(new Error('config endpoint down'));
      return Promise.resolve({
        ok,
        json: () => Promise.resolve(config),
      });
    },
    document: {
      readyState,
      createElement(tag) {
        return { tag, src: '', crossOrigin: '', onload: null, onerror: null };
      },
      head: {
        appendChild(element) {
          appended.push(element);
        },
      },
      addEventListener(type, callback) {
        if (!listeners[type]) listeners[type] = [];
        listeners[type].push(callback);
      },
    },
  };
  sandbox.window = sandbox;

  return { sandbox, appended, fetches, initCalls, listeners };
}

function run(source, sandbox) {
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
}

function assertOnlyConfigFetch(fetches) {
  for (const entry of fetches) {
    assert.equal(entry.url, CONFIG_PATH, 'the page must only fetch its config endpoint');
  }
}

async function verifyDisabledIsANoOp() {
  const { sandbox, appended, fetches, initCalls } = makeSandbox({
    config: {
      enabled: false,
      service: 'trump-goggles-splash',
      environment: 'production',
      release: null,
    },
  });
  run(SOURCE, sandbox);
  await flush();
  assert.equal(fetches.length, 1, 'one config fetch expected');
  assertOnlyConfigFetch(fetches);
  assert.equal(appended.length, 0, 'disabled config must not load the SDK');
  assert.equal(initCalls.length, 0, 'disabled config must not init');
}

async function verifyEnabledLoadsPinnedSdk() {
  const config = {
    enabled: true,
    dsn: 'https://public@example.invalid/1',
    service: 'trump-goggles-splash',
    environment: 'staging',
    release: 'test-release-sha',
  };
  const { sandbox, appended, fetches, initCalls } = makeSandbox({ config });
  run(SOURCE, sandbox);
  await flush();

  assertOnlyConfigFetch(fetches);
  assert.equal(appended.length, 1, 'enabled config must load the SDK once');
  const element = appended[0];
  assert.equal(element.src, SDK_URL, 'SDK must come from the pinned official CDN build');
  assert.equal(element.crossOrigin, 'anonymous');
  assert.equal(initCalls.length, 0, 'init must wait for SDK load');

  element.onload();
  assert.equal(initCalls.length, 1, 'init must run after SDK load');
  const options = initCalls[0];
  assert.equal(options.dsn, config.dsn);
  assert.equal(options.environment, 'staging');
  assert.equal(options.release, 'test-release-sha');
  assert.equal(options.sendDefaultPii, false);
  assert.deepEqual(
    Array.from(options.denyUrls, (pattern) => String(pattern)),
    ['/^chrome-extension:\\/\\//', '/^moz-extension:\\/\\//', '/^safari-extension:\\/\\//']
  );
  assert.equal(typeof options.beforeSend, 'function');

  const event = {
    user: { id: 7 },
    request: { url: '/page', headers: { authorization: 'Bearer x' }, cookies: 'session=x', data: 'body' },
    message: 'boom',
  };
  const sanitized = options.beforeSend(event);
  assert.equal(sanitized.message, 'boom');
  assert.equal(sanitized.user, undefined, 'identity must be stripped');
  assert.equal(sanitized.request.url, '/page');
  assert.equal(sanitized.request.headers, undefined, 'headers must be stripped');
  assert.equal(sanitized.request.cookies, undefined, 'cookies must be stripped');
  assert.equal(sanitized.request.data, undefined, 'request bodies must be stripped');
  assert.equal(options.beforeSend(null), null, 'beforeSend must tolerate non-objects');
  assert.equal(options.beforeSend('text'), 'text');
}

async function verifyConfigFailureIsSilent() {
  const failing = makeSandbox({ config: null, failFetch: true });
  run(SOURCE, failing.sandbox);
  await flush();
  assert.equal(failing.appended.length, 0);
  assert.equal(failing.initCalls.length, 0);

  const notOk = makeSandbox({ config: null, ok: false });
  run(SOURCE, notOk.sandbox);
  await flush();
  assert.equal(notOk.fetches.length, 1);
  assert.equal(notOk.appended.length, 0, 'non-2xx config must not load the SDK');
  assert.equal(notOk.initCalls.length, 0);

  const malformed = makeSandbox({ config: { enabled: true } });
  run(SOURCE, malformed.sandbox);
  await flush();
  assert.equal(malformed.appended.length, 0, 'enabled without a DSN must not load');
}

async function verifyDeferredUntilDomReady() {
  const { sandbox, fetches, listeners } = makeSandbox({
    config: { enabled: false, service: 'trump-goggles-splash', environment: 'production', release: null },
    readyState: 'loading',
  });
  run(SOURCE, sandbox);
  await flush();
  assert.equal(fetches.length, 0, 'must wait for DOMContentLoaded');
  assert.equal(listeners.DOMContentLoaded.length, 1);
  listeners.DOMContentLoaded[0]();
  await flush();
  assert.equal(fetches.length, 1);
  assertOnlyConfigFetch(fetches);
}

function verifySourceHasNoRelay() {
  assert.equal(/api\/canary/.test(SOURCE), false, 'browser script must not know the relay');
  assert.equal(/method\s*:\s*['"]POST['"]/i.test(SOURCE), false, 'no browser POSTs');
  assert.equal(/XMLHttpRequest|sendBeacon/.test(SOURCE), false, 'no alternate transports');
}

async function main() {
  await verifyDisabledIsANoOp();
  await verifyEnabledLoadsPinnedSdk();
  await verifyConfigFailureIsSilent();
  await verifyDeferredUntilDomReady();
  verifySourceHasNoRelay();
  console.log('trump-goggles browser bootstrap verification passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});