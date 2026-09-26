/**
 * Real-datastore coverage for publication-bound transparency snapshots.
 *
 * This file intentionally uses the isolated simulation harness config. It
 * exercises the production PostgreSQL scoring/publication path and the real
 * Redis Lua readers without adding Docker to the default unit-test suite.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHttpLoad } from '../../scripts/http-load.js';
import { runScenario } from '../../src/harness/index.js';
import { db } from '../../src/db/client.js';
import { handleDelete } from '../../src/ingestion/handlers/delete-handler.js';
import { processEvent } from '../../src/ingestion/event-processor.js';
import { COLLECTIONS } from '../../src/ingestion/jetstream.types.js';
import { assertPublicPostEligibility } from '../../src/transparency/public-post-eligibility.js';
import { registerGovernanceRoutes } from '../../src/admin/routes/governance.js';
import { registerPostExplainRoute } from '../../src/transparency/routes/post-explain.js';
import { redis } from '../../src/db/redis.js';
import {
  clearCurrentFeedSnapshotMemoryCache,
  getCurrentFeedSnapshot,
} from '../../src/feed/snapshot-cache.js';
import { __resetPipelineState, requestFullRescore, runScoringPipeline } from '../../src/scoring/pipeline.js';
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
const actualFetch = globalThis.fetch;
const observedPublicCids = new Map<string, string>();
const hiddenAppViewUris = new Set<string>();

async function syntheticPublicFetch(input: string | URL | Request, options: RequestInit | undefined): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin === 'https://public.api.bsky.app') {
    return Response.json({ posts: url.searchParams.getAll('uris').filter((uri) => !hiddenAppViewUris.has(uri)).map((uri) => ({
      uri, cid: observedPublicCids.get(uri) ?? 'synthetic-external-pin-cid',
      author: { did: uri.split('/')[2], handle: 'synthetic.test' }, record: { text: 'Synthetic public AppView proof' },
    })) });
  }
  if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw new TypeError(`Unapproved synthetic fixture origin: ${url.origin}`);
  return actualFetch(input, options);
}
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
  const visibleRows = await db.query<{ uri: string; cid: string }>('SELECT uri, cid FROM posts WHERE deleted = FALSE');
  for (const row of visibleRows.rows) observedPublicCids.set(row.uri, row.cid);
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
  registerPostExplainRoute(app);
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
    const bytes = await redis.dumpBuffer(key);
    result[key] = bytes === null ? null : bytes.toString('base64');
  }
  return result;
}

async function prepareC4PolicyChange(seed: number, durable: boolean): Promise<{
  initial: TransparencyFeedSnapshot; retiredUri: string; otherEpoch: number;
}> {
  const initial = await publishSyntheticFeed(seed, 24);
  const retiredUri = initial.items[0].post_uri;
  const otherEpoch = initial.epoch_id - 1;
  expect(otherEpoch).toBeGreaterThan(0);
  await db.query(`INSERT INTO post_scores
    SELECT (jsonb_populate_record(NULL::post_scores, to_jsonb(scores) ||
      jsonb_build_object('id', uuid_generate_v4(), 'epoch_id', $2::integer))).*
    FROM post_scores scores WHERE epoch_id = $1 AND post_uri = $3
    ON CONFLICT (post_uri, epoch_id, created_at) DO NOTHING`,
  [initial.epoch_id, otherEpoch, retiredUri]);
  await db.query(`INSERT INTO post_score_components
    SELECT (jsonb_populate_record(NULL::post_score_components, to_jsonb(components) ||
      jsonb_build_object('epoch_id', $2::integer))).*
    FROM post_score_components components WHERE epoch_id = $1 AND post_uri = $3
    ON CONFLICT (post_uri, epoch_id, component_key, created_at) DO NOTHING`,
  [initial.epoch_id, otherEpoch, retiredUri]);
  await db.query("UPDATE posts SET text = 'c4retired synthetic policy exclusion' WHERE uri = $1", [retiredUri]);
  if (durable) {
    const rules = await c4AdminOverride('/governance/content-rules', { includeKeywords: [], excludeKeywords: ['c4retired'] });
    const weights = await c4AdminOverride('/governance/weights', {
      recency: 0.6, engagement: 0.1, bridging: 0.1, sourceDiversity: 0.1, relevance: 0.1,
    });
    expect(rules.statusCode).toBe(200);
    expect(weights.statusCode).toBe(200);
    const audit = await db.query<{ generation: number }>(`SELECT (details->>'rescore_generation')::int AS generation
      FROM governance_audit_log WHERE epoch_id = $1 AND action IN ('admin_rules_override', 'admin_weights_override') ORDER BY generation`, [initial.epoch_id]);
    expect(audit.rows.map((row) => row.generation)).toEqual([1, 2]);
  } else {
    await db.query(`UPDATE governance_epochs SET recency_weight = 0.6, engagement_weight = 0.1,
      bridging_weight = 0.1, source_diversity_weight = 0.1, relevance_weight = 0.1,
      content_rules = '{"include_keywords":[],"exclude_keywords":["c4retired"]}'::jsonb WHERE id = $1`, [initial.epoch_id]);
    requestFullRescore();
  }
  return { initial, retiredUri, otherEpoch };
}

async function c4ScoreCounts(epochId: number, postUri: string): Promise<{ wide: number; components: number }> {
  const rows = await db.query<{ wide: string; components: string }>(`SELECT
    (SELECT COUNT(*) FROM post_scores WHERE epoch_id = $1 AND post_uri = $2)::text AS wide,
    (SELECT COUNT(*) FROM post_score_components WHERE epoch_id = $1 AND post_uri = $2)::text AS components`,
  [epochId, postUri]);
  return { wide: Number(rows.rows[0].wide), components: Number(rows.rows[0].components) };
}

async function c4AdminOverride(url: string, payload: Record<string, unknown>) {
  const app = Fastify();
  app.addHook('preHandler', async (request) => { request.adminDid = 'did:plc:c4syntheticadmin'; });
  registerGovernanceRoutes(app);
  // Exercise the actual scheduler's overlap refusal to keep the test boundary
  // deterministic, without replacing the route, queue or scoring implementation.
  const lock = await redis.set('lock:scoring', 'c4-admin-fixture', 'EX', 60, 'NX');
  expect(lock).toBe('OK');
  try {
    const response = await app.inject({ method: 'PATCH', url, payload });
    if (response.statusCode === 200) expect(response.json().rescoreTriggered).toBe(false);
    return response;
  } finally {
    expect(await redis.get('lock:scoring')).toBe('c4-admin-fixture');
    await redis.del('lock:scoring');
    await app.close();
  }
}

async function c4PendingGeneration(epochId: number): Promise<number | null> {
  const result = await db.query<{ generation: number | string }>(`SELECT requested_generation AS generation
    FROM governance_rescore_requests WHERE epoch_id = $1 AND requested_generation > completed_generation`, [epochId]);
  const raw = result.rows[0]?.generation;
  if (raw === undefined) return null;
  const generation = Number(raw);
  if (!Number.isSafeInteger(generation) || generation <= 0) throw new TypeError(`C4 invalid pending generation: ${String(raw)}`);
  return generation;
}

async function c4ExpectRetiredAndOrdinary(epochId: number, retiredUri: string, otherEpoch: number): Promise<void> {
  expect(await c4ScoreCounts(epochId, retiredUri)).toEqual({ wide: 0, components: 0 });
  const other = await c4ScoreCounts(otherEpoch, retiredUri);
  expect(other.wide).toBeGreaterThan(0);
  expect(other.components).toBeGreaterThan(0);
  const published = await readTransparencyFeedSnapshot(PUBLIC_SNAPSHOT_LIMIT);
  expect(published).not.toBeNull();
  expect(published?.active_weights.recency).toBeCloseTo(0.6, 10);
  expect(published?.items.some((item) => item.post_uri === retiredUri)).toBe(false);
  await runScoringPipeline();
  const ordinary = await readTransparencyFeedSnapshot(PUBLIC_SNAPSHOT_LIMIT);
  expect(ordinary?.publication_run_id).not.toBe(published?.publication_run_id);
  expect(ordinary?.items.some((item) => item.post_uri === retiredUri)).toBe(false);
  const scope = await db.query<{ value: { run_id: string } }>("SELECT value FROM system_status WHERE key = 'current_scoring_run'");
  expect(scope.rows[0].value.run_id).toBe(ordinary?.publication_run_id);
}

describe('Transparency publication: real PostgreSQL and Redis integration', () => {
  beforeEach(async () => {
    observedPublicCids.clear();
    hiddenAppViewUris.clear();
    vi.stubGlobal('fetch', syntheticPublicFetch);
    __resetPipelineState();
    await resetHarnessData();
    await redis.del('bot:latest_announcement');
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    __resetPipelineState();
    await resetHarnessData();
    await redis.del('bot:latest_announcement');
  });

  it('C4 retires a null-generation request and stays valid after a process-state reset', async () => {
    const { initial, retiredUri, otherEpoch } = await prepareC4PolicyChange(2291, false);
    expect(await c4PendingGeneration(initial.epoch_id)).toBeNull();
    await runScoringPipeline();
    __resetPipelineState();
    await c4ExpectRetiredAndOrdinary(initial.epoch_id, retiredUri, otherEpoch);
  });

  it('C4 actual admin durable request survives retirement rollback and process-state reset', async () => {
    const { initial, retiredUri, otherEpoch } = await prepareC4PolicyChange(2292, true);
    const before = await capturePublishedArtifacts();
    const stale = await c4ScoreCounts(initial.epoch_id, retiredUri);
    expect(stale.wide).toBeGreaterThan(0);
    expect(stale.components).toBeGreaterThan(0);
    await db.query(`CREATE FUNCTION c4_reject_retirement() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'C4 retirement rejected'; END $$`);
    await db.query('CREATE TRIGGER c4_retirement_failure BEFORE DELETE ON post_scores FOR EACH ROW EXECUTE FUNCTION c4_reject_retirement()');
    try {
      await expect(runScoringPipeline()).rejects.toThrow('C4 retirement rejected');
    } finally {
      await db.query('DROP TRIGGER c4_retirement_failure ON post_scores');
      await db.query('DROP FUNCTION c4_reject_retirement()');
    }
    expect(await capturePublishedArtifacts()).toEqual(before);
    expect(await c4ScoreCounts(initial.epoch_id, retiredUri)).toEqual(stale);
    expect((await readTransparencyFeedSnapshot(PUBLIC_SNAPSHOT_LIMIT))?.publication_run_id).toBe(initial.publication_run_id);
    expect(await c4PendingGeneration(initial.epoch_id)).toBe(2);
    __resetPipelineState();
    await runScoringPipeline();
    expect(await c4PendingGeneration(initial.epoch_id)).toBeNull();
    await c4ExpectRetiredAndOrdinary(initial.epoch_id, retiredUri, otherEpoch);
  });

  it('C4 actual admin enqueue failure rolls back policy and audit', async () => {
    const initial = await publishSyntheticFeed(2293, 24);
    const policy = await db.query('SELECT * FROM governance_epochs WHERE id = $1', [initial.epoch_id]);
    const audit = await db.query('SELECT * FROM governance_audit_log WHERE epoch_id = $1 ORDER BY id', [initial.epoch_id]);
    const before = await capturePublishedArtifacts();
    await db.query(`CREATE FUNCTION c4_reject_enqueue() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'C4 enqueue rejected'; END $$`);
    await db.query('CREATE TRIGGER c4_enqueue_failure BEFORE INSERT OR UPDATE ON governance_rescore_requests FOR EACH ROW EXECUTE FUNCTION c4_reject_enqueue()');
    try {
      const response = await c4AdminOverride('/governance/weights', { recency: 0.6 });
      expect(response.statusCode).toBe(500);
      expect(response.json().error).toBe('WeightUpdateFailed');
    } finally {
      await db.query('DROP TRIGGER c4_enqueue_failure ON governance_rescore_requests');
      await db.query('DROP FUNCTION c4_reject_enqueue()');
    }
    expect((await db.query('SELECT * FROM governance_epochs WHERE id = $1', [initial.epoch_id])).rows).toEqual(policy.rows);
    expect((await db.query('SELECT * FROM governance_audit_log WHERE epoch_id = $1 ORDER BY id', [initial.epoch_id])).rows).toEqual(audit.rows);
    expect(await c4PendingGeneration(initial.epoch_id)).toBeNull();
    expect(await capturePublishedArtifacts()).toEqual(before);
  });

  it.each(['reject-before-promotion', 'lost-promotion-reply'] as const)('C4 %s retains a coherent publication and durable retry after SQL commit', async (mode) => {
    const { initial, retiredUri, otherEpoch } = await prepareC4PolicyChange(2294, true);
    const before = await capturePublishedArtifacts();
    const redisEval = redis as unknown as RedisEvalSurface;
    const originalEval = redisEval.eval;
    let injected = false;
    redisEval.eval = async (script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown> => {
      if (!injected && script.includes('staged feed integrity seal disagreement')) {
        injected = true;
        expect(await c4ScoreCounts(initial.epoch_id, retiredUri)).toEqual({ wide: 0, components: 0 });
        if (mode === 'reject-before-promotion') {
          const uri = await redis.lindex(String(args[2]), 0);
          if (uri === null) throw new TypeError('C4 expected staged row');
          await redis.hset(String(args[4]), uri, '{malformed-c4');
        } else {
          await originalEval.call(redis, script, numberOfKeys, ...args);
          throw new Error('C4 lost promotion reply');
        }
      }
      return originalEval.call(redis, script, numberOfKeys, ...args);
    };
    try { await expect(runScoringPipeline()).rejects.toThrow(mode === 'reject-before-promotion' ? /staged feed explanation/ : 'C4 lost promotion reply'); }
    finally { redisEval.eval = originalEval; }
    expect(injected).toBe(true);
    expect(await c4PendingGeneration(initial.epoch_id)).toBe(2);
    if (mode === 'reject-before-promotion') expect(await capturePublishedArtifacts()).toEqual(before);
    const readable = await readTransparencyFeedSnapshot(PUBLIC_SNAPSHOT_LIMIT);
    expect(readable).not.toBeNull();
    if (mode === 'reject-before-promotion') expect(readable?.publication_run_id).toBe(initial.publication_run_id);
    else expect(readable?.publication_run_id).not.toBe(initial.publication_run_id);
    expect(await readPublishedPostSnapshotReceipt(readable!.items[1].post_uri, PUBLIC_SNAPSHOT_LIMIT)).not.toBeNull();
    await expect(redis.keys('feed:staging:*')).resolves.toEqual([]);
    __resetPipelineState();
    await runScoringPipeline();
    expect(await c4PendingGeneration(initial.epoch_id)).toBeNull();
    await c4ExpectRetiredAndOrdinary(initial.epoch_id, retiredUri, otherEpoch);
  });

  it('C4 durable acknowledgement failure leaves coherent new publication with pending retry', async () => {
    const { initial, retiredUri, otherEpoch } = await prepareC4PolicyChange(2295, true);
    await db.query(`CREATE FUNCTION c4_reject_ack() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.completed_generation > OLD.completed_generation THEN RAISE EXCEPTION 'C4 acknowledgement rejected'; END IF; RETURN NEW; END $$`);
    await db.query('CREATE TRIGGER c4_ack_failure BEFORE UPDATE ON governance_rescore_requests FOR EACH ROW EXECUTE FUNCTION c4_reject_ack()');
    try { await expect(runScoringPipeline()).rejects.toThrow('C4 acknowledgement rejected'); }
    finally {
      await db.query('DROP TRIGGER c4_ack_failure ON governance_rescore_requests');
      await db.query('DROP FUNCTION c4_reject_ack()');
    }
    expect(await c4PendingGeneration(initial.epoch_id)).toBe(2);
    const promoted = await readTransparencyFeedSnapshot(PUBLIC_SNAPSHOT_LIMIT);
    expect(promoted).not.toBeNull();
    expect(promoted?.publication_run_id).not.toBe(initial.publication_run_id);
    expect(promoted?.items.some((item) => item.post_uri === retiredUri)).toBe(false);
    expect(await readPublishedPostSnapshotReceipt(promoted!.items[0].post_uri, PUBLIC_SNAPSHOT_LIMIT)).not.toBeNull();
    __resetPipelineState();
    await runScoringPipeline();
    expect(await c4PendingGeneration(initial.epoch_id)).toBeNull();
    await c4ExpectRetiredAndOrdinary(initial.epoch_id, retiredUri, otherEpoch);
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

  it('rejects current seal corruption when the complete older publication lacks that post', async () => {
    await publishSyntheticFeed(2287, 24);
    const previous = await capturePublishedArtifacts();
    const author = await db.query<{ did: string }>('SELECT did FROM subscribers ORDER BY did LIMIT 1');
    if (author.rows[0] === undefined) throw new TypeError('Expected seeded fixture author');
    const postUri = `at://${author.rows[0].did}/app.bsky.feed.post/current-only-receipt`;
    await insertIncrementalPost(postUri);
    requestFullRescore();
    await runScoringPipeline();

    // Restore a genuinely complete older publication, not a manufactured partial absence.
    for (const key of PUBLISHED_ARTIFACT_KEYS.filter((value) => value.startsWith('feed:last_known_good'))) {
      const serialized = previous[key];
      if (serialized === null) throw new TypeError(`Expected complete prior fixture key ${key}`);
      await redis.restore(key, 0, Buffer.from(serialized, 'base64'), 'REPLACE');
    }
    await expect(redis.zscore('feed:last_known_good', postUri)).resolves.toBeNull();
    await expect(readPublishedPostSnapshotReceipt(postUri, 50)).resolves.toMatchObject({
      snapshotStatus: 'current', explanation: { post_uri: postUri },
    });
    await redis.hset('feed:explanation_seals', postUri, '0'.repeat(40));
    const beforeRead = await capturePublishedArtifacts();
    await expect(readPublishedPostSnapshotReceipt(postUri, 50)).rejects.toThrow(/snapshot is incomplete/);
    expect(await capturePublishedArtifacts()).toEqual(beforeRead);
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
    // A real rollout-era publication has no new-format schema marker.
    await redis.del('feed:order', 'feed:explanation_schema_version', 'feed:current_snapshot_id');
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

  it('withdraws stale current and LKG URI/math after actual public-baseline deletion, including all conditional requests', async () => {
    const initial = await publishSyntheticFeed(2273, 24);
    const postUri = initial.items[0].post_uri;
    const namespace = 'transparency-deletion-boundary:';
    const app = await buildSnapshotHttpApp(namespace);
    let monotonicNow = 0;
    const performanceNow = vi.spyOn(performance, 'now').mockImplementation(() => monotonicNow);
    try {
      const first = await app.inject({ method: 'GET', url: '/api/transparency/feed-snapshot' });
      expect(first.statusCode).toBe(200);
      monotonicNow += 5000;
      await expect(handleDelete(postUri, COLLECTIONS.POST)).resolves.toBe('delete-post-applied');
      const rows = await db.query<{ visible: string; scores: string }>(
        `SELECT (SELECT COUNT(*) FROM posts WHERE uri = $1 AND deleted = FALSE)::text AS visible,
                (SELECT COUNT(*) FROM post_scores WHERE post_uri = $1)::text AS scores`, [postUri]
      );
      expect(rows.rows[0].visible).toBe('0');
      // Legacy ingestion retains scores; the disclosure gate must deny despite stale math.
      expect(Number(rows.rows[0].scores)).toBeGreaterThan(0);
      for (const useLastKnownGood of [false, true]) {
        if (useLastKnownGood) await redis.hset('feed:explanations', postUri, '{corrupt-current');
        for (const conditional of [undefined, first.headers.etag, `"other", ${first.headers.etag}`, `W/${first.headers.etag}`, '*']) {
          const after = await app.inject({ method: 'GET', url: '/api/transparency/feed-snapshot', headers: conditional === undefined ? {} : { 'if-none-match': String(conditional) } });
          expect(after.statusCode).toBe(503);
          expect(after.headers['cache-control']).toBe('no-store');
          expect(after.headers.etag).toBeUndefined();
          expect(after.body).not.toContain(postUri);
          expect(after.body).not.toContain('final_score');
        }
      }
      await db.query('UPDATE posts SET deleted=TRUE');
      await runScoringPipeline();
      const afterEmptyRefresh = await app.inject({ method: 'GET', url: '/api/transparency/feed-snapshot', headers: { 'if-none-match': String(first.headers.etag) } });
      expect(afterEmptyRefresh.statusCode).toBe(503);
      expect(afterEmptyRefresh.body).not.toContain(postUri);
      const receipt = await app.inject({ method: 'GET', url: `/api/transparency/post/${encodeURIComponent(postUri)}` });
      expect(receipt.statusCode).toBe(503);
      expect(receipt.headers['cache-control']).toBe('no-store');
      expect(receipt.body).not.toContain(postUri);
      console.info(JSON.stringify({
        gate: 'snapshot_deletion_visibility_boundary', visible_rows: 0, retained_score_rows: Number(rows.rows[0].scores),
        retained_public_uri_math: false, denied_snapshot_requests: 11, denied_receipt_requests: 1,
        interpretation: 'Request-time synthetic AppView proof plus actual retained-row deletion gate; current and LKG both unavailable',
      }));
    } finally {
      performanceNow.mockRestore();
      await app.close();
      await clearRateLimitNamespace(namespace);
    }
  });


  it('withdraws a snapshot when anonymous AppView omits a still-locally-visible URI and revalidates unscored pins', async () => {
    const initial = await publishSyntheticFeed(2274, 24);
    const namespace = 'transparency-hidden-boundary:';
    const app = await buildSnapshotHttpApp(namespace);
    let monotonicNow = 0;
    const performanceNow = vi.spyOn(performance, 'now').mockImplementation(() => monotonicNow);
    try {
      const first = await app.inject({ method: 'GET', url: '/api/transparency/feed-snapshot' });
      expect(first.statusCode).toBe(200);
      monotonicNow += 5000;
      hiddenAppViewUris.add(initial.items[0].post_uri);
      const hidden = await app.inject({ method: 'GET', url: '/api/transparency/feed-snapshot', headers: { 'if-none-match': String(first.headers.etag) } });
      expect(hidden.statusCode).toBe(503);
      expect(hidden.body).not.toContain(initial.items[0].post_uri);
      hiddenAppViewUris.clear();
      const pin = 'at://did:plc:externalpin/app.bsky.feed.post/announcement';
      await redis.set('bot:latest_announcement', JSON.stringify({ uri: pin }));
      const visiblePin = await app.inject({ method: 'GET', url: '/api/transparency/feed-snapshot' });
      expect(visiblePin.statusCode).toBe(200);
      expect(visiblePin.json<TransparencyFeedSnapshot>().items[0].post_uri).toBe(pin);
      monotonicNow += 5000;
      hiddenAppViewUris.add(pin);
      const hiddenPin = await app.inject({ method: 'GET', url: '/api/transparency/feed-snapshot', headers: { 'if-none-match': String(visiblePin.headers.etag) } });
      expect(hiddenPin.statusCode).toBe(503);
      expect(hiddenPin.body).not.toContain(pin);
      hiddenAppViewUris.clear();
      await db.query("INSERT INTO posts(uri,cid,author_did,text,created_at) VALUES ($1,'synthetic-external-pin-cid','did:plc:externalpin','Synthetic announcement',NOW())", [pin]);
      await handleDelete(pin, COLLECTIONS.POST);
      const tombstonedPin = await app.inject({ method: 'GET', url: '/api/transparency/feed-snapshot' });
      expect(tombstonedPin.statusCode).toBe(503);
    } finally {
      performanceNow.mockRestore();
      await app.close();
      await clearRateLimitNamespace(namespace);
    }
  });

  it('denies an ignored public update when AppView CID differs, including unchanged ETags and receipt fallback', async () => {
    const initial = await publishSyntheticFeed(2277, 24);
    const uri = initial.items[0].post_uri;
    const stored = await db.query<{ cid: string; author_did: string; created_at: Date }>('SELECT cid, author_did, created_at FROM posts WHERE uri=$1', [uri]);
    const row = stored.rows[0];
    const namespace = 'transparency-legacy-update:';
    const app = await buildSnapshotHttpApp(namespace);
    let monotonicNow = 0;
    const performanceNow = vi.spyOn(performance, 'now').mockImplementation(() => monotonicNow);
    try {
      const first = await app.inject({ method: 'GET', url: '/api/transparency/feed-snapshot' });
      expect(first.statusCode).toBe(200);
      const rkey = uri.split('/').at(-1);
      if (rkey === undefined) throw new TypeError('Synthetic post has no rkey');
      await expect(processEvent({ kind: 'commit', did: row.author_did, time_us: 9000000000000000,
        commit: { rev: 'synthetic-update', operation: 'update', collection: COLLECTIONS.POST, rkey,
          cid: 'synthetic-updated-cid', record: { text: 'Updated public content', createdAt: row.created_at.toISOString() } },
      })).resolves.toBe('update-ignored');
      const unchanged = await db.query<{ cid: string }>('SELECT cid FROM posts WHERE uri=$1', [uri]);
      expect(unchanged.rows).toEqual([{ cid: row.cid }]);
      observedPublicCids.set(uri, 'synthetic-updated-cid');
      monotonicNow += 5000;
      const denied = await app.inject({ method: 'GET', url: '/api/transparency/feed-snapshot', headers: { 'if-none-match': String(first.headers.etag) } });
      expect(denied.statusCode).toBe(503);
      expect(denied.headers['cache-control']).toBe('no-store');
      expect(denied.body).not.toContain(uri);
      for (const removeArtifact of [false, true]) {
        if (removeArtifact) await redis.del('feed:explanations', 'feed:last_known_good_explanations');
        const receipt = await app.inject({ method: 'GET', url: `/api/transparency/post/${encodeURIComponent(uri)}` });
        expect(receipt.statusCode).toBe(503);
        expect(receipt.body).not.toContain(uri);
      }
    } finally {
      performanceNow.mockRestore();
      await app.close();
      await clearRateLimitNamespace(namespace);
    }
  });

  it('fails closed for ambiguous, deleted, null-deletion, absent and CID-mismatched legacy rows', async () => {
    const snapshot = await publishSyntheticFeed(2278, 24);
    const uri = snapshot.items[0].post_uri;
    const state = await db.query<{ cid: string; author_did: string; created_at: Date }>('SELECT cid,author_did,created_at FROM posts WHERE uri=$1', [uri]);
    const row = state.rows[0];
    const target = [{ postUri: uri, requiresLocalPost: true }];
    await expect(assertPublicPostEligibility(target)).resolves.toBeUndefined();
    await db.query('UPDATE posts SET cid=$2 WHERE uri=$1', [uri, 'wrong-local-cid']);
    await expect(assertPublicPostEligibility(target)).rejects.toThrow('eligibility');
    await db.query('UPDATE posts SET cid=$2,deleted=NULL WHERE uri=$1', [uri, row.cid]);
    await expect(assertPublicPostEligibility(target)).rejects.toThrow('eligibility');
    await db.query('UPDATE posts SET deleted=FALSE WHERE uri=$1', [uri]);
    await db.query('INSERT INTO posts(uri,cid,author_did,text,created_at,deleted) VALUES ($1,$2,$3,$4,$5,TRUE)', [uri,row.cid,row.author_did,'Historical synthetic row',new Date(row.created_at.getTime()+1000)]);
    await expect(assertPublicPostEligibility(target)).rejects.toThrow('eligibility');
    await db.query('DELETE FROM posts WHERE uri=$1', [uri]);
    await expect(assertPublicPostEligibility(target)).rejects.toThrow('eligibility');
    await expect(assertPublicPostEligibility([{ postUri: uri, requiresLocalPost: false }])).resolves.toBeUndefined();
  });


});
