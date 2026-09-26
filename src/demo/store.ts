import { createHash, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { z, type ZodTypeAny } from 'zod';
import { logger } from '../lib/logger.js';
import { communityGovManifestDigest } from '../feed/demo-snapshot-source.js';
import approvedManifestJson from './community-gov-release-snapshot.json' with { type: 'json' };
import { DEMO_VISIBILITY_POLICY_VERSION } from './public-view.js';
import {
  SHADOW_DEMO_COMMUNITY_IDS,
  SHADOW_DEMO_V4_CONTRACT_VERSION,
  SHADOW_DEMO_MAX_EXCLUDE_KEYWORDS,
  SHADOW_DEMO_MAX_EXCLUDE_KEYWORD_LENGTH,
  SHADOW_DEMO_TOTAL_DEMO_VOTERS,
  SHADOW_DEMO_PHASES,
  SHADOW_DEMO_SIGNAL_KEYS,
  SHADOW_DEMO_TOPIC_KEYS,
  SHADOW_DEMO_VOTER_BLOC_IDS,
  type ShadowDemoCommunityId,
  type ShadowDemoCorpus,
  type ShadowDemoSessionState,
} from './types.js';

const StoredWarningSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  severity: z.enum(['info', 'warning', 'degraded']),
});

const StoredWeightsSchema = z.object(
  Object.fromEntries(SHADOW_DEMO_SIGNAL_KEYS.map((key) => [key, z.number().finite()])) as Record<
    (typeof SHADOW_DEMO_SIGNAL_KEYS)[number],
    z.ZodNumber
  >
);

const StoredTopicIntentSchema = z.object({
  topicWeights: z.record(z.number().finite()),
});

const StoredHttpsUrlSchema = z.string().url().refine((value) => new URL(value).protocol === 'https:');

const StoredPostMediaSchema = z.object({
  images: z.array(z.object({
    thumb: StoredHttpsUrlSchema,
    fullsize: StoredHttpsUrlSchema,
    alt: z.string(),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
  })),
  external: z.object({
    uri: StoredHttpsUrlSchema,
    title: z.string(),
    description: z.string(),
    thumb: StoredHttpsUrlSchema.nullable(),
  }).nullable(),
  quote: z.object({
    uri: z.string().startsWith('at://'),
    authorHandle: z.string().min(1),
    authorDisplayName: z.string().min(1),
    text: z.string().min(1),
  }).nullable(),
  video: z.object({
    thumbnail: StoredHttpsUrlSchema.nullable(),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
  }).nullable(),
});

const StoredDisplayPostSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('public_post'),
    uri: z.string().min(1),
    cid: z.string().min(1),
    authorDid: z.string().min(1),
    authorHandle: z.string().min(1),
    authorDisplayName: z.string().min(1),
    authorAvatar: StoredHttpsUrlSchema.nullable(),
    text: z.string().min(1),
    likeCount: z.number().int().nonnegative(),
    repostCount: z.number().int().nonnegative(),
    replyCount: z.number().int().nonnegative(),
    quoteCount: z.number().int().nonnegative(),
    indexedAt: z.string().min(1),
    createdAt: z.string().min(1),
    bskyUrl: StoredHttpsUrlSchema,
    languages: z.array(z.string().min(1)).optional(),
    media: StoredPostMediaSchema.nullable().optional(),
  }),
  z.object({
    kind: z.literal('hidden_post'),
    reason: z.string().min(1),
  }),
]);

const StoredCorpusItemSchema = z.object({
  postUri: z.string().min(1),
  reviewedCid: z.string().trim().min(1).nullable().optional(),
  authorDid: z.string().min(1).nullable(),
  createdAt: z.string().min(1),
  topicVector: z.record(z.number().finite()),
  rawScores: StoredWeightsSchema,
  productionScore: z.number().finite(),
  productionEpochId: z.number().int(),
  scoredAt: z.string().min(1),
  componentDetails: z.record(z.unknown()).nullable(),
  inclusionReasons: z.object({
    matchedTopics: z.array(z.object({
      topic: z.enum(SHADOW_DEMO_TOPIC_KEYS),
      score: z.number().finite(),
    })),
    matchedTerms: z.array(z.string().min(1).max(64)),
    sourceRank: z.number().int().positive().optional(),
    reason: z.literal('published_feed_snapshot').optional(),
  }),
  displayPost: StoredDisplayPostSchema,
  publishedRank: z.number().int().positive().optional(),
  publishedScore: z.number().finite().nonnegative().optional(),
  publicationAdjustment: z.number().finite().nonnegative().optional(),
  embedUrl: StoredHttpsUrlSchema.nullable().optional(),
  textLength: z.number().int().nonnegative().optional(),
});

const StoredCorpusHealthSchema = z.object({
  status: z.enum(['live', 'degraded']),
  source: z.enum(['production_scores_appview', 'production_feed_snapshot', 'fixture_fallback']),
  candidatePosts72h: z.number().int().nonnegative(),
  publicScoredPosts: z.number().int().nonnegative(),
  uniqueAuthors72h: z.number().int().nonnegative(),
  bridgePostShare: z.number().finite().min(0).max(1),
  topAuthorConcentration: z.number().finite().min(0).max(1),
  sampledAt: z.string().min(1),
  sourcePostCount: z.number().int().nonnegative().optional(),
  eligiblePostCount: z.number().int().nonnegative().optional(),
  englishTaggedShare: z.number().finite().min(0).max(1).optional(),
  richMediaShare: z.number().finite().min(0).max(1).optional(),
});

const StoredTopicCatalogEntrySchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable(),
  baselineWeight: z.number().min(0).max(1),
});

const StoredCorpusSchema = z.object({
  corpusId: z.string().min(1),
  communityId: z.enum(SHADOW_DEMO_COMMUNITY_IDS),
  baseProductionEpochId: z.number().int(),
  baseWeights: StoredWeightsSchema,
  baseTopicIntent: StoredTopicIntentSchema,
  createdAt: z.string().min(1),
  expiresAt: z.string().min(1),
  items: z.array(StoredCorpusItemSchema),
  health: StoredCorpusHealthSchema,
  warnings: z.array(StoredWarningSchema),
  topicCatalog: z.array(StoredTopicCatalogEntrySchema).optional(),
  sourceFeedUri: z.string().startsWith('at://').optional(),
  sourceSnapshot: z.object({
    feedName: z.string().min(1),
    digest: z.string().min(1),
    runId: z.string().min(1),
    updatedAt: z.string().min(1),
    capturedAt: z.string().min(1),
    reviewedAt: z.string().nullable(),
    sourcePostCount: z.number().int().positive(),
    selectionPolicyVersion: z.string().min(1),
    baselineOrderDigest: z.string().min(1),
    publicationPolicy: z.object({
      urlDedupEnabled: z.boolean(),
      minimumOriginalTextLength: z.number().finite().nonnegative(),
      minimumRelevance: z.number().finite().min(0).max(1),
      decay: z.array(z.number().finite().positive().max(1)).min(1),
    }).strict(),
  }).optional(),
});

// Distinct proposed keywords per epoch = reviewer (<= MAX) plus prior-adopted
// (itself capped at MAX), so support entries stay well under this ceiling.
const STORED_CONTENT_RULE_SUPPORT_MAX = SHADOW_DEMO_MAX_EXCLUDE_KEYWORDS * SHADOW_DEMO_TOTAL_DEMO_VOTERS;

const StoredContentRulesSummarySchema = z.object({
  enabled: z.literal(true),
  threshold: z.number().int().positive(),
  electorate: z.number().int().nonnegative(),
  adoptedExcludeKeywords: z.array(z.string().min(1).max(SHADOW_DEMO_MAX_EXCLUDE_KEYWORD_LENGTH)).max(SHADOW_DEMO_MAX_EXCLUDE_KEYWORDS),
  support: z.array(z.object({
    keyword: z.string().min(1).max(SHADOW_DEMO_MAX_EXCLUDE_KEYWORD_LENGTH),
    supportCount: z.number().int().nonnegative(),
    adopted: z.boolean(),
  })).max(STORED_CONTENT_RULE_SUPPORT_MAX),
});

const StoredVoteSummarySchema = z.object({
  aggregateMethod: z.literal('trimmed_mean_no_trim_under_10'),
  voteCount: z.number().int().nonnegative(),
  trimCount: z.number().int().nonnegative(),
  weights: StoredWeightsSchema,
  topicIntent: StoredTopicIntentSchema,
  contentRules: StoredContentRulesSummarySchema.optional(),
});

const StoredEpochSchema = z.object({
  id: z.string().min(1),
  sequence: z.number().int().positive(),
  label: z.string().min(1),
  status: z.enum(['open', 'advanced']),
  createdAt: z.string().min(1),
  advancedAt: z.string().min(1).nullable(),
  decidedByEpochId: z.string().min(1).nullable(),
  aggregate: StoredVoteSummarySchema,
});

const StoredVoteBaseSchema = z.object({
  id: z.string().min(1),
  epochId: z.string().min(1),
  label: z.string().min(1),
  weights: StoredWeightsSchema,
  topicIntent: StoredTopicIntentSchema,
  excludeKeywords: z.array(z.string().min(1).max(SHADOW_DEMO_MAX_EXCLUDE_KEYWORD_LENGTH)).max(SHADOW_DEMO_MAX_EXCLUDE_KEYWORDS).optional(),
  createdAt: z.string().min(1),
});

const StoredVoteSchema = z.discriminatedUnion('actorType', [
  StoredVoteBaseSchema.extend({
    actorType: z.literal('reviewer'),
    actorId: z.literal('reviewer'),
  }),
  StoredVoteBaseSchema.extend({
    actorType: z.literal('synthetic_voter'),
    actorId: z.string().regex(/^synthetic-[a-z_]+-\d+$/),
    blocId: z.enum(SHADOW_DEMO_VOTER_BLOC_IDS),
  }),
]);

const StoredSessionHeaderSchema = z.object({
  sessionId: z.string().min(1),
  communityId: z.enum(SHADOW_DEMO_COMMUNITY_IDS),
  seed: z.string().min(1),
  phase: z.enum(SHADOW_DEMO_PHASES),
  createdAt: z.string().min(1),
  expiresAt: z.string().min(1),
  corpusId: z.string().min(1),
  currentEpochId: z.string().min(1),
  epochs: z.array(StoredEpochSchema),
  votes: z.array(StoredVoteSchema),
  warnings: z.array(StoredWarningSchema),
});

const StoredIdempotencySchema = z.object({
  requestHash: z.string().min(1),
  response: z.unknown(),
  createdAt: z.string().min(1),
}).passthrough();

export class DemoStoreCorruptionError extends Error {
  constructor(key: string, detail: string) {
    super(`Invalid shadow demo Redis record at ${key}: ${detail}`);
    this.name = 'DemoStoreCorruptionError';
  }
}

export class DemoStoreUnavailableError extends Error {
  constructor(operation: string, detail: string) {
    super(`Shadow demo storage unavailable during ${operation}: ${detail}`);
    this.name = 'DemoStoreUnavailableError';
  }
}

export class DemoStoreCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DemoStoreCapacityError';
  }
}

export const DEMO_MAX_SESSION_BYTES = 1024 * 1024;
export const DEMO_MAX_IDEMPOTENCY_BYTES = 256 * 1024;
export const DEMO_MAX_ACTIVE_SESSIONS = 50;
const DEMO_STAGING_TTL_SECONDS = 30;

export interface IdempotencyRecord<TPayload> {
  requestHash: string;
  response: TPayload;
  createdAt: string;
}

export interface DemoSessionMutation<TPayload> {
  session: ShadowDemoSessionState;
  ttlSeconds: number;
  lockToken: string;
  idempotencyKey: string | null;
  idempotencyRecord: IdempotencyRecord<TPayload> | null;
}

export interface DemoStore {
  readSession(sessionId: string): Promise<ShadowDemoSessionState | null>;
  readSessionIdByClientNonce(clientNonce: string): Promise<string | null>;
  createSession(
    session: ShadowDemoSessionState,
    ttlSeconds: number,
    maxActiveSessions: number,
    clientNonce: string
  ): Promise<boolean>;
  commitSessionMutation<TPayload>(mutation: DemoSessionMutation<TPayload>): Promise<boolean>;
  readIdempotency<TPayload>(sessionId: string, key: string): Promise<IdempotencyRecord<TPayload> | null>;
  readSharedCorpus(communityId: ShadowDemoCommunityId): Promise<ShadowDemoCorpus | null>;
  writeSharedCorpus(communityId: ShadowDemoCommunityId, corpus: ShadowDemoCorpus, ttlSeconds: number): Promise<void>;
  commitSharedCorpus(communityId: ShadowDemoCommunityId, token: string, corpus: ShadowDemoCorpus, ttlSeconds: number): Promise<boolean>;
  acquireCorpusBuildLock(communityId: ShadowDemoCommunityId, token: string, ttlMs: number): Promise<boolean>;
  renewCorpusBuildLock(communityId: ShadowDemoCommunityId, token: string, ttlMs: number): Promise<boolean>;
  releaseCorpusBuildLock(communityId: ShadowDemoCommunityId, token: string): Promise<void>;
  acquireSessionLock(sessionId: string, token: string, ttlMs: number): Promise<boolean>;
  releaseSessionLock(sessionId: string, token: string): Promise<void>;
}

export class RedisDemoStore implements DemoStore {
  private readonly redis: Redis;
  private connectionPromise: Promise<void> | null = null;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  async readSession(sessionId: string): Promise<ShadowDemoSessionState | null> {
    const key = sessionKey(sessionId);
    const raw = await this.runRedisCommand('read session header', () => this.redis.get(key));
    if (!raw) {
      return null;
    }
    const header = parseStoredRecord<Omit<ShadowDemoSessionState, 'corpus'>>(
      StoredSessionHeaderSchema,
      raw,
      key
    );
    const storedCorpusKey = corpusKey(header.corpusId);
    const rawCorpus = await this.runRedisCommand('read session corpus', () => this.redis.get(storedCorpusKey));
    if (!rawCorpus) {
      throw new DemoStoreCorruptionError(
        key,
        `referenced corpus ${header.corpusId} is missing at ${storedCorpusKey}`
      );
    }
    const corpus = parseStoredRecord<ShadowDemoCorpus>(StoredCorpusSchema, rawCorpus, storedCorpusKey);
    return { ...header, corpus };
  }

  async readSessionIdByClientNonce(clientNonce: string): Promise<string | null> {
    return this.runRedisCommand('read session creation nonce', () =>
      this.redis.get(sessionNonceKey(clientNonce))
    );
  }

  async createSession(
    session: ShadowDemoSessionState,
    ttlSeconds: number,
    maxActiveSessions: number,
    clientNonce: string
  ): Promise<boolean> {
    const serialized = serializeSession(session);
    const reserved = await this.reserveSessionSlot(session, maxActiveSessions);
    if (!reserved) {
      return false;
    }
    const stagingToken = randomUUID();
    const stagedHeaderKey = stagingKey(stagingToken, 'session');
    const stagedCorpusKey = stagingKey(stagingToken, 'corpus');
    let result: unknown;
    try {
      await this.stageRecords([
        { key: stagedHeaderKey, value: serialized.header },
        { key: stagedCorpusKey, value: serialized.corpus },
      ]);
      result = await this.runRedisCommand('create bounded session', () => this.redis.eval(
        `if redis.call('exists', KEYS[6]) == 1 then return 2 end
         if redis.call('zscore', KEYS[5], ARGV[2]) == false then return -1 end
         if redis.call('exists', KEYS[1]) == 0 or redis.call('exists', KEYS[2]) == 0 then return -1 end
         redis.call('rename', KEYS[1], KEYS[3])
         redis.call('rename', KEYS[2], KEYS[4])
         redis.call('expire', KEYS[3], ARGV[1])
         redis.call('expire', KEYS[4], ARGV[1])
         redis.call('setex', KEYS[6], ARGV[1], ARGV[2])
         return 1`,
        6,
        stagedHeaderKey,
        stagedCorpusKey,
        sessionKey(session.sessionId),
        corpusKey(session.corpusId),
        activeSessionsKey(),
        sessionNonceKey(clientNonce),
        ttlSeconds,
        session.sessionId
      ));
    } catch (err) {
      await this.discardStaging([stagedHeaderKey, stagedCorpusKey]);
      await this.discardSessionReservation(session.sessionId);
      throw err;
    }
    if (result !== 1) {
      await this.discardStaging([stagedHeaderKey, stagedCorpusKey]);
      await this.discardSessionReservation(session.sessionId);
    }
    if (result === -1) {
      throw new DemoStoreUnavailableError('create bounded session', 'staged session records expired before commit');
    }
    return result === 1;
  }

  async commitSessionMutation<TPayload>(mutation: DemoSessionMutation<TPayload>): Promise<boolean> {
    const serialized = serializeSession(mutation.session);
    const idempotency = serializeIdempotency(mutation.idempotencyRecord);
    const stagingToken = randomUUID();
    const stagedHeaderKey = stagingKey(stagingToken, 'session');
    const stagedIdempotencyKey = stagingKey(stagingToken, 'idempotency');
    const authoritativeIdempotencyKey = mutation.idempotencyKey
      ? idempotencyKey(mutation.session.sessionId, mutation.idempotencyKey)
      : idempotencyPlaceholderKey(mutation.session.sessionId);
    const stageIdempotency = Boolean(mutation.idempotencyKey && idempotency);
    const stagedRecords = [{ key: stagedHeaderKey, value: serialized.header }];
    if (stageIdempotency && idempotency) {
      stagedRecords.push({ key: stagedIdempotencyKey, value: idempotency });
    }
    await this.stageRecords(stagedRecords);
    let result: unknown;
    try {
      result = await this.runRedisCommand('commit session mutation', () => this.redis.eval(
      `if redis.call('get', KEYS[1]) ~= ARGV[1] then return 0 end
       if redis.call('exists', KEYS[2]) == 0 or redis.call('exists', KEYS[6]) == 0 then return -1 end
       if ARGV[3] == '1' and redis.call('exists', KEYS[4]) == 0 then return -1 end
       redis.call('rename', KEYS[2], KEYS[3])
       redis.call('expire', KEYS[3], ARGV[2])
       redis.call('expire', KEYS[6], ARGV[2])
       if ARGV[3] == '1' then
         redis.call('rename', KEYS[4], KEYS[5])
         redis.call('expire', KEYS[5], ARGV[2])
       end
       return 1`,
      6,
      lockKey(mutation.session.sessionId),
      stagedHeaderKey,
      sessionKey(mutation.session.sessionId),
      stagedIdempotencyKey,
      authoritativeIdempotencyKey,
      corpusKey(mutation.session.corpusId),
      mutation.lockToken,
      mutation.ttlSeconds,
        stageIdempotency ? '1' : '0'
      ));
    } catch (err) {
      await this.discardStaging(stagedRecords.map((record) => record.key));
      throw err;
    }
    if (result !== 1) {
      await this.discardStaging(stagedRecords.map((record) => record.key));
    }
    if (result === -1) {
      throw new DemoStoreUnavailableError('commit session mutation', 'staged mutation records expired before commit');
    }
    return result === 1;
  }

  async readIdempotency<TPayload>(sessionId: string, key: string): Promise<IdempotencyRecord<TPayload> | null> {
    const redisKey = idempotencyKey(sessionId, key);
    const raw = await this.runRedisCommand('read idempotency record', () => this.redis.get(redisKey));
    return raw
      ? parseStoredRecord<IdempotencyRecord<TPayload>>(StoredIdempotencySchema, raw, redisKey)
      : null;
  }

  async readSharedCorpus(communityId: ShadowDemoCommunityId): Promise<ShadowDemoCorpus | null> {
    const key = sharedCorpusKey(communityId);
    const raw = await this.runRedisCommand('read shared corpus', () => this.redis.get(key));
    return raw ? parseStoredRecord<ShadowDemoCorpus>(StoredCorpusSchema, raw, key) : null;
  }

  async writeSharedCorpus(
    communityId: ShadowDemoCommunityId,
    corpus: ShadowDemoCorpus,
    ttlSeconds: number
  ): Promise<void> {
    await this.runRedisCommand('write shared corpus', () =>
      this.redis.setex(sharedCorpusKey(communityId), ttlSeconds, JSON.stringify(corpus))
    );
  }

  async commitSharedCorpus(
    communityId: ShadowDemoCommunityId,
    token: string,
    corpus: ShadowDemoCorpus,
    ttlSeconds: number
  ): Promise<boolean> {
    const committed = await this.runRedisCommand('commit shared corpus', () => this.redis.eval(
      "if redis.call('get', KEYS[1]) ~= ARGV[1] then return 0 end; redis.call('setex', KEYS[2], ARGV[2], ARGV[3]); return 1",
      2,
      corpusBuildLockKey(communityId),
      sharedCorpusKey(communityId),
      token,
      ttlSeconds,
      JSON.stringify(corpus)
    ));
    return committed === 1;
  }

  async acquireCorpusBuildLock(communityId: ShadowDemoCommunityId, token: string, ttlMs: number): Promise<boolean> {
    const result = await this.runRedisCommand('acquire corpus build lock', () =>
      this.redis.set(corpusBuildLockKey(communityId), token, 'PX', ttlMs, 'NX')
    );
    return result === 'OK';
  }

  async renewCorpusBuildLock(
    communityId: ShadowDemoCommunityId,
    token: string,
    ttlMs: number
  ): Promise<boolean> {
    const renewed = await this.runRedisCommand('renew corpus build lock', () => this.redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
      1,
      corpusBuildLockKey(communityId),
      token,
      ttlMs
    ));
    return renewed === 1;
  }

  async releaseCorpusBuildLock(communityId: ShadowDemoCommunityId, token: string): Promise<void> {
    await this.runRedisCommand('release corpus build lock', () => this.redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      corpusBuildLockKey(communityId),
      token
    ));
  }

  async acquireSessionLock(sessionId: string, token: string, ttlMs: number): Promise<boolean> {
    const result = await this.runRedisCommand('acquire session lock', () =>
      this.redis.set(lockKey(sessionId), token, 'PX', ttlMs, 'NX')
    );
    return result === 'OK';
  }

  async releaseSessionLock(sessionId: string, token: string): Promise<void> {
    await this.runRedisCommand('release session lock', () => this.redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      lockKey(sessionId),
      token
    ));
  }

  private async runRedisCommand<TValue>(operation: string, command: () => Promise<TValue>): Promise<TValue> {
    try {
      await this.connectIfNeeded();
      return await command();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new DemoStoreUnavailableError(operation, detail);
    }
  }

  private async connectIfNeeded(): Promise<void> {
    if (this.connectionPromise) {
      await this.connectionPromise;
      return;
    }
    if (this.redis.status !== 'wait') {
      return;
    }
    this.connectionPromise = this.redis.connect().finally(() => {
      this.connectionPromise = null;
    });
    await this.connectionPromise;
  }

  private async stageRecords(records: Array<{ key: string; value: string }>): Promise<void> {
    const staged: string[] = [];
    try {
      for (const record of records) {
        await this.runRedisCommand('stage session mutation', () =>
          this.redis.setex(record.key, DEMO_STAGING_TTL_SECONDS, record.value)
        );
        staged.push(record.key);
      }
    } catch (err) {
      await this.discardStaging(staged);
      throw err;
    }
  }

  private async reserveSessionSlot(
    session: ShadowDemoSessionState,
    maxActiveSessions: number
  ): Promise<boolean> {
    const result = await this.runRedisCommand('reserve active session slot', () => this.redis.eval(
      `redis.call('zremrangebyscore', KEYS[1], '-inf', ARGV[1])
       if redis.call('zcard', KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
       redis.call('zadd', KEYS[1], ARGV[3], ARGV[4])
       return 1`,
      1,
      activeSessionsKey(),
      Date.now(),
      maxActiveSessions,
      new Date(session.expiresAt).getTime(),
      session.sessionId
    ));
    return result === 1;
  }

  private async discardSessionReservation(sessionId: string): Promise<void> {
    try {
      await this.redis.zrem(activeSessionsKey(), sessionId);
    } catch (err) {
      logger.warn({ err, sessionId }, 'Failed to remove shadow demo session reservation');
    }
  }

  private async discardStaging(keys: string[]): Promise<void> {
    if (keys.length === 0) {
      return;
    }
    try {
      await this.redis.del(...keys);
    } catch (err) {
      logger.warn({ err, keyCount: keys.length }, 'Failed to remove short-lived shadow demo staging keys');
    }
  }
}

export class MemoryDemoStore implements DemoStore {
  private readonly sessions = new Map<string, ShadowDemoSessionState>();
  private readonly sessionIdsByClientNonce = new Map<string, string>();
  private readonly idempotency = new Map<string, IdempotencyRecord<unknown>>();
  private readonly sharedCorpus = new Map<string, ShadowDemoCorpus>();
  private readonly locks = new Map<string, string>();

  async readSession(sessionId: string): Promise<ShadowDemoSessionState | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async readSessionIdByClientNonce(clientNonce: string): Promise<string | null> {
    return this.sessionIdsByClientNonce.get(clientNonce) ?? null;
  }

  async createSession(
    session: ShadowDemoSessionState,
    _ttlSeconds: number,
    maxActiveSessions: number,
    clientNonce: string
  ): Promise<boolean> {
    const now = new Date(session.createdAt).getTime();
    for (const [sessionId, candidate] of this.sessions.entries()) {
      if (new Date(candidate.expiresAt).getTime() <= now) {
        this.sessions.delete(sessionId);
        for (const [nonce, mappedSessionId] of this.sessionIdsByClientNonce.entries()) {
          if (mappedSessionId === sessionId) {
            this.sessionIdsByClientNonce.delete(nonce);
          }
        }
      }
    }
    if (this.sessionIdsByClientNonce.has(clientNonce)) {
      return false;
    }
    if (this.sessions.size >= maxActiveSessions) {
      return false;
    }
    serializeSession(session);
    this.sessions.set(session.sessionId, JSON.parse(JSON.stringify(session)) as ShadowDemoSessionState);
    this.sessionIdsByClientNonce.set(clientNonce, session.sessionId);
    return true;
  }

  async commitSessionMutation<TPayload>(mutation: DemoSessionMutation<TPayload>): Promise<boolean> {
    if (this.locks.get(lockKey(mutation.session.sessionId)) !== mutation.lockToken) {
      return false;
    }
    serializeSession(mutation.session);
    serializeIdempotency(mutation.idempotencyRecord);
    this.sessions.set(
      mutation.session.sessionId,
      JSON.parse(JSON.stringify(mutation.session)) as ShadowDemoSessionState
    );
    if (mutation.idempotencyKey && mutation.idempotencyRecord) {
      this.idempotency.set(
        idempotencyKey(mutation.session.sessionId, mutation.idempotencyKey),
        JSON.parse(JSON.stringify(mutation.idempotencyRecord)) as IdempotencyRecord<unknown>
      );
    }
    return true;
  }

  async readIdempotency<TPayload>(sessionId: string, key: string): Promise<IdempotencyRecord<TPayload> | null> {
    return (this.idempotency.get(idempotencyKey(sessionId, key)) as IdempotencyRecord<TPayload> | undefined) ?? null;
  }

  async readSharedCorpus(communityId: ShadowDemoCommunityId): Promise<ShadowDemoCorpus | null> {
    return this.sharedCorpus.get(sharedCorpusKey(communityId)) ?? null;
  }

  async writeSharedCorpus(
    communityId: ShadowDemoCommunityId,
    corpus: ShadowDemoCorpus,
    _ttlSeconds: number
  ): Promise<void> {
    this.sharedCorpus.set(sharedCorpusKey(communityId), JSON.parse(JSON.stringify(corpus)) as ShadowDemoCorpus);
  }

  async commitSharedCorpus(
    communityId: ShadowDemoCommunityId,
    token: string,
    corpus: ShadowDemoCorpus,
    _ttlSeconds: number
  ): Promise<boolean> {
    if (this.locks.get(corpusBuildLockKey(communityId)) !== token) return false;
    // No await between ownership comparison and publication.
    this.sharedCorpus.set(sharedCorpusKey(communityId), JSON.parse(JSON.stringify(corpus)) as ShadowDemoCorpus);
    return true;
  }

  async acquireCorpusBuildLock(communityId: ShadowDemoCommunityId, token: string, _ttlMs: number): Promise<boolean> {
    const key = corpusBuildLockKey(communityId);
    if (this.locks.has(key)) {
      return false;
    }
    this.locks.set(key, token);
    return true;
  }

  async renewCorpusBuildLock(
    communityId: ShadowDemoCommunityId,
    token: string,
    _ttlMs: number
  ): Promise<boolean> {
    return this.locks.get(corpusBuildLockKey(communityId)) === token;
  }

  async releaseCorpusBuildLock(communityId: ShadowDemoCommunityId, token: string): Promise<void> {
    const key = corpusBuildLockKey(communityId);
    if (this.locks.get(key) === token) {
      this.locks.delete(key);
    }
  }

  async acquireSessionLock(sessionId: string, token: string, _ttlMs: number): Promise<boolean> {
    const key = lockKey(sessionId);
    if (this.locks.has(key)) {
      return false;
    }
    this.locks.set(key, token);
    return true;
  }

  async releaseSessionLock(sessionId: string, token: string): Promise<void> {
    const key = lockKey(sessionId);
    if (this.locks.get(key) === token) {
      this.locks.delete(key);
    }
  }
}

export function createRedisDemoStore(): DemoStore {
  const redis = new Redis(redisUrlFromEnv(), {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: redisCommandTimeoutFromEnv(),
    retryStrategy(times: number) {
      return Math.min(times * 50, 2000);
    },
  });
  redis.on('error', (err: Error) => {
    logger.error({ err }, 'Shadow demo Redis connection error');
  });
  return new RedisDemoStore(redis);
}

function parseStoredRecord<TRecord>(schema: ZodTypeAny, raw: string, key: string): TRecord {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new DemoStoreCorruptionError(key, `malformed JSON (${detail})`);
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new DemoStoreCorruptionError(
      key,
      result.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ')
    );
  }
  return result.data as TRecord;
}

function redisUrlFromEnv(): string {
  const redisUrl = process.env.DEMO_REDIS_URL ?? 'redis://127.0.0.1:6381';
  if (!redisUrl || !redisUrl.startsWith('redis://')) {
    throw new Error('Shadow demo Redis store requires DEMO_REDIS_URL with redis:// scheme');
  }
  return redisUrl;
}

function serializeSession(session: ShadowDemoSessionState): { header: string; corpus: string } {
  const full = JSON.stringify(session);
  assertSerializedSize('session state', full, DEMO_MAX_SESSION_BYTES);
  const { corpus, ...header } = session;
  return { header: JSON.stringify(header), corpus: JSON.stringify(corpus) };
}

function serializeIdempotency<TPayload>(record: IdempotencyRecord<TPayload> | null): string | null {
  if (!record) {
    return null;
  }
  const serialized = JSON.stringify(record);
  assertSerializedSize('idempotency record', serialized, DEMO_MAX_IDEMPOTENCY_BYTES);
  return serialized;
}

function assertSerializedSize(label: string, serialized: string, maximumBytes: number): void {
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > maximumBytes) {
    throw new DemoStoreCapacityError(
      `Shadow demo ${label} exceeds ${maximumBytes} bytes; received ${bytes} bytes`
    );
  }
}

function redisCommandTimeoutFromEnv(): number {
  const raw = process.env.REDIS_COMMAND_TIMEOUT_MS;
  if (!raw) {
    return 5000;
  }
  const timeoutMs = Number(raw);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100) {
    throw new Error(`Shadow demo Redis store requires REDIS_COMMAND_TIMEOUT_MS >= 100; received ${raw}`);
  }
  return timeoutMs;
}

export function demoSessionKeyPrefix(): string {
  return 'demo:session:';
}

export function demoSessionNonceKeyPrefix(): string {
  return 'demo:session-nonce:';
}

export function demoCorpusKeyPrefix(): string {
  return 'demo:corpus:';
}

export function demoIdempotencyKeyPrefix(): string {
  return 'demo:idempotency:';
}

export function demoLockKeyPrefix(): string {
  return 'demo:lock:';
}

export function demoSharedCorpusKeyPrefix(): string {
  return 'demo:corpus:current:v4:';
}

export function demoStagingKeyPrefix(): string {
  return 'demo:staging:';
}

function sessionKey(sessionId: string): string {
  return `${demoSessionKeyPrefix()}${sessionId}`;
}

function sessionNonceKey(clientNonce: string): string {
  return `${demoSessionNonceKeyPrefix()}${clientNonce}`;
}

function corpusKey(corpusId: string): string {
  return `${demoCorpusKeyPrefix()}${corpusId}`;
}

function sharedCorpusKey(communityId: ShadowDemoCommunityId): string {
  return `${demoSharedCorpusKeyPrefix()}${communityId}:${demoSharedCorpusIdentity(
    communityId,
    communityGovManifestDigest(approvedManifestJson),
    DEMO_VISIBILITY_POLICY_VERSION
  )}`;
}

function idempotencyKey(sessionId: string, key: string): string {
  return `${demoIdempotencyKeyPrefix()}${sessionId}:${key}`;
}

function idempotencyPlaceholderKey(sessionId: string): string {
  return `${demoIdempotencyKeyPrefix()}${sessionId}:none`;
}

function activeSessionsKey(): string {
  return 'demo:sessions:active';
}

function stagingKey(token: string, kind: 'session' | 'corpus' | 'idempotency'): string {
  return `${demoStagingKeyPrefix()}${token}:${kind}`;
}

function lockKey(sessionId: string): string {
  return `${demoLockKeyPrefix()}${sessionId}`;
}

function corpusBuildLockKey(communityId: ShadowDemoCommunityId): string {
  return `${demoLockKeyPrefix()}corpus:${sharedCorpusKey(communityId)}`;
}

export function demoSharedCorpusIdentity(
  communityId: ShadowDemoCommunityId,
  approvedManifestDigest: string,
  visibilityPolicyVersion: string
): string {
  return createHash('sha256').update(JSON.stringify([
    SHADOW_DEMO_V4_CONTRACT_VERSION,
    communityId,
    communityId === 'community_gov' ? approvedManifestDigest : null,
    visibilityPolicyVersion,
  ])).digest('hex');
}
