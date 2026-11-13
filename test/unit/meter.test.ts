import { describe, expect, it } from 'vitest';
import { FrameCounter, SseMeter } from '../../src/meter.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const chunk = (content: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`;

describe('SseMeter', () => {
  it('passes events through, reads usage, handles split chunks', () => {
    const m = new SseMeter();
    const usage = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\n`;
    const all = chunk('Hi') + chunk(' there') + usage + 'data: [DONE]\n\n';
    let out = '';
    for (let i = 0; i < all.length; i += 7) out += m.push(enc(all.slice(i, i + 7)));
    out += m.flush();
    expect(out).toBe(all);
    expect(m.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
    expect(m.deltaChunks).toBe(2);
  });

  it('drops the usage-only chunk when the client did not ask for it', () => {
    const m = new SseMeter({ dropUsageChunk: true });
    const usage = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\n`;
    const out = m.push(enc(chunk('a') + usage + 'data: [DONE]\n\n'));
    expect(out).toBe(chunk('a') + 'data: [DONE]\n\n');
    expect(m.usage?.outputTokens).toBe(2);
  });

  it('estimates output from deltas when usage is missing', () => {
    const m = new SseMeter();
    m.push(enc(chunk('x'.repeat(40)) + chunk('y')));
    expect(m.estimatedOutputTokens()).toBe(11); // ceil(41/4)
  });

  it('handles CRLF framing', () => {
    const m = new SseMeter();
    const out = m.push(enc('data: {"choices":[{"delta":{"content":"a"}}]}\r\n\r\n'));
    expect(out).toContain('"a"');
    expect(m.deltaChunks).toBe(1);
  });
});

describe('FrameCounter', () => {
  it('counts EHBP frames across arbitrary chunk boundaries', () => {
    const frame = (n: number) => {
      const b = new Uint8Array(4 + n);
      new DataView(b.buffer).setUint32(0, n);
      return b;
    };
    const all = new Uint8Array([...frame(10), ...frame(300), ...frame(1)]);
    const f = new FrameCounter();
    for (let i = 0; i < all.length; i += 3) f.push(all.subarray(i, i + 3));
    expect(f.frames).toBe(3);
    expect(f.bytes).toBe(all.length);
  });
});
