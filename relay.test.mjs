// Node's own test runner, no deps. Fake upstream, so nothing here touches the
// network except 127.0.0.1.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRelayServer } from './relay.mjs';

const seen = [];
let upstream;
let relay;
let noToken;
let relayUrl;
let noTokenUrl;

const listen = (srv) =>
  new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)));

before(async () => {
  upstream = createServer((req, res) => {
    seen.push({ url: req.url, ua: req.headers['user-agent'] });
    if (req.url.includes('boom=1')) {
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
const stop = (srv) =>
  new Promise((resolve) => {
    srv.closeAllConnections?.();
    srv.close(resolve);
  });

after(async () => {
  await stop(relay);
  await stop(noToken);
  await stop(upstream);
});

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
  assert.match(res.headers.get('content-type'), /application\/json/);
  const body = await res.json();
  assert.equal(body.url, 'https://cdn.example/x.flac');
  assert.equal(body.br, 320);
  const last = seen.at(-1);
  assert.ok(last.url.includes('types=url'));
  assert.ok(last.url.includes('id=28249129'));
  assert.ok(last.url.includes('br=999'));
  assert.equal(last.ua, 'okhttp/5.x.x');
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
