# NetEase relay

![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-5FA04E?logo=nodedotjs&logoColor=white)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)

One small node server that forwards the NetEase gateway lookups for Aurix.

Audio never touches it. NetEase returns direct CDN URLs, so only `types=search|url|pic|lyric` pass through.

## Why

Some hosts get refused by the gateway, usually a `503` with an nginx body, sometimes a Cloudflare level `520`/`522` when the call comes from that network. This moves the lookups to a plain host, so the adapter works unchanged.

## Run

```bash
npm start            # PORT defaults to 8080
npm test             # node --test, no deps
```

Env:

| Name | Default | What |
| --- | --- | --- |
| `PORT` | `8080` | listen port (`SERVER_PORT` also read, for Pterodactyl) |
| `PROXY_TOKEN` | empty | shared secret, checked against `x-aurix-token` |
| `UPSTREAM` | `https://music-api.gdstudio.xyz/api.php` | gateway endpoint |

Health check is `GET /health`, no token needed.

## Wire into Aurix

```env
NETEASE_API_BASE=https://<relay-host>
NETEASE_PROXY_TOKEN=<same value as PROXY_TOKEN>
```

`NETEASE_API_BASE` takes a bare origin (`/api.php` gets appended) or a full endpoint.

## Calls

| Status | Meaning |
| --- | --- |
| `200` | `{"url":"https://m7xx.music.126.net/...","br":320,"size":...}` |
| `403` | token missing or wrong |
| `400` | `types` or `source` failed the allowlist |
| `405` | not a GET |
| `502` | upstream body too large |
| `503` | upstream unreachable or 5xx, caller backs off |

## Rules

- GET only, one hard coded upstream, `types` allowlisted, `source` pinned to `netease`.
- `PROXY_TOKEN` compared in constant time. Set it, or anyone with the URL can use the relay.
- No request logging, so track ids and tokens stay out of stdout.
- Upstream 5xx is flattened to `503`, which the adapter already treats as backoff.
