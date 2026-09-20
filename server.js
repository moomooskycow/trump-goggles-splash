#!/usr/bin/env node
'use strict';

const http = require('node:http');
const health = require('./api/health');
const sentryConfig = require('./api/sentry-config');
const canaryTombstone = require('./api/canary/api/v1/errors');

const SERVICE = 'trump-goggles-splash';

const routes = new Map([
  ['/api/health', health],
  ['/api/sentry-config', sentryConfig],
  ['/api/canary/api/v1/errors', canaryTombstone],
]);

function adaptResponse(response) {
  response.status = function status(code) {
    this.statusCode = code;
    return this;
  };
  response.json = function json(body) {
    if (!this.hasHeader('Content-Type')) {
      this.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    this.end(JSON.stringify(body));
    return this;
  };
  return response;
}

const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const handler = routes.get(pathname);
  if (!handler) {
    response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  try {
    await handler(request, adaptResponse(response));
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        service: SERVICE,
        operation: 'request',
        error: error instanceof Error ? error.message : 'unknown error',
      })
    );
    if (!response.headersSent) {
      response.writeHead(500, {
        'Content-Type': 'application/json; charset=utf-8',
      });
    }
    if (!response.writableEnded) {
      response.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }
});

const port = Number(process.env.PORT || 8080);
server.listen(port, '0.0.0.0', () => {
  console.log(JSON.stringify({ level: 'info', service: SERVICE, port }));
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);