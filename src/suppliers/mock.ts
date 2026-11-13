import type { SupplierConfig } from '../config.ts';
import type { ChatCall, Supplier } from './types.ts';

/**
 * Deterministic in-process supplier for tests and local demos. Behaviour is chosen by the upstream model name:
 *  mock-echo      replies with a fixed sentence, 1 token per word, usage reported
 *  mock-slow      streams 200 tokens, 20 ms apart, usage at the end (for disconnect tests)
 *  mock-nousage   streams without a usage chunk
 *  mock-fail      HTTP 500
 *  mock-flaky     HTTP 503 on every other call (retry tests)
 *  mock-think     streams 12 reasoning tokens (delta.reasoning_content) before a markdown answer
 * It never inspects message content beyond its byte length.
 */
export class MockSupplier implements Supplier {
  readonly id: string;
  readonly config: SupplierConfig;
  calls = 0;

  constructor(id: string, config: SupplierConfig) {
    this.id = id;
    this.config = config;
  }

  async chat(call: ChatCall): Promise<Response> {
    this.calls++;
    const name = call.model.upstream;
    if (name === 'mock-fail') return Response.json({ error: { message: 'mock failure', type: 'server_error' } }, { status: 500 });
    if (name === 'mock-flaky' && this.calls % 2 === 1) return Response.json({ error: { message: 'busy' } }, { status: 503 });

    const maxTokens = Number(call.body.max_completion_tokens ?? call.body.max_tokens ?? 4096);
    const promptTokens = Math.ceil(JSON.stringify(call.body.messages ?? []).length / 4);
    const words = name === 'mock-slow' ? 200 : name === 'mock-think' ? THINK_ANSWER.length : 12;
    const n = Math.min(words, maxTokens);
    const tokens = name === 'mock-think' ? THINK_ANSWER.slice(0, n) : Array.from({ length: n }, (_, i) => (i === 0 ? 'Hello' : ' word'));
    const reasoning = name === 'mock-think' ? THINK_REASONING : [];
    const id = 'chatcmpl-mock-' + this.calls;
    const created = Math.floor(Date.now() / 1000);
    const usage = { prompt_tokens: promptTokens, completion_tokens: n, total_tokens: promptTokens + n };

    if (!call.stream) {
      return Response.json({
        id,
        object: 'chat.completion',
        created,
        model: name,
        choices: [{ index: 0, message: { role: 'assistant', content: tokens.join('') }, finish_reason: n < words ? 'length' : 'stop' }],
        usage,
      });
    }

    const includeUsage = name !== 'mock-nousage' && (call.body.stream_options as any)?.include_usage === true;
    const delay = name === 'mock-slow' ? 20 : name === 'mock-think' ? 25 : 0;
    const enc = new TextEncoder();
    const signal = call.signal;
    const body = new ReadableStream<Uint8Array>({
      async start(ctrl) {
        const send = (o: unknown) => ctrl.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
        try {
          for (const r of reasoning) {
            if (signal.aborted) throw new Error('aborted');
            await new Promise((res) => setTimeout(res, 15));
            send({ id, object: 'chat.completion.chunk', created, model: name, choices: [{ index: 0, delta: { reasoning_content: r }, finish_reason: null }] });
          }
          for (let i = 0; i < n; i++) {
            if (signal.aborted) throw new Error('aborted');
            if (delay) await new Promise((r) => setTimeout(r, delay));
            send({ id, object: 'chat.completion.chunk', created, model: name, choices: [{ index: 0, delta: { content: tokens[i] }, finish_reason: null }] });
          }
          send({ id, object: 'chat.completion.chunk', created, model: name, choices: [{ index: 0, delta: {}, finish_reason: n < words ? 'length' : 'stop' }] });
          if (includeUsage) send({ id, object: 'chat.completion.chunk', created, model: name, choices: [], usage });
          ctrl.enqueue(enc.encode('data: [DONE]\n\n'));
          ctrl.close();
        } catch (e) {
          ctrl.error(e);
        }
      },
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  }
}

const THINK_REASONING = ['The', ' user', ' asked', ' a', ' question.', ' I', ' will', ' answer', ' with', ' a', ' short', ' example.'];
const THINK_ANSWER = [
  'Here',
  ' is',
  ' a',
  ' **short**',
  ' answer',
  ' with',
  ' code:\n\n',
  '```js\n',
  'const total = [1, 2, 3].reduce((a, b) => a + b, 0);\n',
  'console.log(total);\n',
  '```\n\n',
  '| Unit | Meaning |\n',
  '| - | - |\n',
  '| sat | bitcoin |\n',
  '| usd | cents |\n',
];
