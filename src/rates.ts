import { log } from './log.ts';

/** A BTC/USD price source. Implement this to plug in another feed. */
export interface RateSource {
  name: string;
  fetchBtcUsd(signal: AbortSignal): Promise<number>;
}

async function getJson(url: string, signal: AbortSignal): Promise<any> {
  const res = await fetch(url, { signal, headers: { accept: 'application/json', 'user-agent': 'bellows/0.1' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function positive(n: unknown): number {
  const v = typeof n === 'string' ? Number(n) : (n as number);
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Error('bad price');
  return v;
}

export const BUILTIN_SOURCES: Record<string, RateSource> = {
  coinbase: {
    name: 'coinbase',
    fetchBtcUsd: async (s) => positive((await getJson('https://api.coinbase.com/v2/prices/BTC-USD/spot', s)).data?.amount),
  },
  kraken: {
    name: 'kraken',
    fetchBtcUsd: async (s) => {
      const j = await getJson('https://api.kraken.com/0/public/Ticker?pair=XBTUSD', s);
      const first = j.result ? Object.values(j.result)[0] : undefined;
      return positive((first as any)?.c?.[0]);
    },
  },
  bitstamp: {
    name: 'bitstamp',
    fetchBtcUsd: async (s) => positive((await getJson('https://www.bitstamp.net/api/v2/ticker/btcusd/', s)).last),
  },
  coingecko: {
    name: 'coingecko',
    fetchBtcUsd: async (s) =>
      positive((await getJson('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd', s)).bitcoin?.usd),
  },
};

export function fixedRateSource(name: string, price: number): RateSource {
  return { name, fetchBtcUsd: async () => price };
}

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export interface RateOptions {
  minSources: number;
  ttlMs: number;
  maxStaleMs: number;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * Median BTC/USD across sources, cached for ttlMs.
 * Failure mode: if fewer than minSources answer, the last good rate is kept until it is maxStaleMs old;
 * after that, current() returns undefined and sat pricing is refused (HTTP 503) rather than guessed.
 */
export class RateOracle {
  private last?: { rate: number; at: number; sources: string[] };
  private inflight?: Promise<void>;
  private readonly sources: RateSource[];
  private readonly opts: RateOptions;

  constructor(sources: RateSource[], opts: RateOptions) {
    this.sources = sources;
    this.opts = opts;
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  async refresh(): Promise<void> {
    const signal = AbortSignal.timeout(this.opts.timeoutMs ?? 5000);
    const results = await Promise.allSettled(this.sources.map((s) => s.fetchBtcUsd(signal)));
    const ok: number[] = [];
    const names: string[] = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        ok.push(r.value);
        names.push(this.sources[i]!.name);
      } else {
        log.warn('rate_source_failed', { source: this.sources[i]!.name });
      }
    });
    if (ok.length >= this.opts.minSources) {
      this.last = { rate: median(ok), at: this.now(), sources: names };
    } else {
      log.warn('rate_refresh_insufficient', { ok: ok.length, need: this.opts.minSources });
    }
  }

  /** Returns a usable rate, refreshing if the cache is older than ttl. */
  async get(): Promise<number | undefined> {
    const age = this.last ? this.now() - this.last.at : Infinity;
    if (age > this.opts.ttlMs) {
      this.inflight ??= this.refresh().finally(() => (this.inflight = undefined));
      await this.inflight;
    }
    return this.current();
  }

  current(): number | undefined {
    if (!this.last) return undefined;
    if (this.now() - this.last.at > this.opts.maxStaleMs) return undefined;
    return this.last.rate;
  }

  status() {
    return this.last ? { rate: this.last.rate, ageMs: this.now() - this.last.at, sources: this.last.sources } : null;
  }
}
