# Running JEV-Arcade for other people

The README's quick start runs the arcade on your own machine. This page is about keeping one
running: in Docker, updated, backed up and, if you want, on a domain of your own. The public site,
[jev-arcade.com](https://jev-arcade.com), runs exactly this way: `compose.yaml`, a second compose
file for the tunnel, and one `.env`.

## What you are running

One container, `wikirace`, built from the `Dockerfile`: Python 3.14, the project installed from
`uv.lock`, listening on port 8000 inside the container as an unprivileged user (uid 10001), with
its history in `/data/wikirace.db` on the `wikirace-data` volume. It fetches nothing but Wikipedia
and the providers your keys name.

Everything is configured by `.env`, which `compose.yaml` hands to the container. `WIKIRACE_HOST`,
`WIKIRACE_DB` and the port inside the container are fixed by `compose.yaml` and override anything
in `.env`; `WIKIRACE_PORT` in `.env` sets the port published on the host.

## First start

```bash
cp env.example .env       # then the keys, or OLLAMA_BASE_URL
docker compose up -d --build
docker compose logs -f wikirace
```

The log's first lines are the same summary `wikirace` prints on your machine: which providers are
ready and with which models, and any setting that was ignored (`! …`). Then open
<http://localhost:8008>, or whatever `WIKIRACE_PORT` says. The container reports `healthy` once
`/api/health` answers; `docker compose ps` shows it.

## Updating

```bash
git pull
docker compose up -d --build
```

The build reinstalls dependencies only when `uv.lock` changed. A running race or game is stopped
and recorded as `stopped` (`stop_grace_period: 10s` gives it time to be written); a page watching
one reconnects when the server is back. The page's files are served under an address that changes
with their contents (`/v/<fingerprint>/`), so a visitor's browser, or a CDN in front, picks up the
new version on the next load.

## Backing up the history

The history is one SQLite file in WAL mode, so while the server runs, copy it with SQLite rather
than `cp`:

```bash
docker compose exec wikirace python -c "import sqlite3; s = sqlite3.connect('/data/wikirace.db'); d = sqlite3.connect('/data/backup.db'); s.backup(d); d.close()"
docker compose cp wikirace:/data/backup.db ./wikirace-backup.db
```

To restore, stop the arcade, copy the file back as `/data/wikirace.db`, and start it again:

```bash
docker compose stop wikirace
docker compose cp ./wikirace-backup.db wikirace:/data/wikirace.db
docker compose start wikirace
```

A race that was running when the server stopped is stamped `interrupted` at the next start, and
its replay shows what it had. Deleting a race or run from its history (`DELETE /api/races/{id}`,
`DELETE /api/games/runs/{id}`) removes its row; nothing else ever deletes history.

## Cost control

There is no login: everyone who reaches the page plays on the keys in `.env`. What keeps a public
site affordable:

- **Only the providers you mean to pay for** in `.env`. The public site offers Jev and one free
  OpenRouter model. A visitor can still type any other model id of a text provider you have a key
  for, so set a spending limit at the provider too.
- `WIKIRACE_MAX_RACES` (default 2) caps the races running at once; the Arcade allows four runs at
  once across every game. A race is bounded by its hop and time limits (12 hops and one minute by
  default; a visitor may raise them to 40 hops and an hour).
- Spending limits at the providers themselves: every one of them offers a monthly cap.
- Nothing rate-limits a visitor. If a public site draws abuse, put the limit in the proxy in front
  (Cloudflare's rate-limiting rules, say), not in the arcade.

## Your own domain

The arcade serves plain http. Put a proxy or tunnel that terminates TLS in front, and tell the
arcade its public name:

```ini
WIKIRACE_CANONICAL_HOST=example.com
```

With that, the page answers to `example.com` and `www.example.com` (they need not be in
`WIKIRACE_ALLOWED_HOSTS`), and sends `www.example.com`, and plain http as the proxy reports it in
`X-Forwarded-Proto`, to `https://example.com` with the path and query kept: a 301 for a page load, a
308 for anything else, so a POST stays a POST. Every view then carries its canonical address, and
`https://example.com/sitemap.xml` lists the views for a search console. `localhost` is left alone,
so the same container still answers on your machine.

### A Cloudflare Tunnel, as an example

The tunnel runs as a second container on the compose project's own network and reaches the arcade
as `http://wikirace:8000`: no port is opened to the internet, and the `127.0.0.1` port publication
in `compose.yaml` stays as it is. Keep it in a second compose file, which git ignores
(`compose.*.yaml`):

```yaml
# compose.tunnel.yaml: this deployment's tunnel, beside compose.yaml
services:
  wikirace:
    volumes:
      - ./site-root:/site-root:ro
    environment:
      WIKIRACE_SITE_ROOT: /site-root

  tunnel:
    image: cloudflare/cloudflared:latest
    command: tunnel --no-autoupdate run
    environment:
      TUNNEL_TOKEN: ${CLOUDFLARE_TUNNEL_TOKEN:?set CLOUDFLARE_TUNNEL_TOKEN in .env}
    depends_on:
      wikirace:
        condition: service_healthy
    restart: unless-stopped
```

1. In Cloudflare Zero Trust, create a tunnel (Networks, Tunnels) and copy its token into `.env` as
   `CLOUDFLARE_TUNNEL_TOKEN`.
2. Give the tunnel two public hostnames, `example.com` and `www.example.com`, both to the service
   `HTTP` at `wikirace:8000`. Not `localhost`: inside the tunnel's container, localhost is the
   tunnel itself.
3. Name both files in `.env`, so a plain `docker compose up -d --build` starts them together:

   ```ini
   COMPOSE_FILE=compose.yaml:compose.tunnel.yaml    # ";" instead of ":" on Windows
   WIKIRACE_CANONICAL_HOST=example.com
   CLOUDFLARE_TUNNEL_TOKEN=...
   ```

Any other proxy works the same way (Caddy, nginx, Traefik): forward to the arcade and pass
`X-Forwarded-Proto`, so the http-to-https redirect can tell the two apart.

### The site's own files

`WIKIRACE_SITE_ROOT` names a folder served at the site's root after the page's own files, for what
a deployment needs at a fixed address: a search console's verification file, say. In the compose
file above it is `./site-root`, mounted read-only; drop a file in and it is served, with no rebuild.
`site-root/` is ignored by git.

### Search engines

The server writes each view its own `<head>` (title, description, canonical link, Open Graph and
Twitter cards, JSON-LD), so nothing more is needed for the page to be indexed. Submit
`https://example.com/sitemap.xml` to Google Search Console, verifying ownership with a file in
`site-root/`; `robots.txt` names the sitemap too. Single races and runs are `noindex`, so replays do
not crowd the results.

## Answering to other names

Without a canonical host, the page answers only to `localhost` and `127.0.0.1`; a request under
another name is refused with a 400 before it can start anything (a guard against DNS rebinding).
To open it on your own network under the machine's name or address:

```ini
WIKIRACE_ALLOWED_HOSTS=arcade.lan, 192.168.1.20
```

and drop the `127.0.0.1:` from the `ports` line in `compose.yaml` (or set `WIKIRACE_HOST=0.0.0.0`
when running with `uv run wikirace`). Then anyone on the network can spend your keys; see
[Cost control](#cost-control).

## Ollama from Docker

`localhost` in `OLLAMA_BASE_URL` still means your machine: inside the image it is rewritten to
`host.docker.internal`, which `compose.yaml` maps to the host on Linux too. An Ollama elsewhere on
the network is just its address (`http://192.168.1.20:11434`). Ollama must itself listen beyond
loopback for a container to reach it (`OLLAMA_HOST=0.0.0.0` on the Ollama side).

## Troubleshooting

| You see | It means |
|---|---|
| `Invalid host header` (400) | the name in the address bar is not in `WIKIRACE_ALLOWED_HOSTS`, nor the canonical host |
| a provider `off` in the log | its key is missing from `.env`; the summary names the variable |
| `! OPENAI_THINKING: …` in the log | a setting was misspelt and ignored; the setup shows the same warning |
| Ollama's models missing from the setup | Ollama did not answer within 5 s; the setup's reload button asks again |
| a race `interrupted` in the history | the server restarted while it ran |
| the page looks old after an update | the image was not rebuilt: `docker compose up -d --build`, then check `docker compose ps` |

`docker compose logs wikirace` has the server's log, and `GET /api/health` says which version is
running.
