/**
 * Checks Bellows deploy configs for Tinfoil Containers and prints every problem (docs/OPERATE.md).
 *
 *   pnpm deploy:check [--release] [file ...]
 *
 * Default files: tinfoil-config.yml (your deployment, the file Tinfoil measures) and the two templates,
 * deploy/tinfoil-config.example.yml and deploy/tinfoil-config.onion.example.yml. --release also refuses
 * example values and a placeholder image digest, which a release must not carry; with --release the
 * default is tinfoil-config.yml alone, since the templates keep their example values. Exit status 0 when
 * every file passes, 1 otherwise.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkTinfoilConfig } from './lib/deploy.ts';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('usage: pnpm deploy:check [--release] [file ...]');
  process.exit(0);
}
const release = args.includes('--release');
const unknown = args.filter((a) => a.startsWith('-') && a !== '--release');
if (unknown.length) {
  console.error(`unknown option ${unknown[0]}`);
  process.exit(1);
}
const root = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const files = args.filter((a) => !a.startsWith('-'));
if (files.length === 0) {
  files.push(root('tinfoil-config.yml'));
  if (!release) files.push(root('deploy/tinfoil-config.example.yml'), root('deploy/tinfoil-config.onion.example.yml'));
}

let failed = false;
for (const file of files) {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`${file}: cannot read: ${e instanceof Error ? e.message : String(e)}`);
    failed = true;
    continue;
  }
  const problems = checkTinfoilConfig(text, { release });
  if (problems.length) {
    failed = true;
    for (const p of problems) console.error(`${file}: ${p}`);
  } else {
    console.log(`${file}: valid${release ? ' for a release' : ''}`);
  }
}
process.exit(failed ? 1 : 0);
