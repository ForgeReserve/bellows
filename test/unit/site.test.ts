/**
 * The static site in site/: the generated docs pages match docs/*.md, every internal link and anchor
 * resolves, and no page loads a script, stylesheet, font or image from another host.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DOCS, renderMarkdown, rewriteHref, slugify, staleFiles } from '../../scripts/build-site.ts';

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
  it('has generated docs pages that match docs/*.md (run pnpm site:build after editing a doc)', () => {
    expect(staleFiles(ROOT)).toEqual([]);
  });

  it('renders every doc it lists, from an existing Markdown file', () => {
    for (const d of DOCS) {
      expect(existsSync(join(ROOT, 'docs', d.file)), d.file).toBe(true);
      expect(existsSync(join(SITE, 'docs', `${d.slug}.html`)), d.slug).toBe(true);
    }
  });

  it('resolves every internal link and anchor to an existing file and heading', () => {
    const problems: string[] = [];
    for (const page of pages) {
      const html = read(page);
      for (const { url } of references(html)) {
        if (isExternal(url) || url === '') continue;
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

  it('has no em dash in the pages written for the site', () => {
    for (const p of [join(SITE, 'index.html'), join(ROOT, 'docs/BUILD.md')]) expect(read(p).includes('\u2014'), p).toBe(false);
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

  it('rewrites repository links for the site', () => {
    expect(rewriteHref('OHTTP.md#admission')).toBe('ohttp.html#admission');
    expect(rewriteHref('#refusals')).toBe('#refusals');
    expect(rewriteHref('DESIGN.md#platform')).toBe('https://github.com/ForgeReserve/bellows/blob/main/docs/DESIGN.md#platform');
    expect(rewriteHref('../README.md#admin-cli')).toBe('https://github.com/ForgeReserve/bellows/blob/main/README.md#admin-cli');
    expect(rewriteHref('../client/')).toBe('https://github.com/ForgeReserve/bellows/tree/main/client/');
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
