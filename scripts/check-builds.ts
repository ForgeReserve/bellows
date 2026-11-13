/**
 * Checks an approved-builds file (default: builds.json at the repository root) and prints every problem.
 *
 *   pnpm builds:check [path]
 *
 * Exit status 0 when the file is valid, 1 otherwise.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkBuilds } from '../client/builds.ts';

const path = process.argv[2] ?? fileURLToPath(new URL('../builds.json', import.meta.url));
let parsed: unknown;
try {
  parsed = JSON.parse(readFileSync(path, 'utf8'));
} catch (e) {
  console.error(`${path}: cannot read JSON: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
const problems = checkBuilds(parsed);
if (problems.length) {
  for (const p of problems) console.error(`${path}: ${p}`);
  process.exit(1);
}
const count = (parsed as { builds: unknown[] }).builds.length;
console.log(`${path}: valid, ${count} approved build${count === 1 ? '' : 's'}`);
