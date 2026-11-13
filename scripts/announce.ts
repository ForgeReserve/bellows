/**
 * Signs and publishes this Bellows' operator announcement (docs/OPERATORS.md). See src/announce.ts.
 *
 *   pnpm announce --url https://bellows.example --unit sat --mint https://mint.example --out announcement.json
 */
import { fileURLToPath } from 'node:url';
import { nodeIo, runAnnounce } from '../src/announce.ts';

const io = { ...nodeIo(), buildsPath: fileURLToPath(new URL('../builds.json', import.meta.url)) };
process.exit(await runAnnounce(process.argv.slice(2), io));
