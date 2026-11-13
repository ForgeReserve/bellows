/**
 * Mints test eCash from a local FakeWallet mint (docker-compose.test.yml). Never point this at a real mint.
 *   pnpm test-token [amount=50] [unit=usd] [mint=http://127.0.0.1:3338]
 */
import { getEncodedToken, Wallet } from '@cashu/cashu-ts';

const amount = Number(process.argv[2] ?? 50);
const unit = process.argv[3] ?? 'usd';
const mint = process.argv[4] ?? 'http://127.0.0.1:3338';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(mint)) throw new Error('test-token only talks to a local test mint');
const w = new Wallet(mint, { unit });
await w.loadMint();
const q = await w.createMintQuoteBolt11(amount);
for (let i = 0; i < 50 && (await w.checkMintQuoteBolt11(q.quote)).state !== 'PAID'; i++) await new Promise((r) => setTimeout(r, 100));
console.log(getEncodedToken({ mint, unit, proofs: await w.mintProofsBolt11(amount, q.quote) }));
