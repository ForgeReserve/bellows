/**
 * Structured JSON logs. Privacy rule: never pass prompt or completion content here, and nothing that
 * identifies a client: no network address, user agent, referrer, forwarded-for value or balance id.
 * Fields are limited to request and funding ids, model, token counts, cost, status and latency.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: Level = (process.env.BELLOWS_LOG_LEVEL as Level) || 'info';
let silent = process.env.BELLOWS_LOG_SILENT === '1';
let sink: ((line: string) => void) | undefined;

export function setLogLevel(level: Level) {
  threshold = level;
}
export function setLogSilent(v: boolean) {
  silent = v;
}
/** Tests: receive every line that passes the level threshold, even while output is silent. */
export function setLogSink(fn: ((line: string) => void) | undefined) {
  sink = fn;
}

type Fields = Record<string, string | number | boolean | null | undefined>;

function emit(level: Level, msg: string, fields?: Fields) {
  if (ORDER[level] < ORDER[threshold]) return;
  if (silent && !sink) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  sink?.(line);
  if (silent) return;
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

export const log = {
  debug: (m: string, f?: Fields) => emit('debug', m, f),
  info: (m: string, f?: Fields) => emit('info', m, f),
  warn: (m: string, f?: Fields) => emit('warn', m, f),
  error: (m: string, f?: Fields) => emit('error', m, f),
};

/** Error text safe for logs: message only, truncated, no request data. */
export function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.slice(0, 200);
}
