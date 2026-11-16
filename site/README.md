# Bellows site

The landing page and docs for Bellows, as plain static files. No build step needs the network, and no page loads a script, stylesheet, font or image from another host.

| Path | What it is |
| - | - |
| `index.html` | The landing page, written by hand |
| `assets/site.css`, `assets/site.js` | Styles, and a small script that adds copy buttons and folds the docs menu on small screens. Pages work without the script |
| `assets/logo.svg`, `icon.svg`, `icon.png`, `social-preview.png` | Copies of the brand files in `docs/brand/`, made by the generator |
| `docs/*.html` | The docs, generated from `docs/*.md` |
| `wrangler.jsonc`, `.assetsignore` | Cloudflare Workers static-assets config. `.assetsignore` keeps this README and the config out of the upload |

## Edit the docs

The docs pages come from the Markdown files in `docs/`. Edit the Markdown, then regenerate:

```sh
pnpm site:build     # writes site/docs/*.html and copies the brand files
pnpm site:check     # fails when a generated file is missing or out of date
```

`scripts/build-site.ts` holds the list of pages, the Markdown renderer and the page template. Links between docs become links between pages; links to other files in the repository go to GitHub.

`pnpm test` runs `test/unit/site.test.ts`, which fails when the generated pages are stale, when an internal link or anchor does not resolve, or when a page loads anything from another host.

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

All links are relative, so the site works at the root of any domain. Link previews: `og:image` and `twitter:image` are relative paths (`assets/social-preview.png`). Some services that build link previews need an absolute URL; once the domain is chosen, make those two tags absolute in `index.html` and in the page template in `scripts/build-site.ts`.
