import { afterEach, describe, expect, it } from 'vitest';
import { EnvSchema, normalizeMintUrl, setMintAliases } from '../../src/config.ts';

const DEFAULT = EnvSchema.parse({ BELLOWS_TRUSTED_MINTS: 'https://mint.example' }).BELLOWS_MINT_ALIASES;
afterEach(() => setMintAliases(DEFAULT));

describe('mint aliases', () => {
  it('has none by default', () => {
    expect(DEFAULT).toEqual([]);
    setMintAliases(DEFAULT);
    expect(normalizeMintUrl('https://second.mint.example/')).toBe('https://second.mint.example');
  });

  it('folds a configured second address onto the main one', () => {
    setMintAliases(['https://second.mint.example=https://mint.example']);
    expect(normalizeMintUrl('https://second.mint.example/')).toBe('https://mint.example');
    expect(normalizeMintUrl(' https://second.mint.example ')).toBe('https://mint.example');
    expect(normalizeMintUrl('https://mint.example/')).toBe('https://mint.example');
  });

  it('leaves other mints alone', () => {
    setMintAliases(['https://second.mint.example=https://mint.example']);
    expect(normalizeMintUrl('https://mint.minibits.cash/Bitcoin/')).toBe('https://mint.minibits.cash/Bitcoin');
  });

  it('rejects an entry without a main address', () => {
    expect(() => setMintAliases(['https://a.example'])).toThrow(/alias=main/);
  });
});
