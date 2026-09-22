# Vendored browser libraries

The page has no build step and fetches nothing from a CDN, so its three runtime
libraries live here, copied byte for byte from their npm packages. The import map
in `../index.html` maps the bare names `preact`, `preact/hooks` and `htm` to these
files; `hooks.module.js` itself imports `preact` by that bare name.

| Package | Version | License | File here | Taken from (inside the npm tarball) |
|---|---|---|---|---|
| [preact](https://www.npmjs.com/package/preact) | 10.29.8 | MIT | `preact.module.js` | `package/dist/preact.module.js` |
| preact (its hooks) | 10.29.8 | MIT | `hooks.module.js` | `package/hooks/dist/hooks.module.js` |
| [htm](https://www.npmjs.com/package/htm) | 3.1.1 | Apache-2.0 | `htm.module.js` | `package/dist/htm.module.js` |

The two `.map` files are Preact's own source maps, from the same folders. They are
here so the browser's developer tools find what the `sourceMappingURL` comments name,
instead of reporting a missing file; the page never loads them.

License texts: `LICENSE-preact` (MIT, covers both Preact files) and `LICENSE-htm`
(Apache License 2.0, as the htm package ships it).

| Tarball | npm integrity |
|---|---|
| `preact-10.29.8.tgz` | `sha512-ej2aVZ+vZ8WO7tvlQWRM9N63A0KzF9q4mWJfDUHgYaIofWY9hu74QdnQrjoPMmZi2/nZ5gN0bJCQF49xQqx09Q==` |
| `htm-3.1.1.tgz` | `sha512-983Vyg8NwUE7JkZ6NmOqpCZ+sh1bKv2iYTlUkzlWmA5JD2acKoxd4KVxbMmxX/85mtfdnDmTFoNKcg5DGAvxNQ==` |

## Updating

In an empty folder, `npm pack preact htm`, untar both, copy the same files over these
(keeping the names), and update the versions and integrity lines above. Stay on
Preact 10: the page uses only `h`, `render` and the hooks, but Preact 11 changes
defaults the page has not been checked against.
