/**
 * Real-datastore coverage for publication-bound transparency snapshots.
 *
 * This file intentionally uses the isolated simulation harness config. It
 * exercises the production PostgreSQL scoring/publication path and the real
 * Redis Lua readers without adding Docker to the default unit-test suite.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runHttpLoad } from '../../scripts/http-load.js';
import { runScenario } from '../../src/harness/index.js';
import { db } from '../../src/db/client.js';
import { redis } from '../../src/db/redis.js';
import {
  clearCurrentFeedSnapshotMemoryCache,
  getCurrentFeedSnapshot,
} from '../../src/feed/snapshot-cache.js';
import { __resetPipelineState, runScoringPipeline } from '../../src/scoring/pipeline.js';
import {
  readPublishedPostSnapshotReceipt,
  readTransparencyFeedSnapshot,
} from '../../src/transparency/feed-snapshot-store.js';
import { registerFeedSnapshotRoute } from '../../src/transparency/routes/feed-snapshot.js';
import type {
  TransparencyFeedRankedItem,
  TransparencyFeedSnapshot,
} from '../../src/transparency/transparency.types.js';
import { buildSimulationDeps, resetHarnessData } from './helpers.js';

const PUBLIC_SNAPSHOT_LIMIT = 50;
const PUBLISHED_ARTIFACT_KEYS = [
  'feed:current',
  'feed:last_known_good',
  'feed:order',
  'feed:last_known_good_order',
  'feed:explanations',
  'feed:last_known_good_explanations',
  'feed:explanation_seals',
  'feed:last_known_good_explanation_seals',
  'feed:epoch',
  'feed:run_id',
  'feed:updated_at',
  'feed:count',
  'feed:explanation_schema_version',
  'feed:snapshot_digest',
  'feed:weights',
  'feed:last_known_good_epoch',
  'feed:last_known_good_run_id',
  'feed:last_known_good_updated_at',
  'feed:last_known_good_count',
  'feed:last_known_good_explanation_schema_version',
  'feed:last_known_good_snapshot_digest',
  'feed:last_known_good_weights',
  'feed:publication_integrity_seal',
  'feed:last_known_good_publication_integrity_seal',
  'feed:current_snapshot_generation',
  'feed:current_snapshot_id',
] as const;

interface RedisEvalSurface {
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

function expectRankedItem(item: TransparencyFeedSnapshot['items'][number]): TransparencyFeedRankedItem {
  if (item.placement !== 'ranked') {
    throw new TypeError(`Expected ranked transparency item, received ${item.placement}`);
  }
  return item;
}

async function publishSyntheticFeed(seed: number, postCount: number): Promise<TransparencyFeedSnapshot> {
  const { metrics } = await runScenario(
    {
      kind: 'epoch-vote-cycle',
      version: 1,
      seed,
      population: {
        subscriberCount: 12,
        postCount,
        voteParticipationRate: 1,
        contentVoteRate: 0,
        castsWeightVoteRate: 1,
        castsTopicVoteRate: 1,
      },
    },
    { deps: buildSimulationDeps(seed) }
  );

  const storedScores = await db.query<{ score_count: string }>(
    `SELECT COUNT(*)::text AS score_count
       FROM post_scores
      WHERE epoch_id = $1`,
    [metrics.scoring.epochId]
  );
  expect(Number(storedScores.rows[0].score_count)).toBe(postCount);

  const snapshot = await readTransparencyFeedSnapshot(PUBLIC_SNAPSHOT_LIMIT);
  if (snapshot === null) {
    throw new Error('Expected scoring pipeline to publish a complete transparency snapshot');
  }
  return snapshot;
}

async function buildSnapshotHttpApp(rateLimitNamespace: string): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: true });
  await app.register(fastifyRateLimit, {
    global: false,
    redis,
    nameSpace: rateLimitNamespace,
  });
  registerFeedSnapshotRoute(app);
  await app.listen({ host: '127.0.0.1', port: 0 });
  return app;
}

async function clearRateLimitNamespace(rateLimitNamespace: string): Promise<void> {
  const keys = await redis.keys(`${rateLimitNamespace}*`);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}

async function insertIncrementalPost(postUri: string): Promise<void> {
  const author = await db.query<{ did: string }>('SELECT did FROM subscribers ORDER BY did LIMIT 1');
  if (author.rows[0] === undefined) {
    throw new Error('Expected a seeded subscriber to author the incremental post');
  }
  const createdAt = new Date().toISOString();
  await db.query(
    `INSERT INTO posts (
       uri, cid, author_did, text, created_at, has_media, embed_url,
       topic_vector, classification_method
     ) VALUES ($1, $2, $3, $4, $5, FALSE, NULL, $6, 'keyword')`,
    [
      postUri,
      `cid-${postUri.split('/').at(-1) ?? 'incremental'}`,
      author.rows[0].did,
      'Software, science, sports, music, and politics community update',
      createdAt,
      JSON.stringify({
        'software-development': 1,
        science: 1,
        sports: 1,
        music: 1,
        politics: 1,
      }),
    ]
  );
  await db.query(
    `INSERT INTO post_engagement (post_uri, like_count, repost_count, reply_count)
     VALUES ($1, 30, 10, 5)`,
    [postUri]
  );
}

async function capturePublishedArtifacts(): Promise<Record<string, string | null>> {
  const result: Record<string, string | null> = {};
  for (const key of PUBLISHED_ARTIFACT_KEYS) {
    const bytes = await redis.dump(key);
    result[key] = bytes === null ? null : bytes.toString('base64');
  }
  return result;
}

describe('Transparency publication: real PostgreSQL and Redis integration', () => {
  beforeEach(async () => {
    __resetPipelineState();
    await resetHarnessData();
    await redis.del('bot:latest_announcement');
  });

  afterEach(async () => {
    __resetPipelineState();
    await resetHarnessData();
    await redis.del('bot:latest_announcement');
  });

  it('publishes one ordered artifact, serves exact receipts, and composes a pin without inventing score math', async () => {
    const snapshot = await publishSyntheticFeed(2263, 64);
    const publishedOrder = await redis.lrange('feed:order', 0, PUBLIC_SNAPSHOT_LIMIT - 1);
    const publishedCount = Number(await redis.get('feed:count'));

    expect(snapshot.status).toBe('current');
    expect(publishedCount).toBeGreaterThanOrEqual(PUBLIC_SNAPSHOT_LIMIT);
    expect(snapshot.total_published_items).toBe(publishedCount);
    expect(snapshot.items).toHaveLength(PUBLIC_SNAPSHOT_LIMIT);
    expect(snapshot.items.map((item) => item.post_uri)).toEqual(publishedOrder);
    expect(snapshot.items.map((item) => item.position)).toEqual(
      Array.from({ length: PUBLIC_SNAPSHOT_LIMIT }, (_unused, index) => index + 1)
    );

    for (const rawItem of snapshot.items) {
      const item = expectRankedItem(rawItem);
      const weightedSum = Object.values(item.components)
        .reduce((sum, component) => sum + component.weighted, 0);
      expect(weightedSum).toBeCloseTo(item.base_score, 10);
      expect(item.base_score * item.publication_adjustment).toBeCloseTo(item.final_score, 10);

      const redisScore = await redis.zscore('feed:current', item.post_uri);
      expect(Number(redisScore)).toBeCloseTo(item.final_score, 12);
    }

    const selected = expectRankedItem(snapshot.items[17]);
    const receipt = await readPublishedPostSnapshotReceipt(selected.post_uri, 50);
    expect(receipt).not.toBeNull();
    expect(receipt?.publishedPosition).toBe(selected.position);
    expect(receipt?.explanation.final_score).toBeCloseTo(selected.final_score, 12);
    expect(receipt?.presentationSnapshotId).toBe(snapshot.presentation_snapshot_id);

    const pinnedUri = 'at://did:plc:publictransparencypin/app.bsky.feed.post/announcement';
    await redis.set('bot:latest_announcement', JSON.stringify({ uri: pinnedUri }));
    const pinnedSnapshot = await readTransparencyFeedSnapshot(PUBLIC_SNAPSHOT_LIMIT);
    expect(pinnedSnapshot).not.toBeNull();
    expect(pinnedSnapshot?.presentation_snapshot_id).not.toBe(snapshot.presentation_snapshot_id);
    expect(pinnedSnapshot?.items).toHaveLength(PUBLIC_SNAPSHOT_LIMIT);
    expect(pinnedSnapshot?.items[0]).toMatchObject({
      position: 1,
      ranked_position: null,
      placement: 'pinned_announcement',
      post_uri: pinnedUri,
      base_score: null,
      final_score: null,
      components: null,
    });
    expect(pinnedSnapshot?.items[1].post_uri).toBe(snapshot.items[0].post_uri);

    const shiftedReceipt = await readPublishedPostSnapshotReceipt(snapshot.items[0].post_uri, 50);
    expect(shiftedReceipt?.publishedPosition).toBe(2);
    expect(shiftedReceipt?.presentationSnapshotId).toBe(pinnedSnapshot?.presentation_snapshot_id);
  });

  it('falls back atomically for malformed, weight-disagreeing, and incomplete current artifacts', async () => {
    const current = await publishSyntheticFeed(2264, 24);
    const firstUri = current.items[0].post_uri;
    const publishedCount = Number(await redis.get('feed:count'));

    await redis.hset('feed:explanations', firstUri, '{malformed-json');
    const malformedFallback = await readTransparencyFeedSnapshot(PUBLIC_SNAPSHOT_LIMIT);
    expect(malformedFallback?.status).toBe('last_known_good');
    expect(malformedFallback?.presentation_snapshot_id).not.toBe(current.presentation_snapshot_id);
    expect(malformedFallback?.items.map((item) => item.post_uri)).toEqual(
      current.items.map((item) => item.post_uri)
    );

    const originalExplanation = await redis.hget('feed:last_known_good_explanations', firstUri);
    if (originalExplanation === null) {
      throw new Error(`Expected last-known-good explanation for ${firstUri}`);
    }
    await redis.hset('feed:explanations', firstUri, originalExplanation);
    const originalParsed = JSON.parse(originalExplanation) as TransparencyFeedRankedItem;
    const coherentMutation = structuredClone(originalParsed);
    coherentMutation.components.recency.raw_score += 0.1;
    coherentMutation.components.recency.weighted =
      coherentMutation.components.recency.raw_score * coherentMutation.components.recency.weight;
    coherentMutation.base_score = Object.values(coherentMutation.components)
      .reduce((sum, component) => sum + component.weighted, 0);
    coherentMutation.final_score = coherentMutation.base_score * coherentMutation.publication_adjustment;
    await redis.hset('feed:explanations', firstUri, JSON.stringify(coherentMutation));
    await redis.zadd('feed:current', coherentMutation.final_score, firstUri);

    const coherentFallback = await readTransparencyFeedSnapshot(PUBLIC_SNAPSHOT_LIMIT);
    expect(coherentFallback?.status).toBe('last_known_good');
    const coherentReceiptFallback = await readPublishedPostSnapshotReceipt(firstUri, 50);
    expect(coherentReceiptFallback?.snapshotStatus).toBe('last_known_good');
    expect(coherentReceiptFallback?.explanation.final_score).toBeCloseTo(
      originalParsed.final_score,
      12
    );

    const originalScore = originalParsed.final_score;
    await redis.hset('feed:explanations', firstUri, originalExplanation);
    await redis.zadd('feed:current', originalScore, firstUri);
    const originalDigest = await redis.get('feed:snapshot_digest');
    if (originalDigest === null) {
      throw new Error('Expected current publication digest');
    }
    await redis.set('feed:snapshot_digest', 'b'.repeat(64));
    const digestFallback = await readTransparencyFeedSnapshot(PUBLIC_SNAPSHOT_LIMIT);
    expect(digestFallback?.status).toBe('last_known_good');
    const digestReceiptFallback = await readPublishedPostSnapshotReceipt(firstUri, 50);
    expect(digestReceiptFallback?.snapshotStatus).toBe('last_known_good');
    await redis.set('feed:snapshot_digest', originalDigest);

    await redis.set('feed:weights', JSON.stringify({
      ...current.active_weights,
      recency: current.active_weights.recency + 0.01,
    }));
    const weightFallback = await readTransparencyFeedSnapshot(PUBLIC_SNAPSHOT_LIMIT);
    expect(weightFallback?.status).toBe('last_known_good');

    await redis.set('feed:weights', JSON.stringify(current.active_weights));
    await redis.hdel('feed:explanations', firstUri);
    const incompleteFallback = await readTransparencyFeedSnapshot(PUBLIC_SNAPSHOT_LIMIT);
    expect(incompleteFallback?.status).toBe('last_known_good');
    expect(incompleteFallback?.items.map((item) => item.post_uri)).toEqual(
      current.items.map((item) => item.post_uri)
    );
    await redis.hset('feed:explanations', firstUri, originalExplanation);

    await redis.hdel('feed:explanations', firstUri);
    await redis.hdel('feed:last_known_good_explanations', firstUri);
    await expect(readTransparencyFeedSnapshot(PUBLIC_SNAPSHOT_LIMIT)).rejects.toThrow(
      /snapshot is incomplete/
    );

    // A read-side integrity failure must not mutate either published zset.
    await expect(redis.zcard('feed:current')).resolves.toBe(publishedCount);
    await expect(redis.zcard('feed:last_known_good')).resolves.toBe(publishedCount);
  });

  it('uses zset order only for rollout snapshots without an order list', async () => {
    await publishSyntheticFeed(2270, 24);
    const zsetOrder = await redis.zrevrange('feed:current', 0, -1);
    await redis.del('feed:order', 'feed:current_snapshot_id');
    clearCurrentFeedSnapshotMemoryCache();

    const rolloutSnapshot = await getCurrentFeedSnapshot();
    expect(rolloutSnapshot?.uris).toEqual(zsetOrder);

    const explicitOrder = [...zsetOrder].reverse();
    await redis.rpush('feed:order', ...explicitOrder);
    await redis.del('feed:current_snapshot_id');
    clearCurrentFeedSnapshotMemoryCache();
    const orderedSnapshot = await getCurrentFeedSnapshot();
    expect(orderedSnapshot?.uris).toEqual(explicitOrder);
  });

  it('keeps the anonymous snapshot route below the local 500 ms p95 gate at 100 concurrent reads', async () => {
    await publishSyntheticFeed(2265, 64);
    const rateLimitNamespace = 'transparency-load-rate-limit:';
    await clearRateLimitNamespace(rateLimitNamespace);
    const app = await buildSnapshotHttpApp(rateLimitNamespace);

    try {
      const address = app.server.address();
      if (address === null || typeof address === 'string') {
        throw new Error(`Expected Fastify TCP address, received ${String(address)}`);
      }

      const result = await runHttpLoad({
        baseUrl: `http://127.0.0.1:${address.port}`,
        amount: 100,
        durationMs: null,
        connections: 100,
        timeoutMs: 2_000,
        requests: Array.from({ length: 100 }, (_unused, index) => ({
            method: 'GET',
            path: '/api/transparency/feed-snapshot?limit=50',
            headers: { 'x-forwarded-for': `198.51.100.${index + 1}` },
            body: null,
            expectedStatuses: [200],
          })),
      });

      expect(result.errors).toBe(0);
      expect(result.timeouts).toBe(0);
      expect(result.unexpectedStatuses).toBe(0);
      expect(result.statusCodes).toEqual({ '200': 100 });
      expect(result.latency.p95).toBeLessThan(500);
      console.info(JSON.stringify({
        gate: 'transparency_snapshot_local_load',
        concurrent_reads: 100,
        p95_ms: result.latency.p95,
        passed: true,
      }));
    } finally {
      await app.close();
      await clearRateLimitNamespace(rateLimitNamespace);
    }
  });

  it('enforces the public snapshot rate limit at request 61', async () => {
    await publishSyntheticFeed(2271, 24);
    const rateLimitNamespace = 'transparency-boundary-rate-limit:';
    await clearRateLimitNamespace(rateLimitNamespace);
    const app = await buildSnapshotHttpApp(rateLimitNamespace);

    try {
      for (let requestNumber = 1; requestNumber <= 60; requestNumber += 1) {
        const response = await app.inject({
          method: 'GET',
          url: '/api/transparency/feed-snapshot?limit=1',
        });
        expect(response.statusCode, `request ${requestNumber}`).toBe(200);
      }
      const rejected = await app.inject({
        method: 'GET',
        url: '/api/transparency/feed-snapshot?limit=1',
      });
      expect(rejected.statusCode).toBe(429);
    } finally {
      await app.close();
      await clearRateLimitNamespace(rateLimitNamespace);
    }
  });

  it('publishes a mixed-provenance incremental snapshot and preserves both prior artifacts when promotion validation fails', async () => {
    const first = await publishSyntheticFeed(2266, 24);
    const firstRunId = first.publication_run_id;
    const firstSourceRunIds = new Set(
      (await redis.hvals('feed:explanations')).map((serialized) => (
        JSON.parse(serialized) as { source_score_run_id: string }
      ).source_score_run_id)
    );
    expect(firstSourceRunIds.size).toBe(1);
    const incrementalUri = 'at://did:plc:corgisim000000000001/app.bsky.feed.post/incremental-1';
    await insertIncrementalPost(incrementalUri);

    await runScoringPipeline();
    const incremental = await readTransparencyFeedSnapshot(PUBLIC_SNAPSHOT_LIMIT);
    if (incremental === null) {
      throw new Error('Expected the incremental scoring pass to publish a snapshot');
    }
    expect(incremental.publication_run_id).not.toBe(firstRunId);

    const explanations = (await redis.hvals('feed:explanations')).map((serialized) => (
      JSON.parse(serialized) as { post_uri: string; source_score_run_id: string }
    ));
    const sourceRunIds = new Set(explanations.map((item) => item.source_score_run_id));
    expect(sourceRunIds).toEqual(new Set([
      ...firstSourceRunIds,
      incremental.publication_run_id,
    ]));
    expect(explanations.find((item) => item.post_uri === incrementalUri)?.source_score_run_id)
      .toBe(incremental.publication_run_id);

    const beforeFailedPromotion = await capturePublishedArtifacts();
    const failingUri = 'at://did:plc:corgisim000000000001/app.bsky.feed.post/incremental-2';
    await insertIncrementalPost(failingUri);

    const redisEval = redis as unknown as RedisEvalSurface;
    const originalEval = redisEval.eval;
    let promotionWasCorrupted = false;
    redisEval.eval = async (
      script: string,
      numberOfKeys: number,
      ...args: Array<string | number>
    ): Promise<unknown> => {
      if (!promotionWasCorrupted && script.includes('staged feed integrity seal disagreement')) {
        const stagedOrderKey = String(args[2]);
        const stagedExplanationKey = String(args[4]);
        const firstStagedUri = await redis.lindex(stagedOrderKey, 0);
        if (firstStagedUri === null) {
          throw new Error(`Expected staged order rows before promotion; numberOfKeys=${numberOfKeys}`);
        }
        await redis.hset(stagedExplanationKey, firstStagedUri, '{injected-malformed-explanation');
        promotionWasCorrupted = true;
      }
      return originalEval.call(redis, script, numberOfKeys, ...args);
    };

    try {
      await expect(runScoringPipeline()).rejects.toThrow(
        /staged feed explanation(?: seal)? disagreement/
      );
    } finally {
      redisEval.eval = originalEval;
    }

    expect(promotionWasCorrupted).toBe(true);
    await expect(capturePublishedArtifacts()).resolves.toEqual(beforeFailedPromotion);
    await expect(redis.keys('feed:staging:*')).resolves.toEqual([]);
    const preserved = await readTransparencyFeedSnapshot(PUBLIC_SNAPSHOT_LIMIT);
    expect(preserved?.publication_run_id).toBe(incremental.publication_run_id);
    expect(preserved?.status).toBe('current');
  });

});
