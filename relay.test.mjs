// Node's own test runner, no deps. Fake upstream, so nothing here touches the
// network except 127.0.0.1.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRelayServer } from './relay.mjs';
import { createFetcher } from './client.mjs';

/** @typedef {import('node:http').Server} Server */
/** @typedef {{ url: string | null, ua: string | null, accept: string | null }} Forwarded */

/** @type {Forwarded[]} */
const seen = [];
/** @type {Server} */
let upstream;
/** @type {Server} */
let relay;
/** @type {Server} */
let noToken;
/** @type {string} */
let relayUrl;
/** @type {string} */
let noTokenUrl;

/**
 * @param {Server} srv
 * @returns {Promise<number>}
 */
const listen = (srv) =>
  new Promise((resolve) =>
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    }),
  );

before(async () => {
  upstream = createServer((req, res) => {
    seen.push({
      url: req.url ?? null,
      ua: req.headers['user-agent'] ?? null,
      accept: req.headers.accept ?? null,
    });
    if ((req.url ?? '').includes('boom=1')) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('nope');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ url: 'https://cdn.example/x.flac', br: 320, size: 42 }));
  });
  const upPort = await listen(upstream);
  const upUrl = `http://127.0.0.1:${upPort}/api.php`;

  relay = createRelayServer({ upstream: upUrl, token: 'secret' });
  relayUrl = `http://127.0.0.1:${await listen(relay)}`;

  noToken = createRelayServer({ upstream: upUrl });
  noTokenUrl = `http://127.0.0.1:${await listen(noToken)}`;
});

// fetch keeps sockets alive, so a plain close() can wait forever on the pool.
/**
 * @param {Server} srv
 * @returns {Promise<void>}
 */
const stop = (srv) =>
  new Promise((resolve) => {
    srv.closeAllConnections?.();
    srv.close(() => resolve());
  });

after(async () => {
  await stop(relay);
  await stop(noToken);
  await stop(upstream);
});

/**
 * @param {string} url
 * @param {{ method?: string, token?: string }} [opts]
 */
const call = (url, { method = 'GET', token } = {}) =>
  fetch(url, { method, headers: token ? { 'x-aurix-token': token } : {} });

test('health answers without a token', async () => {
  const res = await call(`${relayUrl}/health`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');
});

test('only GET gets through', async () => {
  const res = await call(`${relayUrl}/api.php?types=url&source=netease&id=1&br=320`, {
    method: 'POST',
    token: 'secret',
  });
  assert.equal(res.status, 405);
});

test('token is required when configured', async () => {
  const res = await call(`${relayUrl}/api.php?types=url&source=netease&id=1&br=320`);
  assert.equal(res.status, 403);
  const wrong = await call(`${relayUrl}/api.php?types=url&source=netease&id=1&br=320`, {
    token: 'nope',
  });
  assert.equal(wrong.status, 403);
});

test('types and source are pinned', async () => {
  const badType = await call(`${relayUrl}/api.php?types=playlist&source=netease`, {
    token: 'secret',
  });
  assert.equal(badType.status, 400);
  const badSource = await call(`${relayUrl}/api.php?types=url&source=tidal`, { token: 'secret' });
  assert.equal(badSource.status, 400);
});

test('a good call is forwarded verbatim and returned as json', async () => {
  const res = await call(`${relayUrl}/api.php?types=url&source=netease&id=28249129&br=999`, {
    token: 'secret',
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  const body = /** @type {{ url: string, br: number }} */ (await res.json());
  assert.equal(body.url, 'https://cdn.example/x.flac');
  assert.equal(body.br, 320);
  const last = seen.at(-1);
  assert.ok(last?.url?.includes('types=url'));
  assert.ok(last?.url?.includes('id=28249129'));
  assert.ok(last?.url?.includes('br=999'));
  assert.equal(last?.accept, 'application/json');
});

test('the relay leaves the agent string to the transport', async () => {
  /** @type {Record<string, string>} */
  let headers = {};
  const stub = createRelayServer({
    upstream: 'http://127.0.0.1:1/api.php',
    token: 'secret',
    fetchImpl: async (_url, init) => {
      headers = init?.headers ?? {};
      return {
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () => '{}',
      };
    },
  });
  const url = `http://127.0.0.1:${await listen(stub)}`;
  const res = await call(`${url}/api.php?types=search&source=netease&name=lofi`, {
    token: 'secret',
  });
  assert.equal(res.status, 200);
  assert.equal(headers.accept, 'application/json');
  assert.equal(headers['user-agent'], undefined);
  await stop(stub);
});

test('upstream 5xx becomes 503 so the caller backs off', async () => {
  const res = await call(`${relayUrl}/api.php?types=url&source=netease&id=1&boom=1`, {
    token: 'secret',
  });
  assert.equal(res.status, 503);
});

test('dead upstream becomes 503', async () => {
  // A throwing fetch keeps this instant and network free.
  const dead = createRelayServer({
    upstream: 'http://127.0.0.1:1/api.php',
    token: 'secret',
    fetchImpl: async () => {
      throw new Error('connect refused');
    },
  });
  const url = `http://127.0.0.1:${await listen(dead)}`;
  const res = await call(`${url}/api.php?types=url&source=netease&id=1`, { token: 'secret' });
  assert.equal(res.status, 503);
  await stop(dead);
});

test('no token configured means the token header is ignored', async () => {
  const res = await call(`${noTokenUrl}/api.php?types=search&source=netease&name=lofi`);
  assert.equal(res.status, 200);
});

/**
 * Replace global fetch for one call and report what went out.
 * @param {() => Promise<unknown>} fn
 */
const withStubbedFetch = async (fn) => {
  /** @type {Forwarded[]} */
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const h = new Headers(init?.headers);
    calls.push({ url: String(input), ua: h.get('user-agent'), accept: h.get('accept') });
    return new Response('{}');
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
  return calls;
};

test('node client sends the latest okhttp ua', async () => {
  const client = await createFetcher({ client: 'node', ua: 'okhttp/5.5.1' });
  assert.equal(client.label, 'node');
  const calls = await withStubbedFetch(() => client.fetch('https://example.test/x'));
  assert.equal(calls[0]?.ua, 'okhttp/5.5.1');
});

test('node client never overwrites a caller supplied ua', async () => {
  const client = await createFetcher({ client: 'node' });
  const calls = await withStubbedFetch(() =>
    client.fetch('https://example.test/x', { headers: { 'User-Agent': 'custom/1' } }),
  );
  assert.equal(calls[0]?.ua, 'custom/1');
});

test('env is read when no option is passed, and empty counts as unset', async () => {
  process.env.UPSTREAM_CLIENT = 'node';
  process.env.UPSTREAM_UA = 'okhttp/4.12.0';
  try {
    const client = await createFetcher();
    assert.equal(client.label, 'node');
    const calls = await withStubbedFetch(() => client.fetch('https://example.test/x'));
    assert.equal(calls[0]?.ua, 'okhttp/4.12.0');

    process.env.UPSTREAM_UA = '   ';
    const blank = await createFetcher();
    const again = await withStubbedFetch(() => blank.fetch('https://example.test/x'));
    assert.equal(again[0]?.ua, 'okhttp/5.5.1');
  } finally {
    delete process.env.UPSTREAM_CLIENT;
    delete process.env.UPSTREAM_UA;
  }
});

test('impit client is built with the chosen profile and ua', async () => {
  /** @type {Array<{ opts?: unknown, url?: string, init?: unknown }>} */
  const events = [];
  class FakeImpit {
    /** @param {{ browser: string, headers: Record<string, string> }} opts */
    constructor(opts) {
      events.push({ opts });
    }
    /**
     * @param {string} url
     * @param {unknown} init
     */
    fetch(url, init) {
      events.push({ url, init });
      return Promise.resolve(new Response('{}'));
    }
  }
  const client = await createFetcher({
    browser: 'okhttp5',
    ua: 'okhttp/5.5.1',
    load: async () => /** @type {any} */ ({ Impit: FakeImpit }),
  });
  assert.equal(client.label, 'impit:okhttp5');
  assert.deepEqual(events[0]?.opts, {
    browser: 'okhttp5',
    headers: { 'user-agent': 'okhttp/5.5.1' },
  });

  const init = { headers: { accept: 'application/json' } };
  await client.fetch('https://example.test/x', init);
  assert.equal(events[1]?.url, 'https://example.test/x');
  assert.equal(events[1]?.init, init);
});

/**
 * @param {RegExp} expected
 * @param {() => Promise<unknown>} run
 */
const expectWarnAndFallback = async (expected, run) => {
  /** @type {string[]} */
  const warnings = [];
  const real = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    const client = await createFetcher({
      load: async () => {
        throw new Error('cannot find native binding');
      },
    });
    assert.equal(client.label, 'node');
    assert.match(warnings[0] ?? '', expected);
    await run();
  } finally {
    console.warn = real;
  }
};

test('missing impit falls back to node without failing', async () => {
  await expectWarnAndFallback(/impit unavailable/, () => Promise.resolve());
});

test('an unknown client name is reported and still tries impit', async () => {
  /** @type {string[]} */
  const warnings = [];
  const real = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    const client = await createFetcher({
      client: 'curl',
      load: async () => {
        throw new Error('nope');
      },
    });
    assert.equal(client.label, 'node');
    assert.match(warnings.join('\n'), /unknown UPSTREAM_CLIENT=curl/);
  } finally {
    console.warn = real;
  }
});
