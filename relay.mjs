// @ts-check
// Forwards the gateway's JSON lookups. Transport lives in client.mjs.
import { createServer as httpServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createFetcher } from './client.mjs';

const DEFAULT_UPSTREAM = 'https://music-api.gdstudio.xyz/api.php';
const ALLOWED_TYPES = new Set(['search', 'url', 'pic', 'lyric']);
const TIMEOUT_MS = 9000;
const MAX_BYTES = 512 * 1024;

/**
 * @param {number} status
 * @param {string} text
 * @returns {{ status: number, body: string, headers: Record<string, string> }}
 */
function plain(status, text) {
  return {
    status,
    body: text,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  };
}

/**
 * Constant time, so the token cannot be probed char by char.
 * @param {string} given
 * @param {string} expected
 * @returns {boolean}
 */
function sameSecret(given, expected) {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * @param {object} [opts]
 * @param {string} [opts.upstream]
 * @param {string} [opts.token]
 * @param {RelayFetcher} [opts.fetchImpl] defaults to plain node fetch
 * @returns {import('node:http').Server}
 */
export function createRelayServer(opts = {}) {
  const upstream = (opts.upstream ?? DEFAULT_UPSTREAM).trim();
  const token = (opts.token ?? '').trim();
  const doFetch = opts.fetchImpl ?? fetch;

  return httpServer(async (req, res) => {
    /** @param {{ status: number, body: string, headers: Record<string, string> }} r */
    const send = (r) => {
      res.writeHead(r.status, r.headers);
      res.end(r.body);
    };

    if (req.method !== 'GET') return send(plain(405, 'method not allowed'));

    const url = new URL(req.url || '/', 'http://relay');
    if (url.pathname === '/health') return send(plain(200, 'ok'));

    if (token) {
      const given = req.headers['x-aurix-token'];
      if (typeof given !== 'string' || !sameSecret(given, token)) return send(plain(403, 'forbidden'));
    }

    const types = url.searchParams.get('types') || '';
    if (!ALLOWED_TYPES.has(types)) return send(plain(400, 'bad types'));
    if ((url.searchParams.get('source') || '') !== 'netease') return send(plain(400, 'bad source'));

    const target = new URL(upstream);
    for (const [k, v] of url.searchParams) target.searchParams.set(k, v);

    /** @type {RelayResponse} */
    let up;
    try {
      up = await doFetch(target, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return send(plain(503, 'upstream unreachable'));
    }

    if (up.status >= 500) return send(plain(503, `upstream ${up.status}`));

    /** @type {string} */
    let body;
    try {
      body = await up.text();
    } catch {
      return send(plain(503, 'upstream body failed'));
    }
    if (Buffer.byteLength(body) > MAX_BYTES) return send(plain(502, 'upstream body too big'));

    res.writeHead(up.status, {
      'content-type': up.headers.get('content-type') || 'application/json',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
  });
}

// Only when run directly, so importing this file in tests starts nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || process.env.SERVER_PORT || 8080);
  const token = process.env.PROXY_TOKEN || '';
  const upstream = process.env.UPSTREAM || DEFAULT_UPSTREAM;
  const client = await createFetcher();
  const server = createRelayServer({ upstream, token, fetchImpl: client.fetch });
  server.listen(port, '0.0.0.0', () => {
    console.log(
      `[netease-relay] listening on ${port} transport=${client.label}${token.trim() ? '' : ' (no token set)'}`,
    );
  });
  for (const sig of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
    process.on(sig, () => server.close(() => process.exit(0)));
  }
}
