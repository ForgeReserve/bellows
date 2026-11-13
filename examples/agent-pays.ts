/**
 * An agent that pays for its own inference with eCash, using NUT-24 (HTTP 402) end to end.
 *
 *   BELLOWS_URL=http://localhost:8787 BELLOWS_INVITE=inv-... MODEL=mock-echo \
 *   CASHU_TOKEN=cashuB...            # eCash to spend from (any trusted mint), or:
 *   DEMO_FAKE_MINT=1                 # mint test eCash from a FakeWallet mint named in the 402
 *   CASHU_PUBKEY=02...               # optional: lock the change to this key (NUT-11 P2PK)
 *   CASHU_PRIVKEY=...                # optional: the matching private key, to redeem locked change
 *   pnpm demo:agent "What is eCash?"
 *
 * With CASHU_PUBKEY the gateway locks the change to that key (X-Cashu-Pubkey), so only the holder of
 * the private key can redeem it; not even the gateway can. Set CASHU_PUBKEY=generate to make a fresh
 * key pair for this run (it is printed so the change is not lost).
 *
 * Steps: call with no credentials -> 402 + X-Cashu payment request (NUT-18 creqA) -> build a token
 * for the requested amount at an accepted mint -> retry with X-Cashu: cashuB... -> answer + change.
 */
import { randomBytes } from 'node:crypto';
import { getEncodedToken, getPubKeyFromPrivKey, getTokenMetadata, PaymentRequest, type Proof, Wallet } from '@cashu/cashu-ts';

const BASE_URL = process.env.BELLOWS_URL ?? 'http://localhost:8787';
const MODEL = process.env.MODEL ?? 'mock-echo';
const prompt = process.argv[2] ?? 'In one sentence, what is eCash?';
const headers: Record<string, string> = { 'content-type': 'application/json' };
if (process.env.BELLOWS_INVITE) headers['X-Forge-Invite'] = process.env.BELLOWS_INVITE;
if (process.env.UNIT) headers['X-Forge-Unit'] = process.env.UNIT;
// Optional NUT-11 lock for the change. The private key never leaves this process.
let lockPriv = process.env.CASHU_PRIVKEY;
let lockPub = process.env.CASHU_PUBKEY;
if (lockPub === 'generate') {
  lockPriv = randomBytes(32).toString('hex');
  lockPub = Buffer.from(getPubKeyFromPrivKey(Buffer.from(lockPriv, 'hex'))).toString('hex');
  console.log(`Generated a lock key for this run. Private key (keep it to redeem locked change): ${lockPriv}`);
}
if (lockPub) headers['X-Cashu-Pubkey'] = lockPub;
// Reasoning models can spend the whole token budget thinking; REASONING_EFFORT=none skips that where supported.
const body = JSON.stringify({
  model: MODEL,
  messages: [{ role: 'user', content: prompt }],
  max_tokens: Number(process.env.MAX_TOKENS ?? 512),
  ...(process.env.REASONING_EFFORT ? { reasoning_effort: process.env.REASONING_EFFORT } : {}),
});

// 1. Ask without paying.
const first = await fetch(`${BASE_URL}/v1/chat/completions`, { method: 'POST', headers, body });
if (first.status !== 402) throw new Error(`expected 402, got ${first.status}: ${await first.text()}`);
const pr = PaymentRequest.fromEncodedRequest(first.headers.get('x-cashu')!);
const amount = pr.amount!.toNumber();
console.log(`402 Payment Required: ${amount} ${pr.unit === "usd" ? "cents (usd)" : "sat"} from one of ${pr.mints?.join(', ')}`);

// 2. Get proofs worth exactly `amount` at an accepted mint.
async function fundedProofs(): Promise<{ wallet: Wallet; proofs: Proof[] }> {
  if (process.env.CASHU_TOKEN) {
    const meta = getTokenMetadata(process.env.CASHU_TOKEN);
    if (!pr.includesMint(meta.mint)) throw new Error(`CASHU_TOKEN is from ${meta.mint}, not an accepted mint`);
    const wallet = new Wallet(meta.mint, { unit: pr.unit });
    await wallet.loadMint();
    return { wallet, proofs: await wallet.receive(process.env.CASHU_TOKEN) };
  }
  if (process.env.DEMO_FAKE_MINT) {
    const wallet = new Wallet(pr.mints![0]!, { unit: pr.unit });
    await wallet.loadMint();
    const q = await wallet.createMintQuoteBolt11(amount + 10);
    await new Promise((r) => setTimeout(r, 300)); // FakeWallet pays the quote itself
    return { wallet, proofs: await wallet.mintProofsBolt11(amount + 10, q.quote) };
  }
  throw new Error('set CASHU_TOKEN (or DEMO_FAKE_MINT=1 against a FakeWallet test mint)');
}
const { wallet, proofs } = await fundedProofs();
if (process.env.LEFTOVER_FILE) {
  // Keep a copy of the received proofs until the run finishes, in case it fails midway.
  const { writeFileSync } = await import('node:fs');
  writeFileSync(`${process.env.LEFTOVER_FILE}.received`, getEncodedToken({ mint: wallet.mint.mintUrl, unit: pr.unit, proofs }) + '\n', { mode: 0o600 });
}
const { send, keep } = await wallet.send(amount, proofs, { includeFees: true });
const payment = getEncodedToken({ mint: wallet.mint.mintUrl, unit: pr.unit, proofs: send });

// 3. Retry with the payment.
const paid = await fetch(`${BASE_URL}/v1/chat/completions`, { method: 'POST', headers: { ...headers, 'X-Cashu': payment }, body });
const json = await paid.json();
if (!paid.ok) throw new Error(`payment rejected: ${paid.status} ${JSON.stringify(json)}`);
console.log(`\nAnswer: ${json.choices[0].message.content}`);
const unitName = pr.unit === "usd" ? "cents" : "sat";
console.log(`Charged: ${Number(paid.headers.get("x-forge-charged-msub")) / 1000} ${unitName}`);

// 4. Take the change back.
let change = 0;
const changeToken = paid.headers.get('x-cashu-change');
if (changeToken && lockPub && !lockPriv) {
  // Locked to a key this script does not hold: hand it on to the wallet that does.
  console.log(`Change is locked to ${lockPub}; redeem it in the wallet holding that key: ${changeToken}`);
} else if (changeToken) {
  // A locked token is redeemed by signing its proofs with the private key (cashu-ts does this given privkey).
  const back = await wallet.receive(changeToken, lockPriv ? { privkey: lockPriv } : undefined);
  change = back.reduce((s, p) => s + p.amount.toNumber(), 0);
  keep.push(...back);
  if (lockPub) console.log(`Change was locked to ${lockPub} and redeemed with its private key`);
}
console.log(`Change returned: ${change} ${unitName}; wallet now holds ${keep.reduce((s, p) => s + p.amount.toNumber(), 0)} ${unitName}`);

// 5. Hand back what the wallet holds, so no eCash is lost when the script exits.
if (keep.length) {
  const leftover = getEncodedToken({ mint: wallet.mint.mintUrl, unit: pr.unit, proofs: keep });
  if (process.env.LEFTOVER_FILE) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(process.env.LEFTOVER_FILE, leftover + '\n', { mode: 0o600 });
    console.log(`Leftover eCash written to ${process.env.LEFTOVER_FILE}`);
  } else {
    console.log(`Leftover eCash (receive it in a wallet): ${leftover}`);
  }
}
