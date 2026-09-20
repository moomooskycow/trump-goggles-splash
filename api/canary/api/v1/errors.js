const DEFAULT_SERVICE = 'trump-goggles-splash';
const DEFAULT_ENDPOINT = 'https://canary.mistystep.io';
const DEFAULT_SITE_URL = 'https://www.trumpgoggles.com';
const DEFAULT_SITE_ALIASES = [
  'https://trumpgoggles.com',
  // Current Worker custom domain; it serves the same handlers on Cloudflare.
  'https://trumpgoggles.mistystep.io',
];
const MAX_BODY_BYTES = 32768;
const LOCAL_RELAY_LIMIT = 30;
const LOCAL_RELAY_WINDOW_MS = 60000;
const localRelayWindows = new Map();

const EMAIL_RE =
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(?<!\[EMAIL_REDACTED\])/g;
const BEARER_TOKEN_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const SECRET_PREFIX_RE =
  /\b(?:sk_(?:live|test)_[A-Za-z0-9_-]+|sntry[ou]_[A-Za-z0-9_-]+|re_[A-Za-z0-9_-]{12,}|ph[cx]_[A-Za-z0-9_-]{12,})\b/g;
const SECRET_ASSIGNMENT_RE =
  /\b(token|secret|password|api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|cookie|dsn)=([^&\s"'<>),;]+)/gi;
const SENSITIVE_KEY_RE =
  /(^|[-_])(authorization|cookie|set-cookie|token|secret|password|api[-_]?key|dsn|body|payload|raw)([-_]|$)/i;

function truncate(value, max) {
  return value.length <= max ? value : value.slice(0, max) + '...[truncated]';
}

function stripUrlSecrets(value) {
  return value.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (raw) => {
    try {
      const url = new URL(raw);
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      return raw.replace(/[?#].*$/, '');
    }
  });
}

function redactString(value, maxLength = 2048) {
  return truncate(
    stripUrlSecrets(String(value))
      .replace(EMAIL_RE, '[EMAIL_REDACTED]')
      .replace(BEARER_TOKEN_RE, 'Bearer [REDACTED]')
      .replace(SECRET_PREFIX_RE, '[REDACTED_SECRET]')
      .replace(SECRET_ASSIGNMENT_RE, function(_match, key) {
        return key + '=[REDACTED]';
      }),
    maxLength
  );
}

function sanitizeContextValue(value, depth, seen) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;

  if (Array.isArray(value)) {
    if (depth >= 4) return '[truncated]';
    return value
      .slice(0, 32)
      .map((entry) => sanitizeContextValue(entry, depth + 1, seen));
  }

  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    if (depth >= 4) return '[truncated]';
    seen.add(value);

    const output = {};
    Object.entries(value)
      .slice(0, 32)
      .forEach(([key, entry]) => {
        output[key] = SENSITIVE_KEY_RE.test(key)
          ? '[redacted]'
          : sanitizeContextValue(entry, depth + 1, seen);
      });
    return output;
  }

  return redactString(String(value));
}

function sanitizeContext(context) {
  if (!context || typeof context !== 'object') return undefined;
  const sanitized = sanitizeContextValue(context, 0, new WeakSet());
  return Object.keys(sanitized).length ? sanitized : undefined;
}

function coercePayload(input, extraContext) {
  if (!input || typeof input !== 'object') return null;
  const message =
    typeof input.message === 'string' && input.message.trim()
      ? input.message
      : null;
  if (!message) return null;

  const context =
    input.context && typeof input.context === 'object'
      ? { ...input.context, ...extraContext }
      : extraContext;

  return {
    error_class:
      typeof input.error_class === 'string' && input.error_class.trim()
        ? redactString(input.error_class, 256)
        : 'BrowserError',
    message: redactString(message, 2048),
    severity:
      input.severity === 'warning' || input.severity === 'info'
        ? input.severity
        : 'error',
    stack_trace:
      typeof input.stack_trace === 'string'
        ? redactString(input.stack_trace, 20000)
        : undefined,
    context: sanitizeContext(context),
    fingerprint: Array.isArray(input.fingerprint)
      ? input.fingerprint
          .filter((entry) => typeof entry === 'string')
          .map((entry) => redactString(entry, 256))
          .slice(0, 8)
      : undefined,
  };
}

function allowedOrigins(req) {
  const origins = new Set();
  origins.add(DEFAULT_SITE_URL);
  DEFAULT_SITE_ALIASES.forEach((origin) => origins.add(origin));
  if (process.env.NEXT_PUBLIC_SITE_URL) {
    try {
      origins.add(new URL(process.env.NEXT_PUBLIC_SITE_URL).origin);
    } catch {
      // Optional config; ignore invalid values.
    }
  }
  return origins;
}

function allowedHostnames(req) {
  return new Set(
    Array.from(allowedOrigins(req)).map((origin) => new URL(origin).host)
  );
}

function isAllowedOrigin(value, origins) {
  try {
    return origins.has(new URL(value).origin);
  } catch {
    return false;
  }
}

function normalizeHost(value) {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function requestHostsAreAllowed(req, allowed) {
  const host = normalizeHost(req.headers.host);
  const forwardedHost = normalizeHost(req.headers['x-forwarded-host']);

  if (!host || !allowed.has(host)) return false;
  if (forwardedHost && (!allowed.has(forwardedHost) || forwardedHost !== host)) {
    return false;
  }
  return true;
}

function trustedRelayOrigin(req) {
  const secFetchSite = req.headers['sec-fetch-site'];
  if (
    secFetchSite &&
    !['same-origin', 'same-site', 'none'].includes(secFetchSite)
  ) {
    return false;
  }

  const origins = allowedOrigins(req);
  if (!requestHostsAreAllowed(req, allowedHostnames(req))) return false;

  if (req.headers.origin) return isAllowedOrigin(req.headers.origin, origins);
  if (req.headers.referer) return isAllowedOrigin(req.headers.referer, origins);
  return false;
}

function lastForwardedAddress(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return null;
  const addresses = raw
    .split(',')
    .map((address) => address.trim())
    .filter(Boolean);
  return addresses.length ? addresses[addresses.length - 1] : null;
}

function clientKey(req) {
  return (
    // The Workers adapter supplies trustedClientIp from cf-connecting-ip,
    // which is set by the Cloudflare edge and cannot be spoofed by clients.
    // On the DigitalOcean sidecar the platform sets do-connecting-ip; keep
    // it first so client-supplied headers cannot rotate rate-limit buckets.
    req.trustedClientIp ||
    req.headers['do-connecting-ip'] ||
    lastForwardedAddress(req.headers['x-forwarded-for']) ||
    req.headers['cf-connecting-ip'] ||
    req.headers['x-real-ip'] ||
    'unknown'
  );
}

function logCanaryForwardFailure(details) {
  const endpoint = process.env.CANARY_ENDPOINT || DEFAULT_ENDPOINT;
  let endpointOrigin = DEFAULT_ENDPOINT;
  try {
    endpointOrigin = new URL(endpoint).origin;
  } catch {
    endpointOrigin = '[invalid]';
  }

  console.error(
    JSON.stringify({
      level: 'error',
      service: process.env.CANARY_SERVICE_NAME || DEFAULT_SERVICE,
      operation: 'forwardToCanary',
      endpoint: endpointOrigin,
      ...details,
    })
  );
}

function checkLocalLimit(req) {
  const now = Date.now();
  const key = clientKey(req);
  const current = localRelayWindows.get(key);
  if (!current || current.resetAt <= now) {
    localRelayWindows.set(key, {
      count: 1,
      resetAt: now + LOCAL_RELAY_WINDOW_MS,
    });
    return { allowed: true };
  }
  if (current.count >= LOCAL_RELAY_LIMIT) {
    return {
      allowed: false,
      retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
    };
  }
  current.count += 1;
  return { allowed: true };
}

function readBody(req) {
  if (req.body !== undefined) {
    return Promise.resolve(
      typeof req.body === 'string' ? req.body : JSON.stringify(req.body)
    );
  }

  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    req.on('data', (chunk) => {
      body += chunk;
      // Cap on UTF-8 bytes (same unit as the content-length header and the
      // Workers reader) so both runtimes enforce the same limit.
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error('payload_too_large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function forwardToCanary(payload) {
  const apiKey = process.env.CANARY_API_KEY;
  if (!apiKey) return 'disabled';

  const endpoint = (process.env.CANARY_ENDPOINT || DEFAULT_ENDPOINT).replace(
    /\/$/,
    ''
  );
  const body = JSON.stringify({
    service: process.env.CANARY_SERVICE_NAME || DEFAULT_SERVICE,
    environment:
      process.env.CANARY_ENVIRONMENT ||
      process.env.NODE_ENV ||
      'production',
    ...payload,
  });

  try {
    const response = await fetch(endpoint + '/api/v1/errors', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body,
      signal:
        typeof AbortSignal !== 'undefined' &&
        typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(2000)
          : undefined,
    });
    if (response.ok) return 'sent';

    logCanaryForwardFailure({
      status: response.status,
      statusText: redactString(response.statusText || 'non_ok_response', 256),
    });
    return 'failed';
  } catch (error) {
    logCanaryForwardFailure({
      error:
        error instanceof Error
          ? redactString(error.message, 512)
          : redactString(String(error), 512),
    });
    return 'failed';
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (!trustedRelayOrigin(req)) {
    res.status(403).json({ error: 'Invalid Canary relay origin' });
    return;
  }

  const length = Number(req.headers['content-length'] || 0);
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    res.status(413).json({ error: 'Canary event payload too large' });
    return;
  }

  const limit = checkLocalLimit(req);
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(limit.retryAfter));
    res.setHeader('RateLimit-Policy', LOCAL_RELAY_LIMIT + ';w=60');
    res.status(429).json({ error: 'Canary relay rate limit exceeded' });
    return;
  }

  let decoded;
  try {
    const rawBody = await readBody(req);
    decoded = JSON.parse(rawBody);
  } catch (error) {
    res
      .status(error && error.message === 'payload_too_large' ? 413 : 400)
      .json({ error: 'Invalid Canary event payload' });
    return;
  }

  const payload = coercePayload(decoded, {
    source: 'browser.relay',
    path: req.url,
    referrer: req.headers.referer || undefined,
    userAgent: req.headers['user-agent'] || undefined,
  });

  if (!payload) {
    res.status(400).json({ error: 'Invalid Canary event payload' });
    return;
  }

  const result = await forwardToCanary(payload);
  if (result === 'disabled') {
    res.status(503).json({ error: 'Canary is not configured' });
    return;
  }
  if (result === 'failed') {
    res.status(502).json({ error: 'Canary event delivery failed' });
    return;
  }

  res.status(202).json({ status: 'accepted' });
};

// The Workers entrypoint (src/worker.mjs) reuses this handler and its body
// cap; export the constant so the two runtimes cannot drift.
module.exports.MAX_BODY_BYTES = MAX_BODY_BYTES;

// The Workers adapter checks relay trust before reading request bodies;
// share the same predicate so the two runtimes cannot disagree.
module.exports.trustedRelayOrigin = trustedRelayOrigin;
