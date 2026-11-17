/**
 * Bellows client library. Runs in browsers and in Node (Web APIs only: fetch, WebCrypto, TextEncoder).
 *
 *   const bellows = await verifyBellows('https://bellows.example', {
 *     approvedBuilds: buildsJson,
 *     verifier: tinfoilVerifier({ authenticate }),
 *   });
 *   // bellows.keyConfig is the attested HPKE key; send nothing if verifyBellows throws.
 *   const res = await bellowsFetch({ ...bellows, relay: 'https://relay.example/relay/bellows.example' }, '/v1/models');
 *
 * Many operators (docs/OPERATORS.md): load their signed announcements, let OperatorPool verify, health-check,
 * pick and fail over, and moveBalance to take a balance from one operator to another.
 *
 *   const { announcements } = await loadOperatorAnnouncements(['wss://nostr-relay.example']);
 *   const pool = new OperatorPool({ operators: announcements, approvedBuilds: buildsJson, verifier, memory: storageMemory(localStorage) });
 *   const { response } = await pool.fetch('/v1/models');
 */
export { BUILDS_FORMAT, checkBuilds, findBuild, measurementEquals, parseBuilds, parseMeasurement } from './builds.ts';
export type { ApprovedBuild, BuildsFile, Measurement } from './builds.ts';
export { DEV_ATTESTATION_FORMAT, DEV_MEASUREMENT_TYPE, DEV_WARNING, devVerifier } from './dev.ts';
export type { DevPayload, DevVerifierOptions } from './dev.ts';
export { BellowsVerifyError, OperatorError } from './errors.ts';
export type { OperatorErrorCode, VerifyErrorCode } from './errors.ts';
export {
  AEAD_AES_128_GCM,
  AEAD_AES_256_GCM,
  AEAD_CHACHA20_POLY1305,
  encodeKeyConfig,
  KDF_HKDF_SHA256,
  KEM_X25519_HKDF_SHA256,
  parseKeyConfig,
} from './hpke.ts';
export type { CipherSuite, KeyConfig } from './hpke.ts';
export { bindingFor, decodeStatement, encodeStatement, IDENTITY_FORMAT, STORAGE_KINDS, WELL_KNOWN_PATH } from './identity.ts';
export {
  BellowsFetchError,
  bellowsFetch,
  DEFAULT_MAX_CHUNKED_ANSWER_BYTES,
  DEFAULT_MAX_MESSAGE_BYTES,
  OHTTP_DATE_HEADER,
  OHTTP_KEYS_PATH,
  OHTTP_PATH,
  ohttpSuite,
  RELAY_ERROR_HEADER,
  STALE_REQUEST,
} from './ohttp.ts';
export type { BellowsFetchOptions, BellowsOperator, FetchErrorCode } from './ohttp.ts';
export type { AttestationDocument, IdentityDocument, Statement, Storage } from './identity.ts';
export {
  checkTinfoilBinding,
  TINFOIL_RELEASE_MEASUREMENT_TYPE,
  TINFOIL_REPORT_DATA_V1,
  TINFOIL_V3_FORMAT,
  tinfoilReportData,
  tinfoilVerifier,
} from './tinfoil.ts';
export type { TinfoilAuthenticated, TinfoilQuoteCheck, TinfoilVerifierOptions } from './tinfoil.ts';
export type { AttestationVerifier, VerifiedAttestation } from './verifier.ts';
export { verifyBellows } from './verify.ts';
export { eventId, isEventShape, publicKeyOf, publishEvent, queryRelays, signEvent, verifyEvent, webSocketConnect } from './nostr.ts';
export type { NostrEvent, PublishResult, RelayOptions, SocketConnect, SocketLike, UnsignedEvent } from './nostr.ts';
export {
  latestAnnouncements,
  loadOperatorAnnouncements,
  normalizeMint,
  OPERATOR_ALT,
  OPERATOR_KIND,
  operatorEventTemplate,
  parseOperatorAnnouncement,
  signOperatorAnnouncement,
} from './operator.ts';
export type { LoadOperatorsOptions, OperatorAnnouncement, OperatorAnnouncementFields } from './operator.ts';
export { memoryInProcess, OperatorPool, storageMemory, tryOrder } from './pool.ts';
export type { OperatorMemory, OperatorPoolOptions, PoolFetchOptions, ReadyOperator, Requirements, Route } from './pool.ts';
export { MoveBalanceError, moveBalance, newBalanceKey } from './move.ts';
export type { MoveErrorCode, MoveOptions, MoveResult, Withdrawn } from './move.ts';
export { leadingZeroBits, POW_CHALLENGE_HEADER, POW_HEADER, solvePow } from './pow.ts';
export type { VerifiedBellows, VerifyOptions } from './verify.ts';
