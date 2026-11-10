// Aurix NetEase relay. Plain node, no deps, one job: forward the four JSON
// lookups to the gateway and nothing else.
import { createServer as httpServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const DEFAULT_UPSTREAM = 'https://music-api.gdstudio.xyz/api.php';
const ALLOWED_TYPES = new Set(['search', 'url', 'pic', 'lyric']);
const TIMEOUT_MS = 9000;
// Gateway answers are small JSON. Anything huge is not ours.
const MAX_BYTES = 512 * 1024;
// Same UA the Android client sends. The gateway is friendlier to it than to
// node's default, and it costs us nothing to look like the thing it expects.
const USER_AGENT = 'okhttp/5.x.x';

function plain(status, text) {
  return {
    status,
    body: text,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  };
}

// Constant time, so nobody probes the secret char by char.
function sameSecret(given, expected) {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function createRelayServer(opts = {}) {
  const upstream = (opts.upstream ?? DEFAULT_UPSTREAM).trim();
  const token = (opts.token ?? '').trim();
  const doFetch = opts.fetchImpl ?? fetch;

  return httpServer(async (req, res) => {
    const send = (r) => {
      res.writeHead(r.status, r.headers);
      res.end(r.body);
    };

    if (req.method !== 'GET') return send(plain(405, 'method not allowed'));

    const url = new URL(req.url || '/', 'http://relay');
    // Health check for the host, no token, no upstream call.
    if (url.pathname === '/health') return send(plain(200, 'ok'));

    // Token set? must match.
    if (token) {
      const given = req.headers['x-aurix-token'];
      if (typeof given !== 'string' || !sameSecret(given, token)) return send(plain(403, 'forbidden'));
    }

    const types = url.searchParams.get('types') || '';
    if (!ALLOWED_TYPES.has(types)) return send(plain(400, 'bad types'));
    if ((url.searchParams.get('source') || '') !== 'netease') return send(plain(400, 'bad source'));

    const target = new URL(upstream);
    for (const [k, v] of url.searchParams) target.searchParams.set(k, v);

    let up;
    try {
      up = await doFetch(target, {
        headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      // 503 = back off signal for the caller's circuit breaker.
      return send(plain(503, 'upstream unreachable'));
    }

    if (up.status >= 500) return send(plain(503, `upstream ${up.status}`));

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

// `node relay.mjs` only. Imported by the tests, so nothing starts on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Pterodactyl hands the allocation over as SERVER_PORT, most hosts use PORT.
  const port = Number(process.env.PORT || process.env.SERVER_PORT || 8080);
  const token = process.env.PROXY_TOKEN || '';
  const upstream = process.env.UPSTREAM || DEFAULT_UPSTREAM;
  const server = createRelayServer({ upstream, token });
  server.listen(port, '0.0.0.0', () => {
    console.log(`[netease-relay] listening on ${port}${token.trim() ? '' : ' (no token set)'}`);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => server.close(() => process.exit(0)));
  }
}
