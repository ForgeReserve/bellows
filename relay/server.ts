/**
 * The Bellows relay as a Node server.
 *
 *   BELLOWS_RELAY_TARGETS=https://bellows.example/ohttp node relay/server.ts
 *
 * Environment:
 *   BELLOWS_RELAY_TARGETS        comma-separated gateway URLs to forward to (required)
 *   BELLOWS_RELAY_PORT           default 8788 (a whole number from 1 to 65535)
 *   BELLOWS_RELAY_HOST           default 127.0.0.1 (put TLS in front of it)
 *   BELLOWS_RELAY_MAX_BODY_BYTES default 2097152 (a whole number of at least 1024)
 *
 * A value that is not a whole number in range stops the server at startup with a message.
 *
 * It writes one line at startup (port and number of targets) and nothing about any request.
 */
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, type ServerType } from '@hono/node-server';
import { createRelay, parseMaxBodyBytes, parsePort, targetsFromList } from './relay.ts';

export interface RelayServerOptions {
  targets: readonly string[];
  port?: number;
  host?: string;
  maxBodyBytes?: number;
}

export function startRelay(o: RelayServerOptions): Promise<{ server: ServerType; port: number; close(): Promise<void> }> {
  const handler = createRelay({ targets: o.targets, maxBodyBytes: o.maxBodyBytes });
  return new Promise((resolve) => {
    const server = serve({ fetch: handler, port: o.port ?? 8788, hostname: o.host ?? '127.0.0.1' }, (info) =>
      resolve({
        server,
        port: info.port,
        close: () =>
          new Promise<void>((r) => {
            (server as { closeAllConnections?: () => void }).closeAllConnections?.();
            server.close(() => r());
          }),
      }),
    );
  });
}

if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const targets = targetsFromList(process.env.BELLOWS_RELAY_TARGETS);
  if (!targets.length) {
    process.stderr.write('BELLOWS_RELAY_TARGETS is empty: name at least one Bellows gateway URL, e.g. https://bellows.example/ohttp\n');
    process.exit(1);
  }
  let port: number | undefined;
  let max: number | undefined;
  try {
    port = parsePort(process.env.BELLOWS_RELAY_PORT);
    max = parseMaxBodyBytes(process.env.BELLOWS_RELAY_MAX_BODY_BYTES);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
  const r = await startRelay({ targets, port, host: process.env.BELLOWS_RELAY_HOST, maxBodyBytes: max });
  process.stdout.write(`bellows relay listening on port ${r.port} for ${targets.length} gateway(s); it keeps no logs\n`);
}
