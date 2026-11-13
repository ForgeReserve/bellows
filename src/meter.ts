/**
 * Watches an OpenAI SSE stream as it passes through, to settle on what was produced.
 * It keeps only counters (usage numbers, delta counts and lengths); content is never stored or logged.
 */
export class SseMeter {
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
  deltaChunks = 0;
  deltaChars = 0;
  private buf = '';
  private readonly dec = new TextDecoder();
  /** Drop the usage-only chunk we requested on the client's behalf if the client did not ask for it. */
  private readonly dropUsageChunk: boolean;

  constructor(opts: { dropUsageChunk?: boolean } = {}) {
    this.dropUsageChunk = !!opts.dropUsageChunk;
  }

  /** Feeds upstream bytes; returns the text to forward to the client (whole SSE events only). */
  push(bytes: Uint8Array): string {
    this.buf += this.dec.decode(bytes, { stream: true });
    let out = '';
    for (;;) {
      const m = /\r?\n\r?\n/.exec(this.buf);
      if (!m) break;
      const event = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);
      if (this.event(event)) out += event + '\n\n';
    }
    if (this.buf.length > 4_000_000) {
      out += this.buf;
      this.buf = '';
    }
    return out;
  }

  /** Returns any trailing partial event. */
  flush(): string {
    const rest = this.buf + this.dec.decode();
    this.buf = '';
    if (!rest.trim()) return '';
    return this.event(rest) ? rest + '\n\n' : '';
  }

  /** Inspects one SSE event; returns false if it should be dropped. */
  private event(event: string): boolean {
    let keep = true;
    for (const raw of event.split(/\r?\n/)) {
      if (!raw.startsWith('data:')) continue;
      const data = raw.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let o: any;
      try {
        o = JSON.parse(data);
      } catch {
        continue;
      }
      const u = usageFromJson(o);
      if (u) {
        this.usage = u;
        if (this.dropUsageChunk && Array.isArray(o.choices) && o.choices.length === 0) keep = false;
      }
      for (const c of Array.isArray(o?.choices) ? o.choices : []) {
        const d = c?.delta;
        if (!d) continue;
        let len = 0;
        if (typeof d.content === 'string') len += d.content.length;
        if (typeof d.reasoning_content === 'string') len += d.reasoning_content.length;
        if (typeof d.reasoning === 'string') len += d.reasoning.length;
        if (Array.isArray(d.tool_calls)) len += JSON.stringify(d.tool_calls).length;
        if (len > 0) {
          this.deltaChunks++;
          this.deltaChars += len;
        }
      }
    }
    return keep;
  }

  /** Output tokens produced so far: at least one per content chunk, or chars/4 if larger. */
  estimatedOutputTokens(): number {
    return Math.max(this.deltaChunks, Math.ceil(this.deltaChars / 4));
  }
}

export function usageFromJson(o: any): { inputTokens: number; outputTokens: number; costUsd?: number } | undefined {
  const u = o?.usage;
  if (!u || typeof u !== 'object') return undefined;
  const inp = Number(u.prompt_tokens ?? u.input_tokens);
  const out = Number(u.completion_tokens ?? u.output_tokens);
  if (!Number.isFinite(inp) || !Number.isFinite(out)) return undefined;
  // LiteLLM (Token Factory) adds the request's cost in USD to the usage object.
  const cost = u.cost == null ? NaN : Number(u.cost);
  return { inputTokens: inp, outputTokens: out, ...(Number.isFinite(cost) && cost >= 0 ? { costUsd: cost } : {}) };
}

/** LiteLLM's per-request cost header (USD), sent on non-streaming responses. */
export function costFromHeaders(h: Headers): number | undefined {
  const v = h.get('x-litellm-response-cost');
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Counts EHBP frames ([4-byte big-endian length][ciphertext]) in a response body without decrypting.
 * For a streamed completion each frame is roughly one SSE event, so this approximates tokens produced
 * when the client disconnects before the enclave reports usage.
 */
export class FrameCounter {
  frames = 0;
  bytes = 0;
  private need = 4;
  private header: number[] = [];
  private inBody = false;

  push(chunk: Uint8Array) {
    this.bytes += chunk.length;
    let i = 0;
    while (i < chunk.length) {
      if (!this.inBody) {
        this.header.push(chunk[i]!);
        i++;
        if (this.header.length === 4) {
          const [a, b, c, d] = this.header as [number, number, number, number];
          this.need = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
          this.header = [];
          this.inBody = true;
          this.frames++;
          if (this.need === 0) this.inBody = false;
        }
      } else {
        const take = Math.min(this.need, chunk.length - i);
        this.need -= take;
        i += take;
        if (this.need === 0) this.inBody = false;
      }
    }
  }
}
