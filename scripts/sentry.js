/**
 * Sentry browser bootstrap for a static site.
 *
 * Reads the same-origin config endpoint (injectable at deploy through the
 * SENTRY_* environment; see api/sentry-config.js) and loads the official
 * @sentry/browser bundle from Sentry's CDN only when it is enabled. Errors
 * travel from the SDK straight to Sentry ingest: this app owns no relay and
 * stores nothing. Disabled config is a truthful no-op.
 */
(function() {
  'use strict';

  var CONFIG_PATH = '/api/sentry-config';
  var SDK_VERSION = '10.70.0';
  var SDK_URL =
    'https://browser.sentry-cdn.com/' + SDK_VERSION + '/bundle.min.js';
  var EXTENSION_URLS = [
    /^chrome-extension:\/\//,
    /^moz-extension:\/\//,
    /^safari-extension:\/\//,
  ];

  // Error capture only: never ship identity or request material that may
  // carry secrets (headers, cookies, bodies).
  function sanitizeEvent(event) {
    if (!event || typeof event !== 'object') return event;
    delete event.user;
    if (event.request && typeof event.request === 'object') {
      delete event.request.headers;
      delete event.request.cookies;
      delete event.request.data;
    }
    return event;
  }

  function init(dsn, config) {
    if (!window.Sentry || typeof window.Sentry.init !== 'function') return;

    window.Sentry.init({
      dsn: dsn,
      environment: config.environment,
      release: config.release || undefined,
      sendDefaultPii: false,
      denyUrls: EXTENSION_URLS.slice(),
      beforeSend: sanitizeEvent,
    });
  }

  function loadSdk(onReady) {
    var script = document.createElement('script');
    script.src = SDK_URL;
    script.crossOrigin = 'anonymous';
    script.onload = onReady;
    script.onerror = function() {
      // Reporting must never affect the page.
    };
    document.head.appendChild(script);
  }

  function boot() {
    if (typeof fetch !== 'function') return;

    fetch(CONFIG_PATH, { headers: { Accept: 'application/json' } })
      .then(function(response) {
        return response.ok ? response.json() : null;
      })
      .then(function(config) {
        if (!config || config.enabled !== true || !config.dsn) return;
        loadSdk(function() {
          init(config.dsn, config);
        });
      })
      .catch(function() {
        // Reporting must never affect the page.
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();