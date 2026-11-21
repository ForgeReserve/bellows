/**
 * The static site in site/: the generated docs pages match their Markdown in docs/, every internal link and anchor
 * resolves, and no page loads a script, stylesheet, font or image from another host.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PAGES, renderMarkdown, renderSite, rewriteHref, slugify, staleFiles } from '../../scripts/build-site.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SITE = join(ROOT, 'site');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

const pages = files(SITE).filter((p) => p.endsWith('.html'));
const rel = (p: string) => relative(SITE, p).split('\\').join('/');
const read = (p: string) => readFileSync(p, 'utf8');
/** The link-preview image, absolute because some preview services need that (site/README.md). */
const PREVIEW = 'https://bellows.forgereserve.org/assets/social-preview.png';
/** The most words the landing page may hold, header and footer included. */
const LANDING_WORD_LIMIT = 160;
const isExternal = (url: string) => /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//');

function ids(html: string): Set<string> {
  return new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!));
}

/** Every URL a page refers to, with the attribute it came from. */
function references(html: string): { attr: string; url: string; tag: string }[] {
  const out: { attr: string; url: string; tag: string }[] = [];
  for (const m of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/gi)) {
    const tag = m[1]!.toLowerCase();
    for (const a of m[2]!.matchAll(/\s(href|src|srcset|content|poster|data)="([^"]*)"/gi)) {
      const attr = a[1]!.toLowerCase();
      if (attr === 'content' && !/property="og:image"|name="twitter:image"/.test(m[2]!)) continue;
      out.push({ attr, url: a[2]!.replace(/&amp;/g, '&'), tag });
    }
  }
  return out;
}

describe('site', () => {
  it('has generated pages that match their sources (run pnpm site:build after editing a doc)', () => {
    expect(staleFiles(ROOT)).toEqual([]);
  });

  it('renders every page it lists, from an existing source', () => {
    for (const d of PAGES) {
      const source = d.md ? join(ROOT, 'docs', d.md) : join(ROOT, 'scripts', 'site-pages', d.html!);
      expect(existsSync(source), source).toBe(true);
      expect(existsSync(join(SITE, 'docs', `${d.slug}.html`)), d.slug).toBe(true);
    }
  });

  it('keeps every page the site published before the Developers section, so old links still land', () => {
    for (const old of ['index.html', '404.html', 'docs/index.html', ...['build', 'api', 'payments', 'attestation', 'ohttp', 'privacy', 'threat-model', 'operators', 'operate'].map((s) => `docs/${s}.html`)]) {
      expect(existsSync(join(SITE, old)), old).toBe(true);
    }
    // Headings that moved to a section page are followed there by site.js, from the map on the old page.
    for (const [page, id, to] of [
      ['build.html', 'open-a-balance', 'build-pay-for-requests.html'],
      ['build.html', 'check-which-build-it-runs', 'build-check-which-build-it-runs.html'],
      ['operate.html', 'not-verified-on-sealed-hardware', 'operate-not-verified-on-sealed-hardware.html'],
      ['operate.html', '4-release', 'operate-4-release.html'],
    ] as const) {
      const html = read(join(SITE, 'docs', page));
      const map = JSON.parse(html.match(/data-moved="([^"]+)"/)![1]!.replace(/&quot;/g, '"').replace(/&amp;/g, '&')) as Record<string, string>;
      expect(map[id], `${page}#${id}`).toBe(to);
      expect(ids(read(join(SITE, 'docs', to))).has(id), `${to}#${id}`).toBe(true);
    }
  });

  it('has the logo and exactly two menu items, Developers and GitHub, in the header of every page', () => {
    for (const page of pages) {
      const html = read(page);
      const headerHtml = html.match(/<header class="site-header">([\s\S]*?)<\/header>/)?.[1];
      expect(headerHtml, rel(page)).toBeDefined();
      const items = [...headerHtml!.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, '').trim());
      expect(items, rel(page)).toEqual(['Developers', 'GitHub']);
      expect(headerHtml, rel(page)).toMatch(/<a class="brand" href="[^"]*index\.html"[^>]*><img src="[^"]*assets\/logo\.svg"/);
      expect([...headerHtml!.matchAll(/<a\b/g)], rel(page)).toHaveLength(3);
    }
  });

  it('keeps the landing page short', () => {
    // The landing page says what Bellows is and links to the detail. This limit keeps it from growing back.
    const html = read(join(SITE, 'index.html'));
    const text = html.slice(html.indexOf('<body')).replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ');
    const words = text.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w));
    expect(words.length).toBeLessThanOrEqual(LANDING_WORD_LIMIT);
    expect(html).not.toMatch(/<pre\b/);
    expect(html.match(/<li>/g)?.length ?? 0).toBeLessThanOrEqual(2 + 3); // two menu items, at most three points
  });

  it('gives every Developers page a summary, a way back and a way on', () => {
    for (const page of pages.filter((p) => rel(p).startsWith('docs/') && rel(p) !== 'docs/index.html')) {
      const html = read(page);
      expect(html, rel(page)).toMatch(/<\/h1>\n<p class="summary">[^<]+<\/p>/);
      expect(html, rel(page)).toMatch(/<nav class="pager" aria-label="Previous and next page">/);
      expect(html, rel(page)).toMatch(/<nav class="side" aria-label="Developers">/);
      const sections = (html.match(/<article class="prose">[\s\S]*<\/article>/)![0].match(/<h2 id=/g) ?? []).length;
      if (sections >= 2 && !html.includes('id="in-this-guide"')) expect(html, rel(page)).toMatch(/<nav class="on-this-page" aria-label="On this page">/);
    }
  });

  it('resolves every internal link and anchor to an existing file and heading', () => {
    const problems: string[] = [];
    for (const page of pages) {
      const html = read(page);
      for (const { url, tag } of references(html)) {
        if (isExternal(url) || url === '') continue;
        // The 404 page is served at any missing path, so it resolves its links from the root with <base href="/">.
        if (rel(page) === '404.html' && tag === 'base' && url === '/') continue;
        if (url.startsWith('/')) {
          problems.push(`${rel(page)}: ${url} is root-absolute; links must be relative`);
          continue;
        }
        const [path, hash] = url.split('#', 2) as [string, string | undefined];
        let target = page;
        if (path) {
          target = join(dirname(page), path);
          if (path.endsWith('/')) target = join(target, 'index.html');
          if (!target.startsWith(SITE) || !existsSync(target)) {
            problems.push(`${rel(page)}: ${url} points at a missing file`);
            continue;
          }
        }
        if (hash !== undefined && hash !== '' && !ids(read(target)).has(decodeURIComponent(hash))) {
          problems.push(`${rel(page)}: ${url} points at a missing anchor`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('loads no script, stylesheet, font or image from another host', () => {
    const problems: string[] = [];
    for (const page of pages) {
      const html = read(page);
      for (const { attr, url, tag } of references(html)) {
        if (!isExternal(url)) continue;
        if (tag === 'a') continue; // plain links may go anywhere
        if (tag === 'meta' && url === PREVIEW) continue; // the page does not load it: link previews read it
        problems.push(`${rel(page)}: <${tag} ${attr}="${url}">`);
      }
      for (const m of html.matchAll(/url\(\s*['"]?([^'")]+)/g)) if (isExternal(m[1]!) && !m[1]!.startsWith('data:')) problems.push(`${rel(page)}: url(${m[1]})`);
      if (/<iframe\b/i.test(html)) problems.push(`${rel(page)}: iframe`);
      if (/<script\b(?![^>]*\bsrc=)/i.test(html)) problems.push(`${rel(page)}: inline script`);
    }
    for (const css of files(SITE).filter((p) => p.endsWith('.css'))) {
      const text = read(css);
      for (const m of text.matchAll(/url\(\s*['"]?([^'")]+)/g)) if (!m[1]!.startsWith('data:')) problems.push(`${rel(css)}: url(${m[1]})`);
      if (/@import|@font-face/.test(text)) problems.push(`${rel(css)}: @import or @font-face`);
    }
    for (const js of files(SITE).filter((p) => p.endsWith('.js'))) {
      if (/\b(fetch|XMLHttpRequest|import|WebSocket|sendBeacon)\b/.test(read(js))) problems.push(`${rel(js)}: makes requests`);
    }
    expect(problems).toEqual([]);
  });

  it('gives every page a title, a description and a social preview', () => {
    for (const page of pages) {
      const html = read(page);
      expect(html, rel(page)).toMatch(/<title>[^<]+<\/title>/);
      expect(html, rel(page)).toMatch(/<meta name="description" content="[^"]+">/);
      expect(html, rel(page)).toMatch(/<meta property="og:image" content="[^"]+">/);
      expect(html, rel(page)).toMatch(/<meta name="viewport" content="width=device-width, initial-scale=1">/);
      expect(html, rel(page)).toMatch(/<html lang="en">/);
    }
  });

  it('has a 404 page that resolves its links from the root, and asks Workers to serve it', () => {
    const html = read(join(SITE, '404.html'));
    expect(html).toContain('<base href="/">');
    expect(html).not.toMatch(/href="#/);
    expect(read(join(SITE, 'wrangler.jsonc'))).toMatch(/"not_found_handling": "404-page"/);
  });

  it('has no em dash in the pages written for the site', () => {
    const written = [join(ROOT, 'docs/use/guide.md'), join(ROOT, 'scripts/build-site.ts'), ...files(join(ROOT, 'scripts', 'site-pages'))];
    for (const p of written) expect(read(p).includes('\u2014'), p).toBe(false);
  });
});

describe('site Markdown', () => {
  it('makes GitHub heading ids', () => {
    expect(slugify('`GET /v1/models`')).toBe('get-v1models');
    expect(slugify('Encrypted chat (EHBP)')).toBe('encrypted-chat-ehbp');
    expect(slugify('4. Release')).toBe('4-release');
    expect(slugify('`/.well-known/bellows`')).toBe('well-knownbellows');
    const { headings } = renderMarkdown('## Crash safety\n\n## Crash safety\n');
    expect(headings.map((h) => h.id)).toEqual(['crash-safety', 'crash-safety-1']);
  });

  it('sends a link to a heading of a split doc to the page that holds it', () => {
    renderSite(ROOT);
    expect(rewriteHref('guide.md#open-a-balance', 'use/api.md')).toBe('build-pay-for-requests.html#open-a-balance');
    expect(rewriteHref('../run/sealed-deployment.md#4-release', 'verify/attestation.md')).toBe('operate-4-release.html#4-release');
    expect(rewriteHref('api.md#error-codes', 'use/guide.md')).toBe('api.html#error-codes');
  });

  it('rewrites repository links for the site', () => {
    expect(rewriteHref('ohttp.md#admission', 'how-it-works/threat-model.md')).toBe('ohttp.html#admission');
    expect(rewriteHref('../how-it-works/ohttp.md#admission', 'run/sealed-deployment.md')).toBe('ohttp.html#admission');
    expect(rewriteHref('#refusals')).toBe('#refusals');
    expect(rewriteHref('../how-it-works/design.md#platform', 'run/sealed-deployment.md')).toBe('https://github.com/ForgeReserve/bellows/blob/main/docs/how-it-works/design.md#platform');
    expect(rewriteHref('admin.md#admin-cli', 'run/sealed-deployment.md')).toBe('https://github.com/ForgeReserve/bellows/blob/main/docs/run/admin.md#admin-cli');
    expect(rewriteHref('../../README.md', 'use/api.md')).toBe('https://github.com/ForgeReserve/bellows/blob/main/README.md');
    expect(rewriteHref('../../client/', 'use/operators.md')).toBe('https://github.com/ForgeReserve/bellows/tree/main/client/');
    expect(rewriteHref('https://www.rfc-editor.org/rfc/rfc9458.html')).toBe('https://www.rfc-editor.org/rfc/rfc9458.html');
  });

  it('renders nested lists, code in lists, tables with escaped pipes, and escapes HTML', () => {
    const md = [
      '1. One',
      '   - nested',
      '2. Two:',
      '',
      '   ```sh',
      '   echo <x>',
      '   ```',
      '',
      '| A | B |',
      '| - | - |',
      '| `a\\|b` | c \\| d |',
    ].join('\n');
    const { html } = renderMarkdown(md);
    expect(html).toContain('<ol>\n<li>One\n<ul>\n<li>nested</li>\n</ul></li>');
    expect(html).toContain('<code class="language-sh">echo &lt;x&gt;</code>');
    expect(html.match(/<ol>/g)).toHaveLength(1);
    expect(html).toContain('<td><code>a|b</code></td><td>c | d</td>');
  });
});
