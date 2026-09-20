const DEFAULT_SERVICE = 'trump-goggles-splash';

/**
 * Liveness check for the splash.
 *
 * Truthful and telemetry-independent: `status` reports site liveness only,
 * never error-delivery health. The retired Canary slot stays named so old
 * consumers can read a definitive state instead of a missing field.
 * Browser error monitoring now runs through Sentry (see
 * api/sentry-config.js and scripts/sentry.js) and is deliberately not
 * reported here as a readiness requirement.
 */
module.exports = function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.status(405).json({ status: 'error', error: 'Method not allowed' });
    return;
  }

  const body = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: DEFAULT_SERVICE,
    checks: {
      liveness: 'ok',
    },
    observability: {
      canary: {
        status: 'retired',
      },
    },
  };

  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.status(200);

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  res.json(body);
};