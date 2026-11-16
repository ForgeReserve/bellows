/**
 * Builds the docs pages of the static site from the repository's Markdown docs, and copies the brand files
 * the site uses. No network, no dependencies beyond Node.
 *
 *   node scripts/build-site.ts           # write site/docs/*.html and site/assets/<brand files>
 *   node scripts/build-site.ts --check   # exit 1 when any of them is missing or out of date
 *
 * The landing page (site/index.html), site/assets/site.css and site/assets/site.js are written by hand.
 * test/unit/site.test.ts runs the check, so `pnpm test` fails when the generated pages are stale.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_URL = 'https://github.com/ForgeReserve/bellows';
const BLOB = `${REPO_URL}/blob/main/`;
const TREE = `${REPO_URL}/tree/main/`;

export interface DocPage {
  /** The Markdown file in docs/. */
  file: string;
  /** The page's file name in site/docs/, without .html. */
  slug: string;
  /** The label in the docs navigation. */
  label: string;
  /** One sentence for the description meta tag and the docs index. */
  description: string;
  /** The navigation group. */
  group: 'Build' | 'Reference' | 'Run';
}

/** The docs the site renders, in navigation order. Links to any other .md file go to GitHub. */
export const DOCS: readonly DocPage[] = [
  { file: 'BUILD.md', slug: 'build', label: 'Build on Bellows', group: 'Build', description: 'Use a running Bellows from an app, an agent or a script: verify it, pay with eCash, chat, stream and go through Oblivious HTTP.' },
  { file: 'API.md', slug: 'api', label: 'API reference', group: 'Reference', description: 'The client API, the operator API and the discovery format, with every path, header, field and error code.' },
  { file: 'PAYMENTS.md', slug: 'payments', label: 'Payments', group: 'Reference', description: 'How Bellows takes, holds and returns eCash, and what happens when something fails halfway.' },
  { file: 'ATTESTATION.md', slug: 'attestation', label: 'Attestation', group: 'Reference', description: 'How a client checks which build a Bellows runs before it sends anything.' },
  { file: 'OHTTP.md', slug: 'ohttp', label: 'Oblivious HTTP', group: 'Reference', description: 'Oblivious HTTP to a Bellows: the gateway, replays, admission, streaming, the client and the relay.' },
  { file: 'PRIVACY.md', slug: 'privacy', label: 'Privacy', group: 'Reference', description: 'What the gateway can see, per model tier, and what it never stores or logs.' },
  { file: 'THREAT-MODEL.md', slug: 'threat-model', label: 'Threat model', group: 'Reference', description: 'What each party can see and do in a sealed deployment, what the design assumes and where it is weak.' },
  { file: 'OPERATORS.md', slug: 'operators', label: 'Operators', group: 'Reference', description: 'Operator announcements, choosing among many operators and moving a balance from one to another.' },
  { file: 'OPERATE.md', slug: 'operate', label: 'Run your own', group: 'Run', description: 'Run a Bellows on Tinfoil Containers, step by step, so that its operator cannot read it.' },
];

/** Brand files copied into site/assets, by their name there. */
export const BRAND_ASSETS: Readonly<Record<string, string>> = {
  'logo.svg': 'docs/brand/bellows-mark-dark.svg',
  'icon.svg': 'docs/brand/bellows-icon.svg',
  'icon.png': 'docs/brand/bellows-icon.png',
  'social-preview.png': 'docs/brand/social-preview.png',
};

const SITE_DESCRIPTION = 'Bellows is an open-source, OpenAI-compatible AI gateway that takes Cashu eCash per request and forwards the request to AI models.';

// ---------------------------------------------------------------------------------------------------------
// Markdown: the subset the docs use (headings, paragraphs, nested lists, tables, fenced code, inline code,
// links, bold). GitHub's heading ids, so links written for GitHub work here too.

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** GitHub's heading id: lower case, punctuation dropped, spaces to hyphens. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

/** The heading text as GitHub sees it for its id: inline code and links reduced to their text. */
function plainText(md: string): string {
  return md
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1');
}

/** Rewrites a link written for the repository into one that works on the site (pages in site/docs/). */
export function rewriteHref(href: string, from: 'docs' | 'root' = 'docs'): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#')) return href;
  const [path, hash] = href.split('#', 2) as [string, string | undefined];
  const anchor = hash !== undefined ? `#${hash}` : '';
  // Resolve against the docs/ directory of the repository.
  const repoPath = join('docs', path).replace(/\\/g, '/');
  const doc = DOCS.find((d) => `docs/${d.file}` === repoPath);
  if (doc) return (from === 'docs' ? `${doc.slug}.html` : `docs/${doc.slug}.html`) + anchor;
  const normalized = repoPath.replace(/^docs\/\.\.\//, '').replace(/\/+$/, '');
  if (href.endsWith('/')) return `${TREE}${normalized}/${anchor}`;
  return `${BLOB}${normalized}${anchor}`;
}

function inline(md: string): string {
  const codes: string[] = [];
  let s = md.replace(/(`+)([\s\S]+?)\1/g, (_, _ticks, code: string) => {
    codes.push(`<code>${escapeHtml(code.trim() === '' ? code : code.replace(/^ (.*) $/, '$1'))}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!|<>])/g, (_, c: string) => `\u0001${c.charCodeAt(0)}\u0001`);
  s = escapeHtml(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text: string, href: string) => {
    // A link whose text is the file name of a rendered doc reads better as the doc's name on the site.
    const named = DOCS.find((d) => d.file === text);
    return `<a href="${escapeHtml(rewriteHref(href))}">${named ? escapeHtml(named.label) : text}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\u0001(\d+)\u0001/g, (_, n: string) => escapeHtml(String.fromCharCode(Number(n))));
  return s.replace(/\u0000(\d+)\u0000/g, (_, n: string) => codes[Number(n)]!);
}

export interface Heading {
  level: number;
  id: string;
  html: string;
}

interface RenderState {
  ids: Map<string, number>;
  headings: Heading[];
}

const FENCE = /^(\s*)(`{3,})([\w-]*)\s*$/;
const LIST_ITEM = /^(\s*)([-*]|\d+\.)\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

const indentOf = (line: string) => line.length - line.trimStart().length;
const isBlank = (line: string) => line.trim() === '';

function startsBlock(lines: readonly string[], i: number): boolean {
  const l = lines[i]!;
  return FENCE.test(l) || HEADING.test(l) || LIST_ITEM.test(l) || (l.trimStart().startsWith('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]!));
}

function splitRow(row: string): string[] {
  let r = row.trim();
  if (r.startsWith('|')) r = r.slice(1);
  if (r.endsWith('|') && !r.endsWith('\\|')) r = r.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < r.length; i++) {
    const c = r[i]!;
    if (c === '\\' && r[i + 1] === '|') {
      cur += '\\|';
      i++;
    } else if (c === '`') {
      inCode = !inCode;
      cur += c;
    } else if (c === '|' && !inCode) {
      cells.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  cells.push(cur.trim());
  // Inside code spans an escaped pipe stands for a pipe.
  return cells.map((cell) => cell.replace(/`[^`]*`/g, (code) => code.replace(/\\\|/g, '|')));
}

function renderBlocks(lines: readonly string[], state: RenderState): string {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const indent = fence[1]!.length;
      const lang = fence[3]!;
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i]!.trim().startsWith(fence[2]!) && lines[i]!.trim().replace(/`/g, '') === '')) {
        body.push(lines[i]!.slice(Math.min(indent, indentOf(lines[i]!))));
        i++;
      }
      i++;
      const label = lang ? ` data-lang="${escapeHtml(lang)}"` : '';
      out.push(`<pre tabindex="0"${label}><code${lang ? ` class="language-${escapeHtml(lang)}"` : ''}>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const base = slugify(plainText(heading[2]!));
      const seen = state.ids.get(base) ?? 0;
      state.ids.set(base, seen + 1);
      const id = seen ? `${base}-${seen}` : base;
      const html = inline(heading[2]!);
      state.headings.push({ level, id, html });
      const anchor = level > 1 ? `<a class="anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a>` : '';
      out.push(`<h${level} id="${id}">${html}${anchor}</h${level}>`);
      i++;
      continue;
    }
    if (line.trimStart().startsWith('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]!)) {
      const head = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trimStart().startsWith('|')) rows.push(splitRow(lines[i++]!));
      const th = head.map((c) => `<th scope="col">${inline(c)}</th>`).join('');
      const trs = rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('\n');
      out.push(`<div class="table-wrap" tabindex="0" role="region" aria-label="Table"><table>\n<thead><tr>${th}</tr></thead>\n<tbody>\n${trs}\n</tbody>\n</table></div>`);
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      const base = item[1]!.length;
      const ordered = /\d/.test(item[2]!);
      const start = ordered ? Number.parseInt(item[2]!, 10) : 1;
      const items: string[][] = [];
      while (i < lines.length) {
        // A blank line between two items of the same list keeps the list going.
        if (items.length && isBlank(lines[i]!)) {
          let j = i;
          while (j < lines.length && isBlank(lines[j]!)) j++;
          const next = j < lines.length ? LIST_ITEM.exec(lines[j]!) : null;
          if (!next || next[1]!.length !== base || /\d/.test(next[2]!) !== ordered) break;
          i = j;
        }
        const m = LIST_ITEM.exec(lines[i]!);
        if (!m || m[1]!.length !== base || /\d/.test(m[2]!) !== ordered) break;
        const contentIndent = base + m[2]!.length + 1;
        const buf = [m[3]!];
        i++;
        while (i < lines.length) {
          const l = lines[i]!;
          if (isBlank(l)) {
            let j = i;
            while (j < lines.length && isBlank(lines[j]!)) j++;
            if (j < lines.length && indentOf(lines[j]!) > base) {
              for (; i < j; i++) buf.push('');
              continue;
            }
            break;
          }
          if (indentOf(l) > base) {
            buf.push(l.slice(Math.min(indentOf(l), contentIndent)));
            i++;
          } else if (!startsBlock(lines, i) && !isBlank(buf[buf.length - 1]!)) {
            buf.push(l.trim());
            i++;
          } else break;
        }
        items.push(buf);
      }
      const lis = items.map((buf) => {
        const firstBlock = buf.findIndex((l, k) => k > 0 && (isBlank(l) || startsBlock(buf, k)));
        const lead = firstBlock < 0 ? buf : buf.slice(0, firstBlock);
        const rest = firstBlock < 0 ? [] : buf.slice(firstBlock);
        const restHtml = rest.some((l) => !isBlank(l)) ? `\n${renderBlocks(rest, state)}` : '';
        return `<li>${inline(lead.join(' '))}${restHtml}</li>`;
      });
      const tag = ordered ? 'ol' : 'ul';
      const startAttr = ordered && start !== 1 ? ` start="${start}"` : '';
      out.push(`<${tag}${startAttr}>\n${lis.join('\n')}\n</${tag}>`);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && !isBlank(lines[i]!) && (para.length === 0 || !startsBlock(lines, i))) para.push(lines[i++]!.trim());
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return out.join('\n');
}

export function renderMarkdown(md: string): { html: string; headings: Heading[] } {
  const state: RenderState = { ids: new Map(), headings: [] };
  const html = renderBlocks(md.replace(/\r\n/g, '\n').split('\n'), state);
  return { html, headings: state.headings };
}

// ---------------------------------------------------------------------------------------------------------
// Pages

function head(opts: { title: string; description: string; prefix: string; path: string }): string {
  const { title, description, prefix } = opts;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="theme-color" content="#0B0D10">
<meta name="color-scheme" content="dark">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Bellows">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:image" content="${prefix}assets/social-preview.png">
<meta property="og:image:width" content="1280">
<meta property="og:image:height" content="640">
<meta property="og:image:alt" content="The Bellows logo, a gold ring and a teal ring around a white lock, beside the words: An open AI gateway, paid with eCash.">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${prefix}assets/social-preview.png">
<link rel="icon" href="${prefix}assets/logo.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="${prefix}assets/icon.png">
<link rel="stylesheet" href="${prefix}assets/site.css">
<script src="${prefix}assets/site.js" defer></script>
</head>`;
}

function header(prefix: string, current: 'home' | 'docs' | 'build' | 'operate'): string {
  const cur = (k: string) => (k === current ? ' aria-current="page"' : '');
  return `<a class="skip" href="#main">Skip to content</a>
<header class="site-header">
  <div class="wrap header-inner">
    <a class="brand" href="${prefix}index.html"><img src="${prefix}assets/logo.svg" alt="" width="32" height="32"><span>Bellows</span></a>
    <nav aria-label="Main">
      <ul class="nav">
        <li><a href="${prefix}docs/index.html"${cur('docs')}>Docs</a></li>
        <li><a href="${prefix}docs/build.html"${cur('build')}>Build</a></li>
        <li><a href="${prefix}docs/operate.html"${cur('operate')}>Run your own</a></li>
        <li><a href="${REPO_URL}">GitHub</a></li>
      </ul>
    </nav>
  </div>
</header>`;
}

export function footer(prefix: string): string {
  return `<footer class="site-footer">
  <div class="wrap footer-inner">
    <div class="footer-brand"><img src="${prefix}assets/logo.svg" alt="" width="28" height="28"><span>Bellows</span></div>
    <p>Open source under the <a href="${BLOB}LICENSE">MIT licence</a>. Source, issues and releases on <a href="${REPO_URL}">GitHub</a>.</p>
    <nav aria-label="Footer">
      <ul>
        <li><a href="${prefix}docs/build.html">Build on Bellows</a></li>
        <li><a href="${prefix}docs/api.html">API reference</a></li>
        <li><a href="${prefix}docs/threat-model.html">Threat model</a></li>
        <li><a href="${prefix}docs/operate.html">Run your own</a></li>
      </ul>
    </nav>
  </div>
</footer>`;
}

function docsNav(current: DocPage | null, headings: readonly Heading[]): string {
  const groups = ['Build', 'Reference', 'Run'] as const;
  const parts = groups.map((g) => {
    const items = DOCS.filter((d) => d.group === g)
      .map((d) => {
        const here = current?.slug === d.slug;
        const toc = here && headings.some((h) => h.level === 2)
          ? `\n<ul class="toc">${headings
              .filter((h) => h.level === 2)
              .map((h) => `<li><a href="#${h.id}">${h.html.replace(/<a class="anchor"[^>]*>#<\/a>/, '')}</a></li>`)
              .join('')}</ul>`
          : '';
        return `<li><a href="${d.slug}.html"${here ? ' aria-current="page"' : ''}>${escapeHtml(d.label)}</a>${toc}</li>`;
      })
      .join('\n');
    return `<p class="nav-group">${g}</p>\n<ul>\n${items}\n</ul>`;
  });
  return `<nav class="docs-nav" aria-label="Docs">
<details class="docs-menu" open>
<summary>All docs</summary>
${parts.join('\n')}
<p class="nav-group">On GitHub</p>
<ul>
<li><a href="${BLOB}README.md">README</a></li>
<li><a href="${BLOB}docs/DESIGN.md">Design</a></li>
<li><a href="${BLOB}docs/MIGRATE-FROM-FORGE-AI.md">Migrating</a></li>
</ul>
</details>
</nav>`;
}

function docPage(root: string, doc: DocPage): string {
  const md = readFileSync(join(root, 'docs', doc.file), 'utf8');
  const { html, headings } = renderMarkdown(md);
  const h1 = headings.find((h) => h.level === 1);
  const title = `${h1 ? plainText(md.split('\n').find((l) => l.startsWith('# '))!.slice(2)) : doc.label} | Bellows docs`;
  return `${head({ title, description: doc.description, prefix: '../', path: `docs/${doc.slug}.html` })}
<body class="docs">
${header('../', doc.slug === 'build' ? 'build' : doc.slug === 'operate' ? 'operate' : 'docs')}
<div class="wrap docs-layout">
${docsNav(doc, headings)}
<main id="main" class="prose">
${html}
<p class="source">This page is <a href="${BLOB}docs/${doc.file}">docs/${doc.file}</a> in the repository.</p>
</main>
</div>
${footer('../')}
</body>
</html>
`;
}

function docsIndex(): string {
  const cards = DOCS.map(
    (d) => `<li class="card"><h2><a href="${d.slug}.html">${escapeHtml(d.label)}</a></h2><p>${escapeHtml(d.description)}</p></li>`,
  ).join('\n');
  return `${head({ title: 'Docs | Bellows', description: 'The Bellows docs: build an app on a Bellows, the API, payments, attestation, Oblivious HTTP, privacy, the threat model and running your own.', prefix: '../', path: 'docs/index.html' })}
<body class="docs">
${header('../', 'docs')}
<main id="main" class="wrap docs-index">
<h1>Docs</h1>
<p class="lead">Start with <a href="build.html">Build on Bellows</a> to use a running engine, or <a href="operate.html">Run your own</a> to operate one. The reference pages describe each part in full.</p>
<ul class="cards">
${cards}
</ul>
</main>
${footer('../')}
</body>
</html>
`;
}

/** Every generated file, by its path under site/. */
export function renderSite(root: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const doc of DOCS) out.set(`docs/${doc.slug}.html`, Buffer.from(docPage(root, doc)));
  out.set('docs/index.html', Buffer.from(docsIndex()));
  for (const [name, src] of Object.entries(BRAND_ASSETS)) out.set(`assets/${name}`, readFileSync(join(root, src)));
  return out;
}

/** Paths under site/ that are missing or differ from what renderSite makes, and stray files in site/docs. */
export function staleFiles(root: string): string[] {
  const site = join(root, 'site');
  const want = renderSite(root);
  const stale: string[] = [];
  for (const [rel, content] of want) {
    const p = join(site, rel);
    if (!existsSync(p) || !readFileSync(p).equals(content)) stale.push(rel);
  }
  const docsDir = join(site, 'docs');
  if (existsSync(docsDir)) for (const f of readdirSync(docsDir)) if (!want.has(`docs/${f}`)) stale.push(`docs/${f} (not generated)`);
  return stale;
}

export { SITE_DESCRIPTION };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  if (process.argv.includes('--check')) {
    const stale = staleFiles(root);
    if (stale.length) {
      console.error(`site is out of date; run pnpm site:build\n  ${stale.join('\n  ')}`);
      process.exit(1);
    }
    console.log('site is up to date');
  } else {
    for (const [rel, content] of renderSite(root)) {
      const p = join(root, 'site', rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
    }
    console.log(`wrote ${renderSite(root).size} files under site/`);
  }
}
