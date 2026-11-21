# Contributing docs

[CONTRIBUTING.md](../../CONTRIBUTING.md) at the root of the repository is the contributor guide: how to set up, run the engine, run the tests, where the code lives and what a good pull request looks like. This folder holds the detail that guide points to.

| Page | What it holds |
| - | - |
| [What the tests check](tests.md) | What each test file covers, from the unit suite to the end-to-end suite against local mints |

## Editing the docs

The docs are Markdown in `docs/`, in folders by reader goal ([docs home](../README.md)). Some of them are also published as pages of the static site in `site/`:

- `scripts/build-site.ts` holds the list of site pages (`PAGES`). Each entry names its Markdown source as a path under `docs/` and its page address in `site/docs/`. The page address does not follow the file's path, so a doc can move between folders and keep its address.
- The guide ([`use/guide.md`](../use/guide.md)) and the sealed deployment guide ([`run/sealed-deployment.md`](../run/sealed-deployment.md)) become one page per `##` section, named after the heading (`build-<heading>.html`, `operate-<heading>.html`). Renaming or adding a `##` heading there changes or adds a page address, and the build stops until `PAGES` has a summary for the new section.
- Relative links between docs become links between site pages; links to any other file go to GitHub. Write links relative to the file you are editing, as GitHub resolves them.
- After editing a doc that is a site page, run `pnpm site:build` and commit the regenerated files under `site/`. `pnpm site:check`, and the site test in `pnpm test`, fail when they are stale or when a link or anchor does not resolve.
- Code comments, error messages, config templates and workflows name doc paths (for example `docs/run/sealed-deployment.md`). When you move or rename a doc, search for its old path across the repository.

[`site/README.md`](../../site/README.md) covers the site itself: the hand-written pages, previews and deploying it. [`brand/README.md`](../brand/README.md) covers the logo files.

## Writing style

The docs use plain, short sentences and say what each thing does. Explain a term the first time it appears on a page. Spell it "eCash". When a page states a limit or something not yet verified, say so where it applies: the threat model and the "not verified" lists are part of the docs, and a change that alters what Bellows hides updates them in the same pull request. The [design](../how-it-works/design.md#what-operator-blind-means-here) sets one wording rule: say "the operator cannot read" only for the words and for money and state, and say "hidden from the operator when you use a relay or Tor" for who is asking.
