# Bellows site

The landing page and the Developers pages for Bellows, as plain static files. No build step needs the network, and no page loads a script, stylesheet, font or image from another host.

| Path | What it is |
| - | - |
| `index.html` | The landing page: what Bellows is, three short points, links to the detail. Generated from `scripts/site-pages/index.html` |
| `404.html` | The page for a missing path. Generated from `scripts/site-pages/404.html` |
| `docs/index.html` | The Developers home: every page, grouped by what the reader wants to do (Start, Build on it, Trust, Run your own) |
| `docs/*.html` | The Developers pages, generated from `docs/*.md` and from the hand-written bodies in `scripts/site-pages/`. The guide (`docs/BUILD.md`) and the operator guide (`docs/OPERATE.md`) get one page per top-level section, `build-<section>.html` and `operate-<section>.html` |
| `assets/site.css`, `assets/site.js` | Styles, written by hand, and a small script. The script adds copy buttons, folds the Developers menu on small screens, and follows an old link to a heading that moved to a section page. Pages work without it |
| `assets/logo.svg`, `icon.svg`, `icon.png`, `social-preview.png` | Copies of the brand files in `docs/brand/`, made by the generator |
| `wrangler.jsonc`, `.assetsignore` | Cloudflare Workers static-assets config. `.assetsignore` keeps this README and the config out of the upload |

The header of every page holds the logo, which links home, and two items: Developers and GitHub.

## Edit the pages

The Markdown in `docs/` is the source of truth for the docs pages: edit it there, never in `site/`. The landing page, the 404 page and the Start pages (What Bellows is, How a request flows, Quickstart, Reference instance) are bodies in `scripts/site-pages/`. Then regenerate:

```sh
pnpm site:build     # writes site/index.html, site/404.html, site/docs/*.html and copies the brand files
pnpm site:check     # fails when a generated file is missing or out of date
```

`scripts/build-site.ts` holds the list of pages (`PAGES`, with a one-line summary for each, and for each section of a split doc), the Markdown renderer and the page template. A new top-level section in `docs/BUILD.md` or `docs/OPERATE.md` needs a summary there, or the build stops and says which. Links between docs become links between pages, to the page that holds the heading; links to other files in the repository go to GitHub. Every page that existed before keeps its address: an old link to `docs/build.html#open-a-balance` lands on `docs/build-pay-for-requests.html#open-a-balance`.

`pnpm test` runs `test/unit/site.test.ts`. It fails when the generated pages are stale, when an internal link or anchor does not resolve, when a page loads anything from another host, when a header holds anything but the logo and the two items, when an old page address is gone, or when the landing page grows past its word limit.

## Preview locally

Any static file server works. With Python, from the repository root:

```sh
python3 -m http.server 8080 --directory site
```

Then open `http://localhost:8080/`. Or, with Wrangler, from this directory: `npx wrangler dev`.

## Deploy

From this directory, with a Cloudflare account:

```sh
npx wrangler deploy
```

`wrangler.jsonc` names the Worker `bellows-site` and serves this directory as static assets. It has no routes and no account id: add a custom domain or route in the Cloudflare dashboard or in your own copy of the file.

It sets `"not_found_handling": "404-page"`: a request that matches no file gets the nearest `404.html` with a `404 Not Found` status. Without that setting, Workers static assets answers a missing path with a plain `404 Not Found`. Only `site/404.html` exists, so every missing path gets it, at the address that was asked for. That is why the page carries `<base href="/">`: its links resolve from the root of the domain wherever it is served. If the site ever moves under a path, change that one tag.

All page links are relative, so the site works at the root of any domain. Link previews: `og:image` and `twitter:image` are absolute, because some services that build link previews need that. They point at `https://bellows.forgereserve.org/assets/social-preview.png`; to serve the site from another domain, change them in `index.html`, `404.html` and the page template in `scripts/build-site.ts`.
