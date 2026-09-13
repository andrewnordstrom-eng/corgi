/**
 * Real PostgreSQL + Redis A/B benchmark for the publication transparency work.
 *
 * Baseline mirrors origin/main's pre-feature publisher: narrow projection,
 * URL dedup, two staged zsets, seven staged metadata values, atomic rename,
 * then snapshot invalidation. Feature mirrors the current publisher: expanded
 * projection, deterministic dedup, explanation artifact/digest/seals, staged
 * zsets/lists/hashes/metadata, and the production promotion Lua script.
 */

import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { db } from '../../src/db/client.js';
import { redis } from '../../src/db/redis.js';
import {
  applyFeedUrlDedup,
  buildFeedPublicationArtifact,
  digestFeedPublicationArtifact,
  FEED_URL_DEDUP_DECAY,
  sealFeedPublicationExplanation,
  sealFeedPublicationStorage,
  type FeedPublicationExplanationCandidate,
  type PublicFeedScoreComponents,
  type PublicFeedWeights,
} from '../../src/scoring/feed-publication.js';
import { __PUBLISH_STAGED_FEED_SCRIPT_FOR_TESTS } from '../../src/scoring/pipeline.js';
import { insertActiveEpoch, resetHarnessData } from './helpers.js';

const ROW_COUNT = 1_000;
const WARMUP_PAIRS = 3;
const MEASURED_PAIRS = 21;
const MAX_PUBLICATION_P95_MS = 500;
const MAX_SCORING_TIMEOUT_SHARE = 0.01;
const STAGING_TTL_SECONDS = Math.ceil((config.SCORING_TIMEOUT_MS * 2) / 1_000);
const ACTIVE_WEIGHTS: PublicFeedWeights = {
  recency: 0.2,
  engagement: 0.2,
  bridging: 0.2,
  source_diversity: 0.2,
  relevance: 0.2,
};

const BASELINE_PROMOTION_SCRIPT = `
local sourceCount = tonumber(ARGV[1])
if sourceCount == nil or sourceCount <= 0 or #KEYS ~= sourceCount * 2 then
  return redis.error_reply('invalid staged feed publish arguments')
end
for index = 1, sourceCount do
  if redis.call('EXISTS', KEYS[index]) ~= 1 then
    return redis.error_reply('missing staged feed publish key at index ' .. index)
  end
end
for index = 1, sourceCount do
  local destinationIndex = sourceCount + index
  redis.call('RENAME', KEYS[index], KEYS[destinationIndex])
  redis.call('PERSIST', KEYS[destinationIndex])
end
return 1
`;

const BASELINE_INVALIDATION_SCRIPT = `
redis.call('INCR', KEYS[1])
redis.call('DEL', KEYS[2])
return 1
`;

interface BaselineRow {
  post_uri: string;
  total_score: number | string;
  author_did: string;
  bridging_score: number | string;
  engagement_score: number | string;
  embed_url: string | null;
  text_length: number | string;
}

interface FeatureRow extends BaselineRow {
  created_at: Date | string;
  scored_at: Date | string;
  classification_method: string | null;
  source_score_run_id: string | null;
  recency_score: number | string;
  source_diversity_score: number | string;
  relevance_score: number | string;
  recency_weight: number | string;
  engagement_weight: number | string;
  bridging_weight: number | string;
  source_diversity_weight: number | string;
  relevance_weight: number | string;
  recency_weighted: number | string;
  engagement_weighted: number | string;
  bridging_weighted: number | string;
  source_diversity_weighted: number | string;
  relevance_weighted: number | string;
}

interface PublicationCandidate {
  post_uri: string;
  total_score: number;
  author_did: string;
  bridging_score: number;
  engagement_score: number;
  embed_url: string | null;
  text_length: number;
}

interface FeatureCandidate extends PublicationCandidate {
  created_at: string;
  scored_at: string;
  classification_method: 'keyword' | 'embedding';
  source_score_run_id: string;
  components: PublicFeedScoreComponents;
}

interface PublicationTiming {
  totalMs: number;
  queryMapAndSharedBuildMs: number;
  artifactAndSealMs: number;
  redisStagingMs: number;
  redisPromotionMs: number;
}

function numericValue(value: number | string, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new TypeError(`${label} must be finite; received ${String(value)}`);
  }
  return parsed;
}

function assertTransactionSucceeded(
  result: Array<[Error | null, unknown]> | null,
  label: string
): void {
  if (result === null) {
    throw new Error(`${label} transaction aborted`);
  }
  for (const [index, [error]] of result.entries()) {
    if (error !== null) {
      throw new Error(`${label} command ${index} failed: ${error.message}`, { cause: error });
    }
  }
}

function consumeSharedFeedStats(rows: readonly PublicationCandidate[]): number {
  const authors = new Map<string, number>();
  let total = 0;
  for (const row of rows) {
    authors.set(row.author_did, (authors.get(row.author_did) ?? 0) + 1);
    total += row.total_score + row.bridging_score + row.engagement_score;
  }
  const sortedScores = rows.map((row) => row.total_score).sort((left, right) => left - right);
  const median = sortedScores[Math.floor(sortedScores.length / 2)] ?? 0;
  return total + median + authors.size;
}

async function seedBenchmarkRows(): Promise<number> {
  const epochId = await insertActiveEpoch('transparency publisher A/B benchmark');
  await db.query(
    `INSERT INTO posts (
       uri, cid, author_did, text, created_at, has_media, embed_url,
       topic_vector, classification_method
     )
     SELECT
       'at://did:plc:publisherbenchmark/app.bsky.feed.post/' || LPAD(series::text, 4, '0'),
       'benchmark-cid-' || series,
       'did:plc:publisherbenchmarkauthor' || LPAD((series % 100)::text, 3, '0'),
       REPEAT('publication benchmark text ', 5),
       NOW() - (series || ' milliseconds')::interval,
       FALSE,
       NULL,
       '{"software-development":1,"science":1}'::jsonb,
       'keyword'
     FROM generate_series(1, $1) AS series`,
    [ROW_COUNT]
  );
  await db.query(
    `WITH ranked_posts AS (
       SELECT uri, created_at,
              ROW_NUMBER() OVER (ORDER BY created_at DESC, uri ASC)::double precision AS row_number
       FROM posts
       WHERE uri LIKE 'at://did:plc:publisherbenchmark/%'
     ), scored AS (
       SELECT uri, created_at,
              (1 - row_number / ($2::double precision * 2)) AS factor
       FROM ranked_posts
     )
     INSERT INTO post_scores (
       post_uri, epoch_id,
       recency_score, engagement_score, bridging_score,
       source_diversity_score, relevance_score,
       recency_weight, engagement_weight, bridging_weight,
       source_diversity_weight, relevance_weight,
       recency_weighted, engagement_weighted, bridging_weighted,
       source_diversity_weighted, relevance_weighted,
       total_score, component_details, classification_method, created_at
     )
     SELECT
       uri, $1,
       factor, factor * 0.8, factor * 0.6, factor * 0.4, 1.0,
       0.2, 0.2, 0.2, 0.2, 0.2,
       factor * 0.2, factor * 0.16, factor * 0.12, factor * 0.08, 0.2,
       factor * 0.56 + 0.2,
       jsonb_build_object('run_id', 'benchmark-source-run', 'classification_method', 'keyword'),
       'keyword', created_at
     FROM scored`,
    [epochId, ROW_COUNT]
  );
  return epochId;
}

function cutoffTimestamp(): string {
  return new Date(Date.now() - config.SCORING_WINDOW_HOURS * 60 * 60 * 1_000).toISOString();
}

async function runBaselinePublication(epochId: number, sampleId: string): Promise<PublicationTiming> {
  const startedAt = performance.now();
  const result = await db.query<BaselineRow>(
    `SELECT ps.post_uri, ps.total_score, p.author_did,
            ps.bridging_score, ps.engagement_score, p.embed_url,
            COALESCE(LENGTH(p.text), 0) AS text_length
     FROM post_scores ps
     INNER JOIN posts p ON p.uri = ps.post_uri AND p.created_at = ps.created_at
     WHERE ps.epoch_id = $1
       AND p.deleted = FALSE
       AND p.created_at > $3
       AND p.created_at <= NOW()
       AND ps.created_at > $3
       AND ps.relevance_score >= $4
     ORDER BY ps.total_score DESC
     LIMIT $2`,
    [epochId, ROW_COUNT, cutoffTimestamp(), config.FEED_MIN_RELEVANCE]
  );
  const candidates: PublicationCandidate[] = result.rows.map((row) => ({
    post_uri: row.post_uri,
    total_score: numericValue(row.total_score, `${row.post_uri} total_score`),
    author_did: row.author_did,
    bridging_score: numericValue(row.bridging_score, `${row.post_uri} bridging_score`),
    engagement_score: numericValue(row.engagement_score, `${row.post_uri} engagement_score`),
    embed_url: row.embed_url,
    text_length: numericValue(row.text_length, `${row.post_uri} text_length`),
  }));
  const publication = applyFeedUrlDedup(
    candidates.map((candidate) => ({
      id: candidate.post_uri,
      score: candidate.total_score,
      embedUrl: candidate.embed_url,
      textLength: candidate.text_length,
      value: candidate,
    })),
    {
      enabled: config.FEED_DEDUP_ENABLED,
      minimumOriginalTextLength: config.FEED_DEDUP_MIN_TEXT,
      decay: FEED_URL_DEDUP_DECAY,
    }
  );
  const topPosts = publication.entries.map((entry) => ({ ...entry.value, total_score: entry.score }));
  if (topPosts.length !== ROW_COUNT || !Number.isFinite(consumeSharedFeedStats(topPosts))) {
    throw new Error(`Baseline publication expected ${ROW_COUNT} valid rows; received ${topPosts.length}`);
  }
  const sharedBuildCompletedAt = performance.now();

  const prefix = `benchmark:baseline:${sampleId}`;
  const stagedKeys = [
    `${prefix}:staged:current`,
    `${prefix}:staged:last-known-good`,
    ...Array.from({ length: 7 }, (_unused, index) => `${prefix}:staged:metadata:${index}`),
  ];
  const destinationKeys = [
    `${prefix}:current`,
    `${prefix}:last-known-good`,
    ...Array.from({ length: 7 }, (_unused, index) => `${prefix}:metadata:${index}`),
  ];
  const metadata = [
    epochId.toString(), sampleId, new Date().toISOString(), ROW_COUNT.toString(),
    epochId.toString(), sampleId, ROW_COUNT.toString(),
  ];
  const zaddArguments: Array<string | number> = [];
  for (const row of topPosts) {
    zaddArguments.push(row.total_score, row.post_uri);
  }
  const transaction = redis.multi();
  transaction.del(...stagedKeys);
  transaction.zadd(stagedKeys[0], ...zaddArguments);
  transaction.zadd(stagedKeys[1], ...zaddArguments);
  for (let index = 0; index < metadata.length; index += 1) {
    transaction.set(stagedKeys[index + 2], metadata[index]);
  }
  for (const key of stagedKeys) {
    transaction.expire(key, STAGING_TTL_SECONDS);
  }
  assertTransactionSucceeded(await transaction.exec(), 'baseline staging');
  const stagingCompletedAt = performance.now();
  const promoted = await redis.eval(
    BASELINE_PROMOTION_SCRIPT,
    stagedKeys.length + destinationKeys.length,
    ...stagedKeys,
    ...destinationKeys,
    stagedKeys.length.toString()
  );
  if (promoted !== 1) {
    throw new Error(`Baseline promotion returned ${String(promoted)}`);
  }
  await redis.eval(
    BASELINE_INVALIDATION_SCRIPT,
    2,
    `${prefix}:snapshot-generation`,
    `${prefix}:snapshot-current`
  );
  const completedAt = performance.now();
  return {
    totalMs: completedAt - startedAt,
    queryMapAndSharedBuildMs: sharedBuildCompletedAt - startedAt,
    artifactAndSealMs: 0,
    redisStagingMs: stagingCompletedAt - sharedBuildCompletedAt,
    redisPromotionMs: completedAt - stagingCompletedAt,
  };
}

async function runFeaturePublication(
  epochId: number,
  sampleId: string
): Promise<PublicationTiming> {
  const startedAt = performance.now();
  const result = await db.query<FeatureRow>(
    `SELECT ps.post_uri, ps.total_score, p.author_did,
            ps.bridging_score, ps.engagement_score, p.embed_url,
            COALESCE(LENGTH(p.text), 0) AS text_length,
            p.created_at, ps.scored_at, ps.classification_method,
            ps.component_details->>'run_id' AS source_score_run_id,
            ps.recency_score, ps.source_diversity_score, ps.relevance_score,
            ps.recency_weight, ps.engagement_weight, ps.bridging_weight,
            ps.source_diversity_weight, ps.relevance_weight,
            ps.recency_weighted, ps.engagement_weighted, ps.bridging_weighted,
            ps.source_diversity_weighted, ps.relevance_weighted
     FROM post_scores ps
     INNER JOIN posts p ON p.uri = ps.post_uri AND p.created_at = ps.created_at
     WHERE ps.epoch_id = $1
       AND p.deleted = FALSE
       AND p.created_at > $3
       AND p.created_at <= NOW()
       AND ps.created_at > $3
       AND ps.relevance_score >= $4
       AND NULLIF(BTRIM(ps.component_details->>'run_id'), '') IS NOT NULL
       AND ps.classification_method IN ('keyword', 'embedding')
     ORDER BY ps.total_score DESC, p.created_at DESC, ps.post_uri ASC
     LIMIT $2`,
    [epochId, ROW_COUNT, cutoffTimestamp(), config.FEED_MIN_RELEVANCE]
  );
  const candidates: FeatureCandidate[] = result.rows.map((row) => {
    if (row.classification_method !== 'keyword' && row.classification_method !== 'embedding') {
      throw new TypeError(`Invalid classification method for ${row.post_uri}`);
    }
    if (row.source_score_run_id === null || row.source_score_run_id.length === 0) {
      throw new TypeError(`Missing source score run for ${row.post_uri}`);
    }
    const createdAt = new Date(row.created_at);
    const scoredAt = new Date(row.scored_at);
    const components: PublicFeedScoreComponents = {
      recency: {
        raw_score: numericValue(row.recency_score, `${row.post_uri} recency_score`),
        weight: numericValue(row.recency_weight, `${row.post_uri} recency_weight`),
        weighted: numericValue(row.recency_weighted, `${row.post_uri} recency_weighted`),
      },
      engagement: {
        raw_score: numericValue(row.engagement_score, `${row.post_uri} engagement_score`),
        weight: numericValue(row.engagement_weight, `${row.post_uri} engagement_weight`),
        weighted: numericValue(row.engagement_weighted, `${row.post_uri} engagement_weighted`),
      },
      bridging: {
        raw_score: numericValue(row.bridging_score, `${row.post_uri} bridging_score`),
        weight: numericValue(row.bridging_weight, `${row.post_uri} bridging_weight`),
        weighted: numericValue(row.bridging_weighted, `${row.post_uri} bridging_weighted`),
      },
      source_diversity: {
        raw_score: numericValue(row.source_diversity_score, `${row.post_uri} source_diversity_score`),
        weight: numericValue(row.source_diversity_weight, `${row.post_uri} source_diversity_weight`),
        weighted: numericValue(row.source_diversity_weighted, `${row.post_uri} source_diversity_weighted`),
      },
      relevance: {
        raw_score: numericValue(row.relevance_score, `${row.post_uri} relevance_score`),
        weight: numericValue(row.relevance_weight, `${row.post_uri} relevance_weight`),
        weighted: numericValue(row.relevance_weighted, `${row.post_uri} relevance_weighted`),
      },
    };
    return {
      post_uri: row.post_uri,
      total_score: numericValue(row.total_score, `${row.post_uri} total_score`),
      author_did: row.author_did,
      bridging_score: numericValue(row.bridging_score, `${row.post_uri} bridging_score`),
      engagement_score: numericValue(row.engagement_score, `${row.post_uri} engagement_score`),
      embed_url: row.embed_url,
      text_length: numericValue(row.text_length, `${row.post_uri} text_length`),
      created_at: createdAt.toISOString(),
      scored_at: scoredAt.toISOString(),
      classification_method: row.classification_method,
      source_score_run_id: row.source_score_run_id,
      components,
    };
  });
  const publication = applyFeedUrlDedup(
    candidates.map((candidate) => ({
      id: candidate.post_uri,
      score: candidate.total_score,
      embedUrl: candidate.embed_url,
      textLength: candidate.text_length,
      value: candidate,
      createdAt: candidate.created_at,
    })),
    {
      enabled: config.FEED_DEDUP_ENABLED,
      minimumOriginalTextLength: config.FEED_DEDUP_MIN_TEXT,
      decay: FEED_URL_DEDUP_DECAY,
    }
  );
  const topPosts = publication.entries.map((entry) => ({ ...entry.value, total_score: entry.score }));
  if (topPosts.length !== ROW_COUNT || !Number.isFinite(consumeSharedFeedStats(topPosts))) {
    throw new Error(`Feature publication expected ${ROW_COUNT} valid rows; received ${topPosts.length}`);
  }
  const sharedBuildCompletedAt = performance.now();
  const updatedAt = new Date().toISOString();
  const explanationCandidates: FeedPublicationExplanationCandidate[] = publication.entries.map((entry) => ({
    postUri: entry.value.post_uri,
    preAdjustmentPosition: entry.preAdjustmentPosition,
    createdAt: entry.value.created_at,
    baseScore: entry.baseScore,
    publicationAdjustment: entry.publicationAdjustment,
    finalScore: entry.score,
    sourceScoreRunId: entry.value.source_score_run_id,
    scoredAt: entry.value.scored_at,
    classificationMethod: entry.value.classification_method,
    components: entry.value.components,
  }));
  const artifact = buildFeedPublicationArtifact(
    {
      epochId,
      publicationRunId: sampleId,
      publishedAt: updatedAt,
      weights: ACTIVE_WEIGHTS,
      dedupedUrlCount: publication.dedupedUrlCount,
      totalUrlCount: publication.totalUrlCount,
    },
    explanationCandidates
  );
  const digest = digestFeedPublicationArtifact(artifact);
  const serializedWeights = JSON.stringify(ACTIVE_WEIGHTS);
  const currentMetadata = [
    epochId.toString(), sampleId, updatedAt, ROW_COUNT.toString(), '1', digest, serializedWeights,
  ];
  const lastKnownGoodMetadata = [...currentMetadata];
  const serializedExplanations = artifact.entries.map((entry) => ({
    postUri: entry.post_uri,
    serializedExplanation: JSON.stringify(entry),
  }));
  const sealedCurrentExplanations = serializedExplanations.map((explanation) => ({
    ...explanation,
    explanationSeal: sealFeedPublicationExplanation(
      currentMetadata,
      explanation.postUri,
      explanation.serializedExplanation
    ),
  }));
  const sealedLastKnownGoodExplanations = serializedExplanations.map((explanation) => ({
    ...explanation,
    explanationSeal: sealFeedPublicationExplanation(
      lastKnownGoodMetadata,
      explanation.postUri,
      explanation.serializedExplanation
    ),
  }));
  const metadata = [
    ...currentMetadata,
    ...lastKnownGoodMetadata,
    sealFeedPublicationStorage({ metadataValues: currentMetadata, entries: sealedCurrentExplanations }),
    sealFeedPublicationStorage({
      metadataValues: lastKnownGoodMetadata,
      entries: sealedLastKnownGoodExplanations,
    }),
  ];
  const currentExplanationSeals: string[] = [];
  const lastKnownGoodExplanationSeals: string[] = [];
  const explanationHashArguments: string[] = [];
  for (const [index, explanation] of serializedExplanations.entries()) {
    explanationHashArguments.push(explanation.postUri, explanation.serializedExplanation);
    currentExplanationSeals.push(
      explanation.postUri,
      sealedCurrentExplanations[index].explanationSeal
    );
    lastKnownGoodExplanationSeals.push(
      explanation.postUri,
      sealedLastKnownGoodExplanations[index].explanationSeal
    );
  }
  const artifactCompletedAt = performance.now();

  const prefix = `benchmark:feature:${sampleId}`;
  const stagedKeys = [
    `${prefix}:staged:current`,
    `${prefix}:staged:last-known-good`,
    `${prefix}:staged:order-current`,
    `${prefix}:staged:order-last-known-good`,
    `${prefix}:staged:explanations-current`,
    `${prefix}:staged:explanations-last-known-good`,
    `${prefix}:staged:explanation-seals-current`,
    `${prefix}:staged:explanation-seals-last-known-good`,
    ...Array.from({ length: metadata.length }, (_unused, index) => `${prefix}:staged:metadata:${index}`),
  ];
  const destinationKeys = [
    `${prefix}:current`,
    `${prefix}:last-known-good`,
    `${prefix}:order-current`,
    `${prefix}:order-last-known-good`,
    `${prefix}:explanations-current`,
    `${prefix}:explanations-last-known-good`,
    `${prefix}:explanation-seals-current`,
    `${prefix}:explanation-seals-last-known-good`,
    ...Array.from({ length: metadata.length }, (_unused, index) => `${prefix}:metadata:${index}`),
  ];
  const zaddArguments: Array<string | number> = [];
  const orderedUris: string[] = [];
  for (const entry of publication.entries) {
    zaddArguments.push(entry.score, entry.value.post_uri);
    orderedUris.push(entry.value.post_uri);
  }
  const transaction = redis.multi();
  transaction.del(...stagedKeys);
  transaction.zadd(stagedKeys[0], ...zaddArguments);
  transaction.zadd(stagedKeys[1], ...zaddArguments);
  transaction.rpush(stagedKeys[2], ...orderedUris);
  transaction.rpush(stagedKeys[3], ...orderedUris);
  transaction.hset(stagedKeys[4], ...explanationHashArguments);
  transaction.hset(stagedKeys[5], ...explanationHashArguments);
  transaction.hset(stagedKeys[6], ...currentExplanationSeals);
  transaction.hset(stagedKeys[7], ...lastKnownGoodExplanationSeals);
  for (let index = 0; index < metadata.length; index += 1) {
    transaction.set(stagedKeys[index + 8], metadata[index]);
  }
  for (const key of stagedKeys) {
    transaction.expire(key, STAGING_TTL_SECONDS);
  }
  assertTransactionSucceeded(await transaction.exec(), 'feature staging');
  const stagingCompletedAt = performance.now();
  const promoted = await redis.eval(
    __PUBLISH_STAGED_FEED_SCRIPT_FOR_TESTS,
    stagedKeys.length + destinationKeys.length + 2,
    ...stagedKeys,
    ...destinationKeys,
    `${prefix}:snapshot-generation`,
    `${prefix}:snapshot-current`,
    stagedKeys.length.toString()
  );
  if (promoted !== 1) {
    throw new Error(`Feature promotion returned ${String(promoted)}`);
  }
  const completedAt = performance.now();
  return {
    totalMs: completedAt - startedAt,
    queryMapAndSharedBuildMs: sharedBuildCompletedAt - startedAt,
    artifactAndSealMs: artifactCompletedAt - sharedBuildCompletedAt,
    redisStagingMs: stagingCompletedAt - artifactCompletedAt,
    redisPromotionMs: completedAt - stagingCompletedAt,
  };
}

function percentile95(samples: readonly number[]): number {
  if (samples.length === 0) {
    throw new RangeError('Cannot calculate p95 for an empty sample');
  }
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

describe('Transparency publication real-datastore A/B benchmark', () => {
  let epochId: number;

  beforeAll(async () => {
    await resetHarnessData();
    epochId = await seedBenchmarkRows();
  });

  afterAll(async () => {
    const benchmarkKeys = await redis.keys('benchmark:*');
    if (benchmarkKeys.length > 0) {
      await redis.del(...benchmarkKeys);
    }
    await resetHarnessData();
  });

  it('keeps 1,000-row publication p95 within its absolute latency and scoring-timeout budgets', async () => {
    const baselineTimings: PublicationTiming[] = [];
    const featureTimings: PublicationTiming[] = [];
    const pairCount = WARMUP_PAIRS + MEASURED_PAIRS;

    for (let index = 0; index < pairCount; index += 1) {
      const baselineFirst = index % 2 === 0;
      const baselineId = `baseline-${index}`;
      const featureId = `feature-${index}`;
      let baselineTiming: PublicationTiming;
      let featureTiming: PublicationTiming;
      if (baselineFirst) {
        baselineTiming = await runBaselinePublication(epochId, baselineId);
        featureTiming = await runFeaturePublication(epochId, featureId);
      } else {
        featureTiming = await runFeaturePublication(epochId, featureId);
        baselineTiming = await runBaselinePublication(epochId, baselineId);
      }
      if (index >= WARMUP_PAIRS) {
        baselineTimings.push(baselineTiming);
        featureTimings.push(featureTiming);
      }
    }

    const baselineP95Ms = percentile95(baselineTimings.map((timing) => timing.totalMs));
    const featureP95Ms = percentile95(featureTimings.map((timing) => timing.totalMs));
    const overheadPercent = ((featureP95Ms - baselineP95Ms) / baselineP95Ms) * 100;
    const scoringTimeoutBudgetMs = config.SCORING_TIMEOUT_MS * MAX_SCORING_TIMEOUT_SHARE;
    const passed =
      featureP95Ms <= MAX_PUBLICATION_P95_MS && featureP95Ms <= scoringTimeoutBudgetMs;
    const phases = {
      baseline_query_map_shared_p95_ms: percentile95(
        baselineTimings.map((timing) => timing.queryMapAndSharedBuildMs)
      ),
      feature_query_map_shared_p95_ms: percentile95(
        featureTimings.map((timing) => timing.queryMapAndSharedBuildMs)
      ),
      feature_artifact_seals_p95_ms: percentile95(
        featureTimings.map((timing) => timing.artifactAndSealMs)
      ),
      baseline_redis_staging_p95_ms: percentile95(
        baselineTimings.map((timing) => timing.redisStagingMs)
      ),
      feature_redis_staging_p95_ms: percentile95(
        featureTimings.map((timing) => timing.redisStagingMs)
      ),
      baseline_redis_promotion_p95_ms: percentile95(
        baselineTimings.map((timing) => timing.redisPromotionMs)
      ),
      feature_redis_promotion_p95_ms: percentile95(
        featureTimings.map((timing) => timing.redisPromotionMs)
      ),
    };
    console.info(JSON.stringify({
      gate: 'transparency_publication_real_ab_1000_rows',
      measured_pairs: MEASURED_PAIRS,
      baseline_p95_ms: Number(baselineP95Ms.toFixed(2)),
      feature_p95_ms: Number(featureP95Ms.toFixed(2)),
      overhead_percent: Number(overheadPercent.toFixed(2)),
      phases: Object.fromEntries(
        Object.entries(phases).map(([key, value]) => [key, Number(value.toFixed(2))])
      ),
      target_publication_p95_ms: MAX_PUBLICATION_P95_MS,
      target_scoring_timeout_share_percent: MAX_SCORING_TIMEOUT_SHARE * 100,
      scoring_timeout_budget_ms: scoringTimeoutBudgetMs,
      passed,
    }));

    expect(featureP95Ms).toBeLessThanOrEqual(MAX_PUBLICATION_P95_MS);
    expect(featureP95Ms).toBeLessThanOrEqual(scoringTimeoutBudgetMs);
  });
});
