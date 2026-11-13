/**
 * Sealed state against the local mints: the wallet seed is derived from the wallet secret and nothing else,
 * so the secret alone recovers the gateway's eCash from the mint (NUT-09), and neither the secret nor the
 * seed is ever written to the database or the logs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Wallet } from '@cashu/cashu-ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '../../src/db.ts';
import { deriveWalletSeed } from '../../src/wallet-seed.ts';
import { captureLogs, chatBody, type Gateway, MINT_A, mintToken, mintsUp, startGateway } from './helpers.ts';

const up = await mintsUp();

describe.skipIf(!up)('sealed state', () => {
  let g: Gateway;
  let logs: ReturnType<typeof captureLogs>;
  let secret: string;
  let key: string;

  beforeAll(async () => {
    logs = captureLogs();
    g = await startGateway({ inviteOnly: false });
    secret = JSON.parse(readFileSync(join(dirname(g.dbPath), 'secrets.json'), 'utf8')).BELLOWS_WALLET_SECRET;
    const r = await fetch(`${g.url}/v1/wallet/topup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: await mintToken(MINT_A, 'usd', 100) }) });
    expect(r.status).toBe(200);
    key = (await r.json()).key;
    const chat = await fetch(`${g.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(chatBody('mock-echo')) });
    expect(chat.status).toBe(200);
    await chat.text();
  });
  afterAll(async () => {
    logs.stop();
    await g?.close();
  });

  it('runs on a seed derived from the wallet secret', () => {
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(g.deps.wallet.bip39seed).toEqual(deriveWalletSeed(secret));
    expect(logs.entries().find((e) => e.msg === 'startup')).toMatchObject({ mode: 'development', secrets: 'file', wallet_seed: 'derived' });
  });

  it('the wallet secret alone recovers the eCash the gateway holds (NUT-09 restore with no database)', async () => {
    const w = new Wallet(MINT_A, { unit: 'usd', bip39seed: deriveWalletSeed(secret) });
    await w.loadMint();
    const { proofs } = await w.batchRestore();
    const states = await w.checkProofsStates(proofs);
    const unspent = proofs.filter((_, i) => states[i]!.state === 'UNSPENT');
    expect(unspent.reduce((s, p) => s + p.amount.toNumber(), 0)).toBe(100);
  });

  it('a fresh database with the same secret gets the same seed, and no database stores one', async () => {
    const fresh = await startGateway({ inviteOnly: false, env: { BELLOWS_WALLET_SECRET: secret } });
    try {
      expect(fresh.dbPath).not.toBe(g.dbPath);
      expect(fresh.deps.wallet.bip39seed).toEqual(g.deps.wallet.bip39seed);
    } finally {
      await fresh.close();
    }
    for (const path of [g.dbPath, fresh.dbPath]) {
      const db = openDb(path);
      expect(db.prepare("SELECT value FROM meta WHERE key = 'wallet_seed'").get()).toBeUndefined();
      db.close();
    }
  });

  it('neither the secret nor the seed is in the database files or the logs', () => {
    const seedHex = Buffer.from(deriveWalletSeed(secret)).toString('hex');
    const files = [g.dbPath, `${g.dbPath}-wal`].filter(existsSync).map((p) => readFileSync(p));
    for (const f of files) {
      for (const needle of [secret, seedHex]) {
        expect(f.includes(Buffer.from(needle, 'utf8'))).toBe(false);
        expect(f.includes(Buffer.from(needle, 'hex'))).toBe(false);
      }
    }
    const all = logs.lines.join('\n');
    expect(all).not.toContain(secret);
    expect(all).not.toContain(seedHex);
  });
});
