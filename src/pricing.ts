import type { FlatPricing, ModelConfig, Unit } from './config.ts';

/**
 * Money is tracked in "msub": one thousandth of the unit's smallest denomination.
 * usd: 1 cent = 1000 msub (milli-cents). sat: 1 sat = 1000 msub (msat).
 * Upstream prices are USD per million tokens. Internally we work in nano-USD (1e-9 USD),
 * so a price of $X per million tokens is X * 1000 nano-USD per token.
 */
export const MSUB_PER_UNIT = 1000;

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** What the supplier says this request cost us, in USD, when it reports it. */
  costUsd?: number;
}

/** Sale price per token in nano-USD, after markup. Rounded up so we never undercharge. */
export function nanoUsdPerToken(usdPerMtok: number, markup: number): number {
  return Math.ceil(usdPerMtok * markup * 1000 - 1e-9);
}

export function costNanoUsd(model: Pick<ModelConfig, 'input_usd_per_mtok' | 'output_usd_per_mtok'>, usage: Usage, markup: number): number {
  return (
    usage.inputTokens * nanoUsdPerToken(model.input_usd_per_mtok, markup) +
    usage.outputTokens * nanoUsdPerToken(model.output_usd_per_mtok, markup)
  );
}

export function flatCostNanoUsd(flat: FlatPricing, bodyBytes: number, maxOutputTokens: number, markup: number): number {
  const bucket = flat.buckets.find((b) => b.maxBytes >= bodyBytes) ?? flat.buckets[flat.buckets.length - 1]!;
  const base = Math.ceil(bucket.usd * markup * 1e9);
  return base + maxOutputTokens * nanoUsdPerToken(flat.output_usd_per_mtok, markup);
}

/**
 * Converts nano-USD to msub of the given unit, rounding up.
 * usd: 1 msub = 1e-5 USD = 10_000 nano-USD.
 * sat: 1 msub = 1 msat = 1e-11 BTC; nanoUsd / 1e9 / rate * 1e11 = nanoUsd * 100 / rate.
 */
export function nanoUsdToMsub(nanoUsd: number, unit: Unit, btcUsd?: number): number {
  if (nanoUsd <= 0) return 0;
  if (unit === 'usd') return Math.ceil(nanoUsd / 10_000);
  if (!btcUsd || !(btcUsd > 0)) throw new Error('BTC/USD rate unavailable');
  return Math.ceil((nanoUsd * 100) / btcUsd);
}

/** Whole units needed to cover an msub amount (round up). */
export function msubToUnitsCeil(msub: number): number {
  return Math.ceil(msub / MSUB_PER_UNIT);
}

export function formatMsub(msub: number, unit: Unit): string {
  const units = msub / MSUB_PER_UNIT;
  return unit === 'usd' ? `${(units / 100).toFixed(5)} USD` : `${units.toFixed(3)} sat`;
}

/** Per-million-token price in the requested unit, for display. */
export function displayPrice(usdPerMtok: number, markup: number, unit: Unit, btcUsd?: number): number | null {
  const usd = usdPerMtok * markup;
  if (unit === 'usd') return usd;
  if (!btcUsd) return null;
  return (usd / btcUsd) * 1e8;
}

/** Conservative token estimate for reservation: bytes / bytesPerToken, rounded up. */
export function estimateTokensFromBytes(bytes: number, bytesPerToken: number): number {
  return Math.ceil(bytes / bytesPerToken);
}
