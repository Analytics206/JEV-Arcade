# Traffic, sign-ins and enquiries

JEV-Arcade keeps three records about the people who use it, and shows them on admin pages that
only the admin can read:

- **The traffic log**: every request the server answers.
- **The sign-in log**: every admin sign-in, sign-out and failed attempt.
- **Enquiries**: a copy of every message sent from the Contact page.

This page says what each one holds, where it lives, how to set it up, and how to delete one
person's data. The code is `src/wikirace/traffic.py`, `logins.py`, `enquiries.py` and
`admin.py`; the pages are `src/wikirace/static/admin/`.

## The admin

The arcade has no accounts. The admin pages have one: an email and a password, set in `.env`.

```bash
uv run wikirace --hash-password            # or: docker compose run --rm wikirace wikirace --hash-password
```

It asks for the password twice (at least 12 characters), without echo, and prints one line:

```ini
WIKIRACE_ADMIN_EMAIL=you@example.com
WIKIRACE_ADMIN_PASSWORD_HASH=scrypt:32768:8:1:…:…
```

Put both in `.env` and restart. The password itself is never stored anywhere, only its scrypt
hash, written without `$` so Docker Compose does not read part of it as a variable. With either
line missing or malformed, nobody can sign in, and the server's start-up summary says why.

Then open **`/admin`** (for example `https://jev-arcade.com/admin`). Nothing on the public site
links there, and `robots.txt` does not name it (that would advertise it); the page is sent with
`X-Robots-Tag: noindex`. Hiding it is not what protects it: every `/api/admin/*` request checks
the session on the server.

- A sign-in lasts 12 hours. The session is a random token in an `HttpOnly`, `SameSite=Strict`
  cookie scoped to `/api/admin` (`Secure` over https). The server keeps only the token's SHA-256,
  so a copy of the database signs nobody in.
- Changing `WIKIRACE_ADMIN_PASSWORD_HASH` or `WIKIRACE_ADMIN_EMAIL` ends every session at once.
- Failed sign-ins are limited to 5 per address and 30 in all per 15 minutes. Past that the
  password is not even checked, and the page says how long to wait.
- A request that changes something must come from the site's own page (its `Origin`).

## The admin pages

**Traffic** (`/admin`) opens with the **enquiries** waiting for you, then the traffic report:

- A period (24 hours to all time) and an audience: people, bots or everyone.
- Totals: page views, visitors, requests, bot requests, 4xx and 5xx errors, the median time to
  answer, data sent, and the median page load time the browsers reported.
- Page views and visitors over time, by hour for 24 hours and by day otherwise (UTC).
- Top pages, referrers, countries, browsers, systems, devices, bots, 404s, screen and window
  sizes, time zones, and the busiest addresses. A name in a list filters the request log to it.
- The request log itself: filters (kind, status, address, path, country, free text), every field
  of a row on a click, 50 rows a page, and **Download CSV** of everything the filters match (up
  to 100,000 rows).

**Sign-ins** (`/admin?view=signins`) is the sign-in log, verified and unverified rows apart, and
below it what the admin did (enquiries handled, reopened, deleted).

**Enquiries** show the whole message, **Reply by email** (a `mailto:` link to the sender),
**Mark handled** (or back to waiting) and **Delete**.

Everything on these pages was written by strangers: paths, user agents, referrers, names,
messages. It is shown as text, never as markup, and a CSV cell that starts like a spreadsheet
formula (`=`, `+`, `-`, `@`) gets a leading `'` so it is shown, not run.

## The traffic log

### What is kept

One row per request, written by a middleware around the whole server, so redirects, refused
hosts and 404s are logged as well as pages. The server writes rows from a queue in batches, off
the request's path: a request never waits on the log, and a log that cannot be written never
fails a request.

| | Fields |
|---|---|
| The request | time, method, host, path, query, protocol, status, bytes sent, time to answer |
| Who | the address (below), the connection's own peer, `X-Forwarded-For` as sent |
| Cloudflare | country, continent, data centre (from the ray ID), ray ID; with visitor location headers on (below): city, region, region code, postcode, latitude, longitude, time zone |
| The browser | user agent, and read from it: browser, version, system, device (desktop, mobile, tablet, bot), bot or not, bot name; `Accept-Language`; the client hints `Sec-CH-UA`, `-Mobile`, `-Platform`; `Sec-Fetch-Site`, `-Mode`, `-Dest`; the referrer and its host |
| The beacon | screen size, window size, pixel ratio, time zone, page load time, view |

**The address** is Cloudflare's `CF-Connecting-IP` (which Cloudflare overwrites, so a visitor
cannot forge it), else the rightmost `X-Forwarded-For` entry (the one the nearest proxy added; the
leftmost is whatever the client wrote), else the connection's peer. Behind the tunnel the peer is
the tunnel, so the first is the one that counts. If you ever expose the server directly instead of
through Cloudflare, a client could send its own `CF-Connecting-IP`; put a proxy that overwrites it
in front.

**The beacon.** Once a page has loaded, it posts what only the browser knows to `/api/beacon`.
It sets no cookie and stores no identifier. The beacon's own request row carries those fields, and
since it describes a page view already counted, **beacon rows are in no total**.

**Never kept:** the `Authorization` and `Cookie` headers, and any secret in a query string or a
referrer. A parameter whose name says it is a credential (`token`, `key`, `apiKey`, `code`,
`oobCode`, `password`, `secret`, `session`, `signature`, `state`, `nonce`, `otp` and the like)
keeps its name and loses its value (`token=REDACTED`). A referrer also loses any `user:password@`
and its `#fragment`. A password-reset link in a log is not a way to reset a password.

**Not logged at all:** the container's own healthcheck (`/api/health` from `127.0.0.1`, with no
proxy headers), which would otherwise be 2,880 fake visits a day. The same address asked through
the tunnel is logged.

### What the numbers mean

- **A page view** is a load of the page (`/` with any query) that answered 2xx. Moving between
  views inside the page (WikiRace to a game) loads nothing, so it is not another page view; the
  beacon's `view` says where a visit landed.
- **A visitor** is an address that loaded the page. There is no cookie, so two people behind one
  address are one visitor, and one person on two networks is two.
- **Kinds**: `page`, `asset` (the page's files), `api`, `admin` (the admin pages and their
  requests, your own included), `beacon`, `other` (redirects, robots.txt, 404s for paths that do
  not exist).
- **Bots** are told apart by their user agent (crawlers, link previewers, scripts, scanners, and
  no user agent at all). A bot that sends a browser's user agent is counted as a person.
- **Cached files are not seen.** The page's files are sent as immutable, so Cloudflare may answer
  repeat requests for them from its cache without asking the server. Page loads and API calls
  always reach it.

### Where it lives

`traffic.db`, beside the history (`/data/traffic.db` on the Docker volume, `data/traffic.db` with
`uv run`), a separate SQLite file from `wikirace.db`. The log is large and disposable, the history
small and worth a backup, and a burst of log writes never holds the history's lock. Back up
`wikirace.db` as [deploy.md](deploy.md#backing-up-the-history) says; `traffic.db` need not be.

Rows older than `WIKIRACE_LOG_RETENTION_DAYS` (365) are deleted at start-up and every six hours,
and the space goes back to the disk.

## The sign-in log

The server checks every sign-in itself, so it logs it itself; the page reports nothing.

| Event | Verified | Email |
|---|---|---|
| `signed_in` | yes | the admin's |
| `signed_out` | yes | the admin's (a sign-out of a live session) |
| `sign_in_failed` | **no** | **only what was typed** |

A failed attempt's email is a sign that someone is trying an address, not a fact about whoever
owns it. The page shows those rows apart, in amber, and says so. Attempts refused by the rate
limit are not written here (they would let anyone fill the log); they are in the traffic log as
`429` on `/api/admin/login`.

Each row keeps the time, the address, country and city (from Cloudflare), the user agent and what
it reads as, the reason a sign-in failed, and for a session the first characters of its hash (to
pair a sign-in with its sign-out) and when it ends. **Never** the password, typed or stored, nor
the session token.

It lives in `wikirace.db`, in the `signins` table, and follows the same retention as the traffic
log. What the admin did is in `admin_audit`, with no address and no enquirer's email, and is not
pruned.

## Enquiries

The Contact page (`?tab=contact`) shows the email (contact@JEV-Arcade.com) and phone
(510-560-5429), as the footer of every page does, and a form. On **Open in my email app**, the
page first posts a copy to `POST /api/contact`, waiting at most 1.5 seconds and carrying on
whatever happens, then opens the visitor's own email app with the message written in. That email
is what reaches you; the server sends no mail. The visitor is not told about the copy: "we have
your message" would invite them not to send it.

The copy keeps the name, email, message, time, address, country and user agent, in `wikirace.db`
(`enquiries`), the database worth a backup. Enquiries are never deleted except by you.

The endpoint is open to anyone, so it is fenced:

- 5 messages per address per 10 minutes, 60 in all per 10 minutes.
- The same email and message again within 10 minutes is not stored twice.
- A field hidden from people, `cabinet_code`, is filled in only by scripts that fill in
  everything. It is named after nothing a browser autofills (not `website`, `phone` or `url`), so a
  real visitor's message is never thrown away. A trap or a repeat answers exactly as a success.
- Name at most 200 characters, email 254, message 5,000; a body over 16 KB is refused unread.

## Settings

| Variable | Default | |
|---|---|---|
| `WIKIRACE_ADMIN_EMAIL` | none | the admin's email; with the hash, switches the admin pages on |
| `WIKIRACE_ADMIN_PASSWORD_HASH` | none | what `wikirace --hash-password` prints |
| `WIKIRACE_LOG_RETENTION_DAYS` | `365` | days the traffic and sign-in logs keep a row (1–3650) |
| `WIKIRACE_TRAFFIC_DB` | `traffic.db` beside `WIKIRACE_DB` | where the traffic log is |
| `WIKIRACE_TRAFFIC_LOG` | `on` | `off` stops the traffic log (the beacon is then ignored) |

### Cloudflare's visitor location

Country and data centre come with every request through Cloudflare. City, region, postcode,
coordinates and time zone come only with **visitor location headers** switched on: in the
Cloudflare dashboard, your domain, **Rules > Settings > Managed Transforms**, turn on **Add visitor
location headers**. Nothing else is needed; the next requests carry them.

## Privacy

The logs hold IP addresses, approximate locations, emails (the admin's, what was typed into the
sign-in form, the enquirers') and names and messages. A privacy notice on the site should say
that these are collected, why (running and securing the site, answering messages), for how long
(365 days for the logs, until deleted for enquiries), and how to ask for deletion. The site has
no such notice yet.

### One person's data

To delete everything kept about one person, by address and by email, run this with their values
(it prints how many rows went from each):

```bash
docker compose exec wikirace python -c "
from wikirace import enquiries, logins, traffic
ip, email = '203.0.113.9', 'them@example.com'
print('traffic', traffic.forget('/data/traffic.db', ip))
print('sign-ins', logins.forget('/data/wikirace.db', ip=ip, email=email))
print('enquiries', enquiries.forget('/data/wikirace.db', email))
"
```

With `uv run`, the paths are `data/traffic.db` and `data/wikirace.db`. A person whose address
changes (most home connections do) may have rows under several; search the request log for them
first. Backups of `wikirace.db` made before the deletion still hold their enquiries.

To see what is kept about someone before deleting it, filter the request log by their address, or
download the CSV.

## Troubleshooting

| You see | It means |
|---|---|
| `Admin sign-in is off` (503) on `/admin` | `WIKIRACE_ADMIN_EMAIL` or `WIKIRACE_ADMIN_PASSWORD_HASH` is missing; the start-up summary's `!` line says which, or that the hash is malformed |
| "That email and password do not match." | either is wrong; the email is not case-sensitive |
| "Too many attempts. Try again in N min." | 5 failures from your address (or 30 in all) in 15 minutes; wait, or restart the server to clear the count |
| signed out for no reason | the session is 12 hours, or the password or email in `.env` changed |
| every visitor has the same address (the tunnel's or `172.x`) | the requests do not come through Cloudflare, or a proxy in between drops `CF-Connecting-IP` and `X-Forwarded-For` |
| no city, region or coordinates | Cloudflare's visitor location headers are off (see above) |
| no country at all | the request did not come through Cloudflare (on your own network, say) |
| the report is empty | the period is too short, or the audience is People and only bots came; try Everyone. `WIKIRACE_TRAFFIC_LOG=off` says so at the foot of the page |
| page views lower than you expect | moving between views in the page is not a page load, and Cloudflare-cached files are not seen |
| no "Median load" or screen sizes | the beacon is blocked (some content blockers do), or JavaScript is off |
| a CSV value starts with `'` | it began with `=`, `+`, `-` or `@` and was defused, so a spreadsheet shows it rather than running it |
| an enquiry you were told about is not there | the sender's email app opened before the copy was saved (it waits 1.5 s), or the same message came twice in 10 minutes |
