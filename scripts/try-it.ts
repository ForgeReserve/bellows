/**
 * Tries a running Bellows end to end with a small amount of eCash:
 *
 *   node scripts/try-it.ts https://<bellows> [model]
 *
 * It asks for a Cashu token (hidden), solves the proof of work, opens a balance with the token, asks one
 * streamed question, then withdraws what is left as a new token and prints it so you can take it back.
 * The token you paste is never printed or stored. Use a small amount.
 */
import { createInterface } from 'node:readline';
import { POW_HEADER, solvePow } from '../client/pow.ts';

const base = (process.argv[2] ?? '').replace(/\/+$/, '');
if (!/^https?:\/\//.test(base)) {
  console.error('usage: node scripts/try-it.ts https://<bellows> [model]');
  process.exit(2);
}

function askHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void };
    let asked = false;
    out._writeToOutput = (s: string) => {
      if (!asked) {
        process.stdout.write(s);
        asked = true;
      }
    };
    rl.question(prompt, (v) => {
      rl.close();
      process.stdout.write('\n');
      resolve(v.trim());
    });
  });
}

const json = (r: Response) => r.json() as Promise<any>;
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

const models = await json(await fetch(`${base}/v1/models`));
const model = process.argv[3] ?? models.data[0].id;
console.log(`Bellows at ${base}\n  takes eCash from: ${models.mints.join(', ')}\n  model: ${model}`);

const token = await askHidden('Paste a small Cashu token from that mint (hidden): ');
if (!token.startsWith('cashu')) {
  console.error('that does not look like a Cashu token; nothing was sent');
  process.exit(1);
}

// 1. Open a balance. The first answer is the proof-of-work challenge.
let res = await post('/v1/wallet/topup', { token });
if (res.status === 428) {
  const { pow } = await json(res);
  const t0 = Date.now();
  const solution = await solvePow(pow.challenge, pow.bits);
  console.log(`proof of work: ${pow.bits} bits solved in ${Date.now() - t0} ms`);
  res = await post('/v1/wallet/topup', { token }, { [POW_HEADER]: solution });
}
const top = await json(res);
if (!res.ok || !top.key) {
  console.error(`topup failed (${res.status}):`, top.error?.message ?? top);
  process.exit(1);
}
const auth = { authorization: `Bearer ${top.key}` };
console.log(`balance opened: ${top.credited} ${top.unit} credited`);

// 2. One streamed question. Print when each piece arrives, to show that the answer streams.
const t0 = Date.now();
const chat = await post(
  '/v1/chat/completions',
  { model, stream: true, max_tokens: 200, messages: [{ role: 'user', content: 'Count from 1 to 20, one number per line, then say done.' }] },
  auth,
);
if (!chat.ok || !chat.body) {
  console.error(`chat failed (${chat.status}):`, await chat.text());
} else {
  const reader = chat.body.getReader();
  const dec = new TextDecoder();
  let chunks = 0;
  let first = 0;
  let text = '';
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks++;
    if (!first) first = Date.now() - t0;
    buf += dec.decode(value, { stream: true });
    for (;;) {
      const i = buf.indexOf('\n');
      if (i < 0) break;
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
      try {
        text += JSON.parse(line.slice(5)).choices?.[0]?.delta?.content ?? '';
      } catch {
        // not a chat chunk (for example the usage event)
      }
    }
  }
  const total = Date.now() - t0;
  console.log(`answer: ${JSON.stringify(text.slice(0, 120))}${text.length > 120 ? '…' : ''}`);
  console.log(`streaming: first piece after ${first} ms, ${chunks} network pieces over ${total} ms ${chunks > 3 && total - first > 200 ? '(streamed)' : '(arrived at once: NOT streamed)'}`);
}

// 3. Take back what is left.
const wallet = await json(await fetch(`${base}/v1/wallet`, { headers: auth }));
console.log(`balance now: ${wallet.balance} ${wallet.unit}, ${wallet.refundable} can be withdrawn`);
if (wallet.refundable > 0) {
  const ref = await json(await post('/v1/wallet/refund', {}, auth));
  if (ref.token) console.log(`\nYour change, ${ref.amount} ${ref.unit}. Receive this token in your wallet:\n\n${ref.token}\n`);
  else console.log(`the refund is saved but the mint did not answer (status ${ref.status}); run this again later with the same balance key`);
}
