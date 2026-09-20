/* global console, Headers, Request, Response, URL */

import health from '../api/health.js';
import relay from '../api/canary/api/v1/errors.js';

/**
 * Cloudflare Worker entry for the Trump Goggles splash.
 *
 * `server.js` owns the routing contract for the dependency-free Node
 * sidecar; this worker mirrors it for the Workers runtime so every hostname
 * that serves the site (trumpgoggles.mistystep.io today; trumpgoggles.com
 * and www.trumpgoggles.com after the registrar flip) serves the same
 * routes:
 *
 *   - GET|HEAD /api/health            -> api/health.js
 *   - POST /api/canary/api/v1/errors  -> api/canary/api/v1/errors.js
 *
 * Static assets keep being served by the assets layer; only /api/*
 * requests and non-asset paths reach this script (see `assets` in
 * wrangler.jsonc). Non-API paths 404 exactly like the assets-only
 * deployment did. `src/` is kept out of the asset store by .assetsignore.
 *
 * The api/ handlers read configuration from process.env (nodejs_compat),
 * with the same names as the sidecar: CANARY_API_KEY, CANARY_ENDPOINT,
 * CANARY_SERVICE_NAME, CANARY_ENVIRONMENT, NEXT_PUBLIC_SITE_URL.
 */

const MAX_BODY_BYTES = relay.MAX_BODY_BYTES;

function jsonResponse(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/** Adapts a Fetch API request to the req shape the api/ handlers expect. */
function nodeRequest(request, body) {
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
    body,
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

  if (pathname === '/api/canary/api/v1/errors') {
    let body;
    if (request.method === 'POST') {
      const declared = Number(request.headers.get('content-length') || 0);
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        return jsonResponse({ error: 'Canary event payload too large' }, 413);
      }
      body = await request.text();
      if (body.length > MAX_BODY_BYTES) {
        return jsonResponse({ error: 'Canary event payload too large' }, 413);
      }
    }
    const response = new NodeResponse();
    await relay(nodeRequest(request, body), response);
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
