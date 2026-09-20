/**
 * Legacy Canary ingest relay — retired 2026-09-20.
 *
 * The Canary error pipeline is gone and this app does not replace it with a
 * relay. This route is deliberately a tombstone: every method answers 410,
 * it never reads, stores, logs, or forwards a request body, it discloses no
 * keys or endpoints, and it enables no CORS. Kept until a separate removal
 * decision deletes the path entirely.
 */
const TOMBSTONE = { status: 'retired', service: 'canary' };

module.exports = function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(410);

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  res.json(TOMBSTONE);
};