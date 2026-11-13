/**
 * Adds a measured release to builds.json. The release workflow runs it after Tinfoil's measure action has
 * written tinfoil-deployment.json (.github/workflows/tinfoil-release-publish.yml), and opens a pull request
 * with the result: approving a build is a reviewed change, never an automatic one.
 *
 *   pnpm builds:add --deployment-file <tinfoil-deployment.json> --version <1.2.3> --deployment <owner/repo@tag>
 *                   [--released YYYY-MM-DD] [--notes <text>] [--builds <builds.json>]
 *
 * The image comes from the measured config inside tinfoil-deployment.json, and that config must pass the
 * release checks (pnpm deploy:check --release).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { addBuild, buildFromDeployment } from './lib/deploy.ts';

const usage =
  'usage: pnpm builds:add --deployment-file <tinfoil-deployment.json> --version <1.2.3> --deployment <owner/repo@tag> [--released YYYY-MM-DD] [--notes <text>] [--builds <builds.json>]';
let values;
try {
  ({ values } = parseArgs({
    options: {
      'deployment-file': { type: 'string' },
      version: { type: 'string' },
      deployment: { type: 'string' },
      released: { type: 'string' },
      notes: { type: 'string' },
      builds: { type: 'string' },
    },
  }));
} catch (e) {
  console.error(`${e instanceof Error ? e.message : String(e)}\n${usage}`);
  process.exit(1);
}
const manifestPath = values['deployment-file'];
if (!manifestPath || !values.version || !values.deployment) {
  console.error(usage);
  process.exit(1);
}
const buildsPath = values.builds ?? fileURLToPath(new URL('../builds.json', import.meta.url));
try {
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const build = buildFromDeployment(manifest, {
    version: values.version,
    deployment: values.deployment,
    released: values.released ?? new Date().toISOString().slice(0, 10),
    notes: values.notes,
  });
  const next = addBuild(JSON.parse(readFileSync(buildsPath, 'utf8')), build);
  writeFileSync(buildsPath, JSON.stringify(next, null, 2) + '\n');
  console.log(`${buildsPath}: added ${build.version} (${build.deployment})`);
  console.log(JSON.stringify(build, null, 2));
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
