# Security

## What JEV-Arcade is, and is not, built to withstand

- **There is no login to play.** Whoever can reach the page can start races and games on the keys in
  your `.env`. The server binds to `127.0.0.1` by default and Docker publishes it on `127.0.0.1`
  only. Open it further only behind something that limits who gets in or how much they can spend
  (`WIKIRACE_MAX_RACES`, the providers' own spending limits); the public site runs on a free
  model and Jev for this reason. [docs/deploy.md](docs/deploy.md) has more.
- **A public site holds visitors to what you chose** (`WIKIRACE_PUBLIC`, on with
  `WIKIRACE_CANONICAL_HOST`): only the models the `*_MODELS` lists name, thinking up to
  `WIKIRACE_MAX_THINKING`, races of at most 20 hops and 10 minutes, and
  `WIKIRACE_STARTS_PER_HOUR` starts per address an hour. A start with no room is refused before
  anything is fetched or billed. Only the browser that started a race or a game run, or the admin,
  may stop or delete it: the start's answer carries an owner token, which the server keeps only
  as a SHA-256.
- **Keys stay on the server.** The page never receives one; a provider's refusal of a key is
  reported without the provider's words, which can quote it back; URLs are shown without their
  passwords; race and run records hold no key.
- **The Host header is checked** (`WIKIRACE_ALLOWED_HOSTS`, plus the canonical host and its
  twin), so a page elsewhere cannot reach a local server by pointing a name of its own at
  `127.0.0.1` (DNS rebinding).
- **The admin pages** (`/admin`, [docs/traffic.md](docs/traffic.md)) have one account: its
  password is kept only as a scrypt hash, its session token only as a SHA-256 on the server and in
  an `HttpOnly`, `SameSite=Strict` cookie scoped to `/api/admin`. Every admin endpoint checks the
  session on every request, and a test checks that each refuses a request without one. Failed
  sign-ins are rate limited per address and in all, and logged. The logs hold IP addresses and
  emails but never a password, a session token, an `Authorization` or `Cookie` header, or a
  credential in a query string.
- **Nothing is fetched at run time** but Wikipedia and the providers you configured. The page's
  libraries are vendored, with their npm integrity hashes recorded
  (`src/wikirace/static/vendor/README.md`).
- **The Docker image** runs as an unprivileged user (uid 10001), keeps its history on a volume,
  and is built from the lock file.

Out of scope: a server opened to the internet without a proxy or limits in front, and the
providers' own services.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use **Report a vulnerability** on the
repository's Security tab (GitHub's private reporting), which reaches the maintainer alone. If
that button is not shown, open an issue that says only that you have a security report and how
you can be reached, without details, and the maintainer will get in touch.

Say what you found, how to reproduce it, and what you think it lets an attacker do. You will get
an acknowledgement, and a fix or an explanation, as soon as the maintainer can; this is a small
open-source project with no security team.

## Supported versions

The `main` branch. There are no maintained release lines: a fix lands on `main` and in the Docker
image built from it.
