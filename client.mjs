// @ts-check
// Outbound transport for the gateway: impit on the okhttp profile by default,
// plain node fetch as an explicit option or fallback.

const DEFAULT_UA = 'okhttp/5.5.1'; // latest OkHttp release, 2026-10-22
const DEFAULT_BROWSER = 'okhttp5';

/**
 * Explicit value, then env, then default. Empty strings count as unset.
 * @param {string | undefined} explicit
 * @param {string} envName
 * @param {string} fallback
 * @returns {string}
 */
function setting(explicit, envName, fallback) {
  const value = (explicit ?? process.env[envName] ?? fallback).trim();
  return value === '' ? fallback : value;
}

/**
 * @param {string} ua
 * @returns {RelayClient}
 */
function nodeClient(ua) {
  return {
    label: 'node',
    fetch: (url, init = {}) => {
      const headers = { ...(init.headers ?? {}) };
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'user-agent')) {
        headers['user-agent'] = ua;
      }
      return fetch(url, { ...init, headers });
    },
  };
}

/**
 * @param {string} browser
 * @param {string} ua
 * @param {() => Promise<typeof import('impit')>} load
 * @returns {Promise<RelayClient>}
 */
async function impitClient(browser, ua, load) {
  const { Impit } = await load();
  const client = new Impit({
    browser: /** @type {import('impit').Browser} */ (browser),
    headers: { 'user-agent': ua },
  });
  return { label: `impit:${browser}`, fetch: (url, init) => client.fetch(url, init) };
}

/**
 * `UPSTREAM_CLIENT=node` forces plain fetch, anything else asks for impit and
 * falls back to node if the native module will not load.
 * @param {object} [opts]
 * @param {string} [opts.client]
 * @param {string} [opts.browser]
 * @param {string} [opts.ua]
 * @param {() => Promise<typeof import('impit')>} [opts.load]
 * @returns {Promise<RelayClient>}
 */
export async function createFetcher(opts = {}) {
  const requested = setting(opts.client, 'UPSTREAM_CLIENT', 'impit').toLowerCase();
  const ua = setting(opts.ua, 'UPSTREAM_UA', DEFAULT_UA);
  const browser = setting(opts.browser, 'UPSTREAM_BROWSER', DEFAULT_BROWSER);

  if (requested === 'node') return nodeClient(ua);
  if (requested !== 'impit') console.warn(`[netease-relay] unknown UPSTREAM_CLIENT=${requested}`);

  try {
    return await impitClient(browser, ua, opts.load ?? (() => import('impit')));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[netease-relay] impit unavailable (${reason}), using node fetch`);
    return nodeClient(ua);
  }
}
