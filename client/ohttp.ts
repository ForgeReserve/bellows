/**
 * Oblivious HTTP (RFC 9458) to a verified Bellows. bellowsFetch wraps one API call for the attested HPKE key,
 * sends it through a relay when one is given or straight to the Bellows otherwise, and unwraps the answer.
 *
 *   const bellows = await verifyBellows(url, { approvedBuilds, verifier });
 *   const res = await bellowsFetch({ ...bellows, relay: 'https://relay.example/relay/bellows.example' }, '/v1/models');
 *
 * A relay sees the client's address and ciphertext. The Bellows sees the request and the relay's address.
 * Nothing between the client and the sealed machine can read or change the request.
 *
 * Web APIs only (fetch, WebCrypto, streams), so it runs in browsers and in Node.
 */
import { AEAD_AES_128_GCM, CipherSuite, KDF_HKDF_SHA256, KEM_DHKEM_X25519_HKDF_SHA256 } from 'hpke';
import { ChunkedOHTTPClient, KeyConfig, MediaType, OHTTPClient } from 'ohttp-ts';

/** Where a Bellows takes encapsulated requests. */
export const OHTTP_PATH = '/ohttp';
/** Its key configuration as application/ohttp-keys. The same key /.well-known/bellows attests. */
export const OHTTP_KEYS_PATH = '/ohttp-keys';
/**
 * The time the request was made, as an HTTP date, inside the encapsulated request. Browsers do not let a
 * page set Date, so the client sends this; the gateway accepts either.
 */
export const OHTTP_DATE_HEADER = 'Bellows-Date';
/** Set by the Bellows relay on errors it makes itself, so a client can tell them from the gateway's. */
export const RELAY_ERROR_HEADER = 'Bellows-Relay-Error';
/** Inner answer when the request's date is too far from the gateway's clock; the answer carries its date. */
export const STALE_REQUEST = 'stale_request';
/**
 * Largest Binary HTTP message in a plain RFC 9458 exchange, request or answer, padding included. The same as
 * the default of BELLOWS_OHTTP_MAX_MESSAGE_BYTES on the gateway.
 */
export const DEFAULT_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
/**
 * Largest chunked OHTTP answer, padding included: 1 GiB, the chunked OHTTP default of ohttp-ts. A streamed
 * answer has no other bound, so it ends only when the app ends it.
 */
export const DEFAULT_MAX_CHUNKED_ANSWER_BYTES = 1 << 30;

/** The one HPKE suite Bellows offers: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM. */
export function ohttpSuite(): CipherSuite {
  return new CipherSuite(KEM_DHKEM_X25519_HKDF_SHA256, KDF_HKDF_SHA256, AEAD_AES_128_GCM);
}

export type FetchErrorCode = 'bad_path' | 'bad_request' | 'bad_key_config' | 'network' | 'relay_error' | 'gateway_refused' | 'bad_response';

export class BellowsFetchError extends Error {
  readonly code: FetchErrorCode;
  /** HTTP status of the outer answer, when there was one. */
  readonly status?: number;
  constructor(code: FetchErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'BellowsFetchError';
    this.code = code;
    this.status = status;
  }
}

/** A verified Bellows (the result of verifyBellows fits), and optionally the relay to reach it through. */
export interface BellowsOperator {
  /** The Bellows' origin, e.g. https://bellows.example. */
  origin: string;
  /** The attested RFC 9458 key configuration. Never a key read from /ohttp-keys without the attestation. */
  keyConfig: Uint8Array;
  /** The relay URL that forwards to this Bellows. Unset or null: send straight to the Bellows. */
  relay?: string | null;
}

export interface BellowsFetchOptions {
  /** Overrides operator.relay. null sends straight to the Bellows. */
  relay?: string | null;
  /**
   * Chunked OHTTP (draft-ietf-ohai-chunked-ohttp-08, default) streams the answer in sealed 16 KiB chunks.
   * false uses plain RFC 9458 messages, which some third-party relays require; the answer then arrives whole.
   */
  chunked?: boolean;
  /**
   * Largest Binary HTTP message this client sends or opens, padding included. Default: 8 MiB in plain mode
   * (DEFAULT_MAX_MESSAGE_BYTES) and 1 GiB in chunked mode (DEFAULT_MAX_CHUNKED_ANSWER_BYTES). In plain mode it
   * must be at least the gateway's BELLOWS_OHTTP_MAX_MESSAGE_BYTES: an answer the gateway sends but this client
   * refuses has already run, and its charge stands.
   */
  maxMessageBytes?: number;
  /** fetch to use (default: the global one). */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Clock for the request date (default: Date.now). */
  now?: () => number;
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/**
 * Sends `init` to `path` on the Bellows as an Oblivious HTTP request and returns the Bellows' answer, as a
 * normal Response. Throws BellowsFetchError when the request cannot be sent or the answer cannot be opened.
 * An answer from the Bellows with an error status (402, 429, ...) is returned like any other answer.
 */
export async function bellowsFetch(operator: BellowsOperator, path: string, init: RequestInit = {}, options: BellowsFetchOptions = {}): Promise<Response> {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
    throw new BellowsFetchError('bad_path', `path must start with a single "/": ${String(path)}`);
  }
  let origin: string;
  try {
    origin = new URL(operator.origin).origin;
  } catch {
    throw new BellowsFetchError('bad_path', `not a URL: ${operator.origin}`);
  }
  let key: KeyConfig;
  try {
    key = KeyConfig.parse(operator.keyConfig);
  } catch {
    throw new BellowsFetchError('bad_key_config', 'the key configuration is not RFC 9458');
  }
  const suite = ohttpSuite();
  const chunked = options.chunked !== false;
  const maxMessageSize = options.maxMessageBytes ?? (chunked ? DEFAULT_MAX_CHUNKED_ANSWER_BYTES : DEFAULT_MAX_MESSAGE_BYTES);
  // Every message is padded to at least 1 KiB, so a smaller limit could carry nothing.
  if (!Number.isSafeInteger(maxMessageSize) || maxMessageSize < 1024) {
    throw new BellowsFetchError('bad_request', `maxMessageBytes must be an integer of at least 1024: ${String(options.maxMessageBytes)}`);
  }
  let client: OHTTPClient | ChunkedOHTTPClient;
  try {
    client = chunked ? new ChunkedOHTTPClient(suite, key, { maxMessageSize }) : new OHTTPClient(suite, key, { maxMessageSize });
  } catch {
    throw new BellowsFetchError('bad_key_config', 'the key configuration does not offer X25519, HKDF-SHA256 and AES-128-GCM');
  }
  const relay = options.relay !== undefined ? options.relay : (operator.relay ?? null);
  const target = relay ?? origin + OHTTP_PATH;
  const doFetch = options.fetch ?? ((input: string, i?: RequestInit) => fetch(input, i));
  const now = options.now ?? Date.now;

  // The inner request. Its signal, credentials and the like belong to the outer request, not inside it.
  const { signal, ...rest } = init;
  const base = new Request(origin + path, { ...rest, signal: undefined, ...(rest.body instanceof ReadableStream ? { duplex: 'half' } : {}) } as RequestInit);

  let skewMs = 0;
  for (let attempt = 0; ; attempt++) {
    const inner = base.clone();
    const headers = new Headers(inner.headers);
    headers.set(OHTTP_DATE_HEADER, new Date(now() + skewMs).toUTCString());
    const req = new Request(inner, { headers });

    let encapsulated: { init: RequestInit; context: { decapsulateResponse(r: Response): Promise<Response> } };
    try {
      const { init: outer, context } = await client.encapsulateRequest(req);
      // Send the encapsulated request as bytes: browsers and mobile runtimes do not all stream request bodies.
      const body = new Uint8Array(await new Response(outer.body).arrayBuffer());
      encapsulated = {
        init: { method: 'POST', headers: { 'content-type': chunked ? MediaType.CHUNKED_REQUEST : MediaType.REQUEST }, body, signal, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' },
        context,
      };
    } catch (e) {
      throw new BellowsFetchError('bad_request', `could not encapsulate the request: ${e instanceof Error ? e.message : String(e)}`);
    }

    let res: Response;
    try {
      res = await doFetch(target, encapsulated.init);
    } catch (e) {
      if (signal?.aborted) throw signal.reason;
      throw new BellowsFetchError('network', `could not reach ${relay ? 'the relay' : 'the Bellows'}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status !== 200) {
      const relayError = res.headers.get(RELAY_ERROR_HEADER);
      await res.body?.cancel().catch(() => {});
      if (relayError) throw new BellowsFetchError('relay_error', `the relay refused the request: ${relayError}`, res.status);
      throw new BellowsFetchError('gateway_refused', `the Oblivious HTTP gateway refused the request (HTTP ${res.status})`, res.status);
    }
    let answer: Response;
    try {
      answer = await encapsulated.context.decapsulateResponse(res);
    } catch (e) {
      if (signal?.aborted) throw signal.reason;
      throw new BellowsFetchError('bad_response', `could not open the answer: ${e instanceof Error ? e.message : String(e)}`);
    }

    // The gateway refuses a request dated too far from its clock before running it, so one retry on its
    // clock is safe.
    if (attempt === 0 && answer.status === 400) {
      const serverDate = Date.parse(answer.headers.get(OHTTP_DATE_HEADER) ?? '');
      if (Number.isFinite(serverDate)) {
        const body: unknown = await answer.clone().json().catch(() => null);
        if (isObject(body) && isObject(body.error) && body.error.code === STALE_REQUEST) {
          await answer.body?.cancel().catch(() => {});
          skewMs = serverDate - now();
          continue;
        }
      }
    }
    return answer;
  }
}
