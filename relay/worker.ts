/**
 * The Bellows relay as a Cloudflare Worker. Configure the allowlist with the BELLOWS_RELAY_TARGETS variable
 * (comma-separated gateway URLs) in wrangler.toml. See relay/README.md.
 */
import { createRelay, parseMaxBodyBytes, type RelayHandler, targetsFromList } from './relay.ts';

export interface RelayEnv {
  BELLOWS_RELAY_TARGETS?: string;
  BELLOWS_RELAY_MAX_BODY_BYTES?: string;
}

let cached: { key: string; handler: RelayHandler } | undefined;

function handlerFor(env: RelayEnv): RelayHandler {
  const key = `${env.BELLOWS_RELAY_TARGETS ?? ''}|${env.BELLOWS_RELAY_MAX_BODY_BYTES ?? ''}`;
  if (cached?.key !== key) {
    cached = { key, handler: createRelay({ targets: targetsFromList(env.BELLOWS_RELAY_TARGETS), maxBodyBytes: parseMaxBodyBytes(env.BELLOWS_RELAY_MAX_BODY_BYTES) }) };
  }
  return cached.handler;
}

export default {
  fetch(request: Request, env: RelayEnv): Promise<Response> {
    return handlerFor(env)(request);
  },
};
