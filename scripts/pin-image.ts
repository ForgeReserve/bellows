/**
 * Pins container images in a Tinfoil config to image digests, changing nothing else in the file. The
 * release workflow runs it after pushing the images (.github/workflows/tinfoil-release.yml).
 *
 *   pnpm deploy:pin <config file> <container>=<name@sha256:<64 hex>> [<container>=<image> ...]
 *
 * Each named container the file has is pinned. A name the file does not have is skipped, so one command
 * serves a config with or without the tor sidecar. It fails, and writes nothing, when an image is not pinned
 * by digest or when any container in the file is left with the all-zero placeholder digest.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pinImages } from './lib/deploy.ts';

const usage = 'usage: pnpm deploy:pin <config file> <container>=<name@sha256:<64 hex>> [<container>=<image> ...]';
const [file, ...pairs] = process.argv.slice(2);
if (!file || pairs.length === 0) {
  console.error(usage);
  process.exit(1);
}
const images: Record<string, string> = {};
for (const pair of pairs) {
  const eq = pair.indexOf('=');
  const name = eq > 0 ? pair.slice(0, eq) : '';
  if (!name) {
    console.error(`${pair}: expected <container>=<image>\n${usage}`);
    process.exit(1);
  }
  if (name in images) {
    console.error(`${name} is named twice`);
    process.exit(1);
  }
  images[name] = pair.slice(eq + 1);
}
try {
  const r = pinImages(readFileSync(file, 'utf8'), images);
  writeFileSync(file, r.text);
  for (const name of r.pinned) console.log(`${file}: ${name} pinned to ${images[name]}`);
  for (const name of r.absent) console.log(`${file}: no ${name} container; skipped`);
} catch (e) {
  console.error(`${file}: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
