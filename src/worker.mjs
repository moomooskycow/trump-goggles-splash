/* global console, Headers, Request, Response, URL */

import health from '../api/health.js';
import sentryConfig from '../api/sentry-config.js';
import canaryTombstone from '../api/canary/api/v1/errors.js';

/**
 * Cloudflare Worker entry for the Trump Goggles splash.
 *
 * `server.js` owns the routing contract for the dependency-free Node
 * sidecar; this worker mirrors it for the Workers runtime so every hostname
 * that serves the site (trumpgoggles.mistystep.io today; trumpgoggles.com
 * and www.trumpgoggles.com after the registrar flip) serves the same
 * routes:
 *
 *   - GET|HEAD /api/health                -> api/health.js
 *   - GET|HEAD /api/sentry-config         -> api/sentry-config.js
 *   - any      /api/canary/api/v1/errors  -> api/canary/api/v1/errors.js
 *                                            (410 tombstone; no body read)
 *
 * Static assets keep being served by the assets layer; only /api/*
 * requests and non-asset paths reach this script (see `assets` in
 * wrangler.jsonc). Non-API paths 404 exactly like the assets-only
 * deployment did. `src/` is kept out of the asset store by .assetsignore.
 *
 * The api/ handlers read configuration from process.env (nodejs_compat),
 * with the same names as the sidecar: SENTRY_DSN, SENTRY_ENVIRONMENT,
 * SENTRY_RELEASE, NODE_ENV.
 */

function jsonResponse(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/** Adapts a Fetch API request to the req shape the api/ handlers expect. */
function nodeRequest(request) {
  const url = new URL(request.url);
  const headers = {};
  for (const [name, value] of request.headers) {
    headers[name.toLowerCase()] = value;
  }
  if (!headers.host) headers.host = url.host;
  return {
    method: request.method,
    url: `${url.pathname}${url.search}`,
    headers,
    body: undefined,
  };
}

/** Adapts the api/ handlers' setHeader/status/json contract onto Response. */
class NodeResponse {
  constructor() {
    this.headers = new Headers();
    this.statusCode = 200;
    this.payload = undefined;
  }

  setHeader(name, value) {
    this.headers.set(name, String(value));
    return this;
  }

  status(code) {
    this.statusCode = code;
    return this;
  }

  json(payload) {
    this.payload = payload;
    return this;
  }

  end() {
    return this;
  }

  toResponse() {
    if (this.payload === undefined) {
      return new Response(null, {
        status: this.statusCode,
        headers: this.headers,
      });
    }
    if (!this.headers.has('Content-Type')) {
      this.headers.set('Content-Type', 'application/json; charset=utf-8');
    }
    return new Response(JSON.stringify(this.payload), {
      status: this.statusCode,
      headers: this.headers,
    });
  }
}

async function handle(request) {
  const { pathname } = new URL(request.url);

  if (pathname === '/api/health') {
    const response = new NodeResponse();
    await health(nodeRequest(request), response);
    return response.toResponse();
  }

  if (pathname === '/api/sentry-config') {
    const response = new NodeResponse();
    await sentryConfig(nodeRequest(request), response);
    return response.toResponse();
  }

  if (pathname === '/api/canary/api/v1/errors') {
    // Tombstone: answered without reading or forwarding the request body.
    const response = new NodeResponse();
    await canaryTombstone(nodeRequest(request), response);
    return response.toResponse();
  }

  if (pathname === '/api' || pathname.startsWith('/api/')) {
    return jsonResponse({ error: 'Not found' }, 404);
  }

  return new Response(null, { status: 404 });
}

export default {
  async fetch(request) {
    try {
      return await handle(request);
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          service: 'trump-goggles-splash',
          operation: 'worker.request',
          error: error instanceof Error ? error.message : 'unknown error',
        })
      );
      return jsonResponse({ error: 'Internal server error' }, 500);
    }
  },
};