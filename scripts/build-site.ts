/**
 * Builds the static site: the landing page, the 404 page and the Developers pages, and copies the brand
 * files the site uses. No network, no dependencies beyond Node.
 *
 *   node scripts/build-site.ts           # write site/index.html, site/404.html, site/docs/*.html, brand files
 *   node scripts/build-site.ts --check   # exit 1 when any of them is missing or out of date
 *
 * Sources: the Markdown docs under docs/ that PAGES lists, and the hand-written page bodies in
 * scripts/site-pages/. The Markdown stays the source of truth; long guides are split into one page per
 * top-level section here, never in the Markdown. site/assets/site.css and site/assets/site.js are written by
 * hand. test/unit/site.test.ts runs the check, so `pnpm test` fails when the generated pages are stale.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_URL = 'https://github.com/ForgeReserve/bellows';
const BLOB = `${REPO_URL}/blob/main/`;
const TREE = `${REPO_URL}/tree/main/`;
/** The link-preview image. Absolute, because some preview services need that (site/README.md). */
export const PREVIEW_IMAGE = 'https://bellows.forgereserve.org/assets/social-preview.png';

export type Group = 'Start' | 'Build on it' | 'Trust' | 'Run your own';

export interface PageDef {
  /** The page's file name in site/docs/, without .html. Parts of a split doc get `<slug>-<heading id>`. */
  slug: string;
  /** The label in the Developers navigation and index. */
  label: string;
  group: Group;
  /** One line: the Developers index entry, the summary at the top of the page and its description tag. */
  summary: string;
  /** The Markdown source, as a path under docs/ (for example `use/guide.md`). */
  md?: string;
  /** The hand-written body in scripts/site-pages/. */
  html?: string;
  /**
   * Split the doc into one page per top-level (##) section, with a summary for each, keyed by heading id.
   * The doc's own page keeps the text before the first section and lists the parts.
   */
  parts?: Readonly<Record<string, string>>;
}

export const GROUPS: readonly { name: Group; line: string }[] = [
  { name: 'Start', line: 'What Bellows is, how a request flows, and a first request.' },
  { name: 'Build on it', line: 'Use an engine from your app, agent or script.' },
  { name: 'Trust', line: 'Check what an engine runs and what each party can see.' },
  { name: 'Run your own', line: 'Operate a Bellows, sealed on Tinfoil Containers.' },
];

/** The Developers pages, in reading order. Links to any other .md file go to GitHub. */
export const PAGES: readonly PageDef[] = [
  { slug: 'overview', label: 'What Bellows is', group: 'Start', html: 'overview.html', summary: 'What Bellows is, and what a sealed deployment hides from its operator, with the limits of each.' },
  { slug: 'how-it-works', label: 'How a request flows', group: 'Start', html: 'how-it-works.html', summary: 'One request from your app, through a relay, to a sealed Bellows and on to the model.' },
  { slug: 'quickstart', label: 'Quickstart', group: 'Start', html: 'quickstart.html', summary: 'List models, open a balance and send a chat request, with curl or any OpenAI client.' },
  { slug: 'reference-instance', label: 'Reference instance', group: 'Start', html: 'reference-instance.html', summary: 'The public Bellows on Tinfoil Containers: its address, what it answers and what has run there.' },
  {
    slug: 'build',
    label: 'Build on Bellows',
    group: 'Build on it',
    md: 'use/guide.md',
    summary: 'The guide: verify an engine, pay with eCash, chat, stream and go through Oblivious HTTP, with examples in curl, JavaScript and Python.',
    parts: {
      'pick-an-engine': 'Use the reference instance, or start a local engine with test mints while you build.',
      'check-which-build-it-runs': 'Read the attested identity, and verify it with verifyBellows before you send anything.',
      'list-models': 'Read the models, prices, mints and units an engine offers.',
      'pay-for-requests': 'Open a balance with eCash or Lightning, or pay each request with a token in a header.',
      'send-a-chat-request': 'Send an OpenAI chat request with curl, JavaScript or any OpenAI client, and read what it cost.',
      'stream-an-answer': 'Stream the answer, and read the event that settles the request at the end.',
      'send-through-oblivious-http': 'Send each call through a relay with bellowsFetch, so who is asking is hidden from the operator when someone else runs the relay.',
      'handle-errors': 'The error shape, and what to do about the codes an app meets most.',
      'read-the-balance-and-take-it-back': 'Read the balance, and withdraw what is left as an eCash token.',
      'use-the-client-library': 'What the client library in client/ exports, and how to bring it into your app.',
      'run-your-own-engine': 'Where to go next to run an engine of your own.',
      'how-these-examples-were-checked': 'Which examples in this guide were run, against what, and which were not.',
    },
  },
  { slug: 'api', label: 'API reference', group: 'Build on it', md: 'use/api.md', summary: 'The client API, the operator API and the discovery format, with every path, header, field and error code.' },
  { slug: 'payments', label: 'Payments', group: 'Build on it', md: 'how-it-works/payments.md', summary: 'How Bellows takes, holds and returns eCash, and what happens when something fails halfway.' },
  { slug: 'ohttp', label: 'Oblivious HTTP', group: 'Build on it', md: 'how-it-works/ohttp.md', summary: 'Oblivious HTTP to a Bellows: the gateway, replays, admission, streaming, the client and the relay.' },
  { slug: 'operators', label: 'Operators', group: 'Build on it', md: 'use/operators.md', summary: 'Operator announcements on Nostr, choosing among many operators, and moving a balance from one to another.' },
  { slug: 'attestation', label: 'Attestation', group: 'Trust', md: 'verify/attestation.md', summary: 'How a client checks which build a Bellows runs before it sends anything.' },
  { slug: 'privacy', label: 'Privacy', group: 'Trust', md: 'how-it-works/privacy.md', summary: 'What the gateway can see, per model tier, and what it stores and logs.' },
  { slug: 'threat-model', label: 'Threat model', group: 'Trust', md: 'how-it-works/threat-model.md', summary: 'What each party can see and do in a sealed deployment, what the design assumes and where it is weak.' },
  {
    slug: 'operate',
    label: 'Operator guide',
    group: 'Run your own',
    md: 'run/sealed-deployment.md',
    summary: 'Run a Bellows on Tinfoil Containers, step by step, so that requests, answers, balances and keys stay sealed from its operator.',
    parts: {
      'the-deploy-kit': 'The files that make a sealed deployment, and the rules pnpm deploy:check enforces.',
      'what-you-need': 'The accounts, servers, keys and rate cards to have ready before you start.',
      '1-make-your-deploy-repository': 'Copy the repository, edit tinfoil-config.yml and check it.',
      '2-make-the-keys-offline': 'Make the volume key, the wallet secret and the admin token on an offline machine, and back them up.',
      '3-run-your-keyserver': 'Run the keyserver that releases your secrets only to an approved build.',
      '4-release': 'Build, pin, tag and measure a release, and propose it for builds.json.',
      '5-approve-the-release-in-your-keyserver': 'Approve the release in your keyserver and sign your operator announcement.',
      '6-create-the-volume-and-the-instance': 'Create the encrypted volume and the instance on Tinfoil.',
      '7-check-it': 'Check the health, the attested identity, the models and the admin API.',
      'onion-service': 'Add a Tor onion service as a sidecar.',
      'oblivious-http-under-load': 'How the gateway bounds anonymous encapsulated requests, and how to tune it.',
      updating: 'Roll a new release out to a running instance.',
      'backups-and-recovery': 'What protects the money when there is no database export.',
      'rehearse-locally': 'Run the image the way Tinfoil runs it, on your own machine.',
      'not-verified-on-sealed-hardware': 'The steps that have not yet been checked on sealed hardware.',
    },
  },
];

/** Extra entries on the Developers index that point into other pages. */
export const INDEX_LINKS: readonly { group: Group; label: string; href: string; summary: string }[] = [
  { group: 'Run your own', label: 'Try it locally', href: 'build-pick-an-engine.html', summary: 'Start an engine with test mints on your own machine.' },
  { group: 'Run your own', label: 'Rehearse a sealed deployment', href: 'operate-rehearse-locally.html', summary: 'Run the image the way Tinfoil runs it, before you deploy.' },
  { group: 'Run your own', label: 'Not verified on sealed hardware', href: 'operate-not-verified-on-sealed-hardware.html', summary: 'What has not yet been checked on sealed hardware.' },
];

const MD_PAGES = PAGES.filter((p) => p.md);
/** Kept for the tests and for older callers: the pages made from Markdown. */
export const DOCS = MD_PAGES;

/** Brand files copied into site/assets, by their name there. */
export const BRAND_ASSETS: Readonly<Record<string, string>> = {
  'logo.svg': 'docs/brand/bellows-mark-dark.svg',
  'icon.svg': 'docs/brand/bellows-icon.svg',
  'icon.png': 'docs/brand/bellows-icon.png',
  'social-preview.png': 'docs/brand/social-preview.png',
};

/** Where each heading of each Markdown doc ends up: doc file, heading id, page file in site/docs/. */
const anchors = new Map<string, Map<string, string>>();
/** The page being rendered, for links within a doc that is split over several pages. */
let linkContext: { doc: PageDef; page: string } | null = null;

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

/**
 * Rewrites a link written for the repository (in a doc under docs/) into one that works on the site, from a
 * page in site/docs/. `from` is the doc the link is written in, as a path under docs/ (by default the doc
 * being rendered); a relative link resolves against its folder, as it does on GitHub. A link to a rendered
 * doc goes to the page that holds the heading it names, which matters for docs split into one page per
 * section. Links to any other file in the repository go to GitHub.
 */
export function rewriteHref(href: string, from: string = linkContext?.doc.md ?? 'README.md'): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return href;
  if (href.startsWith('#')) {
    const doc = linkContext?.doc;
    const at = doc?.md ? anchors.get(doc.md)?.get(href.slice(1)) : undefined;
    return at && at !== linkContext?.page ? `${at}${href}` : href;
  }
  const [path, hash] = href.split('#', 2) as [string, string | undefined];
  const anchor = hash !== undefined ? `#${hash}` : '';
  // Resolve against the folder of the doc the link is written in.
  const repoPath = join('docs', dirname(from), path).replace(/\\/g, '/');
  const doc = MD_PAGES.find((d) => `docs/${d.md}` === repoPath);
  if (doc) {
    const at = hash !== undefined ? anchors.get(doc.md!)?.get(hash) : undefined;
    return (at ?? `${doc.slug}.html`) + anchor;
  }
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
    const named = MD_PAGES.find((d) => d.md === text || basename(d.md!) === text);
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
  /** Levels to take off every heading: 1 on a page made from one section, whose ## becomes the page's h1. */
  shift: number;
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
      const level = Math.max(1, heading[1]!.length - state.shift);
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
  const state: RenderState = { ids: new Map(), headings: [], shift: 0 };
  const html = renderBlocks(md.replace(/\r\n/g, '\n').split('\n'), state);
  return { html, headings: state.headings };
}

// ---------------------------------------------------------------------------------------------------------
// Splitting a doc into one page per top-level section

interface Chunk {
  /** The heading id of the section, or null for the text before the first section. */
  id: string | null;
  lines: string[];
}

/** Splits Markdown at each `## ` heading outside code. */
function chunks(md: string): Chunk[] {
  const out: Chunk[] = [{ id: null, lines: [] }];
  let fence: string | null = null;
  const ids = new Map<string, number>();
  for (const line of md.replace(/\r\n/g, '\n').split('\n')) {
    const f = FENCE.exec(line);
    if (f) fence = fence === null ? f[2]! : line.trim().startsWith(fence) ? null : fence;
    const h = fence === null && !f ? HEADING.exec(line) : null;
    if (h) {
      // The same ids renderBlocks gives, counted over the whole doc.
      const base = slugify(plainText(h[2]!));
      const seen = ids.get(base) ?? 0;
      ids.set(base, seen + 1);
      if (h[1]!.length === 2) out.push({ id: seen ? `${base}-${seen}` : base, lines: [] });
    }
    out[out.length - 1]!.lines.push(line);
  }
  return out;
}

interface Page {
  /** File name in site/docs/. */
  file: string;
  def: PageDef;
  /** The section, for a part of a split doc. */
  part?: { id: string; title: string; summary: string };
}

function partPages(root: string, def: PageDef): Page[] {
  if (!def.md || !def.parts) return [];
  const md = readFileSync(join(root, 'docs', def.md), 'utf8');
  return chunks(md)
    .filter((c): c is Chunk & { id: string } => c.id !== null)
    .map((c) => {
      const summary = def.parts![c.id];
      if (!summary) throw new Error(`docs/${def.md}: no summary for the section #${c.id} in PAGES`);
      return { file: `${def.slug}-${c.id}.html`, def, part: { id: c.id, title: plainText(c.lines[0]!.replace(/^##\s+/, '')), summary } };
    });
}

/** Every Developers page in reading order, parts after the page of their doc. */
function allPages(root: string): Page[] {
  return PAGES.flatMap((def) => [{ file: `${def.slug}.html`, def }, ...partPages(root, def)]);
}

/** Fills `anchors`: which page each heading of each Markdown doc is on. */
function mapAnchors(root: string): void {
  anchors.clear();
  for (const def of MD_PAGES) {
    const map = new Map<string, string>();
    const state: RenderState = { ids: new Map(), headings: [], shift: 0 };
    for (const c of chunks(readFileSync(join(root, 'docs', def.md!), 'utf8'))) {
      const from = state.headings.length;
      renderBlocks(c.lines, state);
      const file = def.parts && c.id ? `${def.slug}-${c.id}.html` : `${def.slug}.html`;
      for (const h of state.headings.slice(from)) map.set(h.id, file);
    }
    anchors.set(def.md!, map);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Page parts

function head(opts: { title: string; description: string; prefix: string; base?: string; noindex?: boolean }): string {
  const { title, description, prefix } = opts;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${opts.base ? `<!-- Served for any missing path, so links resolve from the site root. -->\n<base href="${opts.base}">\n` : ''}<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
${opts.noindex ? '<meta name="robots" content="noindex">\n' : ''}<meta name="theme-color" content="#0B0D10">
<meta name="color-scheme" content="dark">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Bellows">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:image" content="${PREVIEW_IMAGE}">
<meta property="og:image:width" content="1280">
<meta property="og:image:height" content="640">
<meta property="og:image:alt" content="The Bellows logo, a gold ring and a teal ring around a white lock, beside the words: A sealed AI gateway, paid with eCash.">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${PREVIEW_IMAGE}">
<link rel="icon" href="${prefix}assets/logo.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="${prefix}assets/icon.png">
<link rel="stylesheet" href="${prefix}assets/site.css">
<script src="${prefix}assets/site.js" defer></script>
</head>`;
}

/** The header of every page: the logo, which links home, and two menu items. */
export function header(prefix: string, inDevelopers: boolean): string {
  return `<a class="skip" href="#main">Skip to content</a>
<header class="site-header">
  <div class="wrap header-inner">
    <a class="brand" href="${prefix}index.html" aria-label="Bellows home"><img src="${prefix}assets/logo.svg" alt="" width="32" height="32"><span>Bellows</span></a>
    <nav aria-label="Main">
      <ul class="nav">
        <li><a href="${prefix}docs/index.html"${inDevelopers ? ' aria-current="true"' : ''}>Developers</a></li>
        <li><a href="${REPO_URL}">GitHub</a></li>
      </ul>
    </nav>
  </div>
</header>`;
}

export function footer(): string {
  return `<footer class="site-footer">
  <div class="wrap">
    <p>Bellows is open source under the <a href="${BLOB}LICENSE">MIT licence</a>. Source and releases on <a href="${REPO_URL}">GitHub</a>.</p>
  </div>
</footer>`;
}

function sideNav(pages: readonly Page[], current: Page): string {
  const groups = GROUPS.map(({ name }) => {
    const items = PAGES.filter((d) => d.group === name)
      .map((d) => {
        const here = current.def.slug === d.slug;
        const own = here && !current.part;
        const parts = here && d.parts
          ? `\n<ol class="side-parts">${pages
              .filter((p) => p.def === d && p.part)
              .map((p) => `<li><a href="${p.file}"${p.file === current.file ? ' aria-current="page"' : ''}>${escapeHtml(p.part!.title)}</a></li>`)
              .join('')}</ol>`
          : '';
        return `<li><a href="${d.slug}.html"${own ? ' aria-current="page"' : here ? ' class="in-section"' : ''}>${escapeHtml(d.label)}</a>${parts}</li>`;
      })
      .join('\n');
    return `<p class="side-group">${name}</p>\n<ul>\n${items}\n</ul>`;
  });
  return `<nav class="side" aria-label="Developers">
<details class="side-menu" open>
<summary>Developers menu</summary>
<p class="side-home"><a href="index.html">Developers home</a></p>
${groups.join('\n')}
</details>
</nav>`;
}

/** The h2 headings of a page body, for its "On this page" list. */
function sectionsOf(html: string): { id: string; html: string }[] {
  return [...html.matchAll(/<h2 id="([^"]+)">([\s\S]*?)<\/h2>/g)].map((m) => ({ id: m[1]!, html: m[2]!.replace(/<a class="anchor"[^>]*>#<\/a>/, '') }));
}

function onThisPage(sections: readonly { id: string; html: string }[]): string {
  if (sections.length < 2) return '';
  return `<nav class="on-this-page" aria-label="On this page">
<p>On this page</p>
<ul>${sections.map((s) => `<li><a href="#${s.id}">${s.html}</a></li>`).join('')}</ul>
</nav>`;
}

function pageTitle(p: Page): string {
  return p.part ? p.part.title : p.def.label;
}

function pager(pages: readonly Page[], current: Page): string {
  const i = pages.indexOf(current);
  const prev = pages[i - 1];
  const next = pages[i + 1];
  const link = (p: Page | undefined, rel: 'prev' | 'next') =>
    p
      ? `<a class="pager-${rel}" rel="${rel}" href="${p.file}"><span>${rel === 'prev' ? 'Previous' : 'Next'}</span>${escapeHtml(pageTitle(p))}</a>`
      : '<span></span>';
  return `<nav class="pager" aria-label="Previous and next page">
${link(prev, 'prev')}
${link(next, 'next')}
</nav>`;
}

/** The body of one Developers page, before the summary and the "On this page" list go in after its h1. */
function body(root: string, pages: readonly Page[], p: Page): { html: string; moved?: Record<string, string> } {
  if (p.def.html) return { html: readFileSync(join(root, 'scripts', 'site-pages', p.def.html), 'utf8') };
  const md = readFileSync(join(root, 'docs', p.def.md!), 'utf8');
  linkContext = { doc: p.def, page: p.file };
  try {
    if (!p.def.parts) return { html: renderMarkdown(md).html };
    // A split doc: render every chunk with one id counter, keep the one this page shows.
    const state: RenderState = { ids: new Map(), headings: [], shift: 0 };
    let html = '';
    for (const c of chunks(md)) {
      state.shift = c.id ? 1 : 0;
      const out = renderBlocks(c.lines, state);
      if ((p.part && c.id === p.part.id) || (!p.part && c.id === null)) html = out;
    }
    if (p.part) return { html };
    const parts = pages.filter((q) => q.def === p.def && q.part);
    const list = `<h2 id="in-this-guide">In this guide</h2>
<ol class="parts">
${parts.map((q) => `<li><a href="${q.file}">${escapeHtml(q.part!.title)}</a><span>${escapeHtml(q.part!.summary)}</span></li>`).join('\n')}
</ol>`;
    // Anchors that moved to a part page, so old links to this page still land (site.js follows them).
    const moved: Record<string, string> = {};
    for (const [id, file] of anchors.get(p.def.md!) ?? []) if (file !== p.file) moved[id] = file;
    return { html: `${html}\n${list}`, moved };
  } finally {
    linkContext = null;
  }
}

function developerPage(root: string, pages: readonly Page[], p: Page): string {
  const { html, moved } = body(root, pages, p);
  const summary = p.part ? p.part.summary : p.def.summary;
  const sections = p.def.parts && !p.part ? [] : sectionsOf(html);
  const h1End = html.indexOf('</h1>');
  if (h1End < 0) throw new Error(`${p.file}: no h1`);
  const top = `\n<p class="summary">${escapeHtml(summary)}</p>\n${onThisPage(sections)}`;
  const article = html.slice(0, h1End + 5) + top + html.slice(h1End + 5);
  const h1Text = html.slice(html.indexOf('<h1'), h1End).replace(/<[^>]+>/g, '').replace(/#$/, '');
  const title = p.part ? `${h1Text} | ${p.def.label} | Bellows` : `${h1Text} | Bellows developers`;
  const crumbs = [`<a href="index.html">Developers</a>`, escapeHtml(p.def.group)];
  if (p.part) crumbs.push(`<a href="${p.def.slug}.html">${escapeHtml(p.def.label)}</a>`);
  const source = p.def.md
    ? `<p class="source">${p.part ? 'This page is a section of' : 'This page is'} <a href="${BLOB}docs/${p.def.md}">docs/${p.def.md}</a> in the repository.</p>\n`
    : '';
  const movedAttr = moved && Object.keys(moved).length ? ` data-moved="${escapeHtml(JSON.stringify(moved))}"` : '';
  return `${head({ title, description: summary, prefix: '../' })}
<body class="developers">
${header('../', true)}
<div class="wrap dev-layout">
${sideNav(pages, p)}
<main id="main" class="dev-main"${movedAttr}>
<p class="crumbs">${crumbs.join(' <span aria-hidden="true">/</span> ')}</p>
<article class="prose">
${article}
</article>
${pager(pages, p)}
${source}</main>
</div>
${footer()}
</body>
</html>
`;
}

function developersHome(pages: readonly Page[]): string {
  const groups = GROUPS.map(({ name, line }) => {
    const entries = [
      ...PAGES.filter((d) => d.group === name).map((d) => ({ href: `${d.slug}.html`, label: d.label, summary: d.summary })),
      ...INDEX_LINKS.filter((l) => l.group === name),
    ];
    const id = slugify(name);
    return `<section class="dev-group" aria-labelledby="${id}">
<h2 id="${id}">${escapeHtml(name)}</h2>
<p class="group-line">${escapeHtml(line)}</p>
<ul class="entries">
${entries.map((e) => `<li><a href="${e.href}">${escapeHtml(e.label)}</a><span>${escapeHtml(e.summary)}</span></li>`).join('\n')}
</ul>
</section>`;
  }).join('\n');
  void pages;
  return `${head({ title: 'Developers | Bellows', description: 'Build an app on a Bellows, check what it runs, or run your own: guides and references, grouped by what you want to do.', prefix: '../' })}
<body class="developers">
${header('../', true)}
<main id="main" class="wrap dev-home">
<h1>Developers</h1>
<p class="lead">Guides and references for Bellows, grouped by what you want to do. New here? Start with <a href="overview.html">What Bellows is</a>, then the <a href="quickstart.html">Quickstart</a>.</p>
<div class="dev-groups">
${groups}
</div>
</main>
${footer()}
</body>
</html>
`;
}

/** Sections the landing page had before it was cut down, and the pages that now hold them (site.js follows these). */
const LANDING_MOVED: Readonly<Record<string, string>> = {
  guarantees: 'docs/overview.html',
  flow: 'docs/how-it-works.html',
  quickstart: 'docs/quickstart.html',
  'reference-instance': 'docs/reference-instance.html',
  'get-started': 'docs/index.html',
};

function landing(root: string): string {
  return `${head({
    title: 'Bellows | A sealed AI gateway, paid with eCash',
    description: 'Bellows is an open-source AI gateway that runs inside sealed hardware, so prompts and answers stay out of its operator\'s reach. It speaks the OpenAI API and takes Cashu eCash per request.',
    prefix: '',
  })}
<body class="home">
${header('', false)}
<main id="main" data-moved="${escapeHtml(JSON.stringify(LANDING_MOVED))}">
${readFileSync(join(root, 'scripts', 'site-pages', 'index.html'), 'utf8').trimEnd()}
</main>
${footer()}
</body>
</html>
`;
}

function notFound(root: string): string {
  return `${head({ title: 'Page not found | Bellows', description: 'The home page and the Developers pages of the Bellows site are linked below.', prefix: '', base: '/', noindex: true })}
<body class="not-found-page">
${header('', false).replace('<a class="skip" href="#main">Skip to content</a>\n', '')}
<main id="main">
${readFileSync(join(root, 'scripts', 'site-pages', '404.html'), 'utf8').trimEnd()}
</main>
${footer()}
</body>
</html>
`;
}

/** Every generated file, by its path under site/. */
export function renderSite(root: string): Map<string, Buffer> {
  mapAnchors(root);
  const pages = allPages(root);
  const out = new Map<string, Buffer>();
  out.set('index.html', Buffer.from(landing(root)));
  out.set('404.html', Buffer.from(notFound(root)));
  out.set('docs/index.html', Buffer.from(developersHome(pages)));
  for (const p of pages) out.set(`docs/${p.file}`, Buffer.from(developerPage(root, pages, p)));
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
    const files = renderSite(root);
    for (const [rel, content] of files) {
      const p = join(root, 'site', rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
    }
    console.log(`wrote ${files.size} files under site/`);
  }
}
