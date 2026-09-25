/**
 * Real PostgreSQL + Redis A/B benchmark for the publication transparency work.
 *
 * Baseline mirrors origin/main's pre-feature publisher: narrow projection,
 * URL dedup, two staged zsets, seven staged metadata values, atomic rename,
 * then snapshot invalidation. Feature invokes the exact production publication and SQL-finalization stages.
 * Baseline is diagnostic only, not execution of the old published commit.
 */

import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { db } from '../../src/db/client.js';
import { redis } from '../../src/db/redis.js';
import {
  applyFeedUrlDedup,
  FEED_URL_DEDUP_DECAY,
  type PublicFeedWeights,
} from '../../src/scoring/feed-publication.js';
import { __PUBLICATION_STAGES_FOR_TESTS, __resetPipelineState } from '../../src/scoring/pipeline.js';
import { updateScoringStatus } from '../../src/admin/status-tracker.js';
import { CURRENT_FEED_PUBLICATION_KEYS, LAST_KNOWN_GOOD_FEED_PUBLICATION_KEYS } from '../../src/scoring/feed-publication-keys.js';
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

interface PublicationCandidate {
  post_uri: string;
  total_score: number;
  author_did: string;
  bridging_score: number;
  engagement_score: number;
  embed_url: string | null;
  text_length: number;
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

interface FeatureTiming {
  totalMs: number;
  publicationMs: number;
  sqlFinalizationMs: number;
}

async function assertPublication(runId: string): Promise<void> {
  for (const keys of [CURRENT_FEED_PUBLICATION_KEYS, LAST_KNOWN_GOOD_FEED_PUBLICATION_KEYS]) {
    expect(await redis.get(keys.metadata.publicationRunId)).toBe(runId);
    const order = await redis.lrange(keys.order, 0, -1);
    expect(order).toHaveLength(ROW_COUNT);
    expect(await redis.zcard(keys.sortedSet)).toBe(ROW_COUNT);
    expect(await redis.hlen(keys.explanations)).toBe(ROW_COUNT);
    expect(await redis.hlen(keys.explanationSeals)).toBe(ROW_COUNT);
    const explanations = await redis.hgetall(keys.explanations);
    const scores = await redis.zrevrange(keys.sortedSet, 0, -1, 'WITHSCORES');
    expect(order).toEqual(scores.filter((_value, index) => index % 2 === 0));
    for (const [index, uri] of order.entries()) {
      expect(uri).toBe(`at://did:plc:publisherbenchmark/app.bsky.feed.post/${String(index + 1).padStart(4, '0')}`);
      const entry = JSON.parse(explanations[uri]) as {
        final_score: number; publication_adjustment: number;
        components: Record<string, { weighted: number }>;
      };
      expect(entry.final_score).toBeCloseTo(Number(scores[index * 2 + 1]), 12);
      const componentSum = Object.values(entry.components).reduce((sum, component) => sum + component.weighted, 0);
      expect(componentSum * entry.publication_adjustment).toBeCloseTo(entry.final_score, 12);
    }
  }
  const scope = await db.query<{ value: { run_id: string } }>(
    "SELECT value FROM system_status WHERE key = 'current_scoring_run'"
  );
  expect(scope.rows[0]?.value.run_id).toBe(runId);
  const metrics = await db.query<{ run_id: string; posts_scored: number }>(
    'SELECT run_id, posts_scored FROM epoch_metrics WHERE run_id = $1', [runId]
  );
  expect(metrics.rows).toHaveLength(1);
  expect(Number(metrics.rows[0].posts_scored)).toBe(ROW_COUNT);
}

async function runFeaturePublication(epochId: number, sampleId: string): Promise<FeatureTiming> {
  const startedAt = performance.now();
  const publication = await __PUBLICATION_STAGES_FOR_TESTS.publishScoringRunWithFence({
    epochId, runId: sampleId, durableRescoreGeneration: null,
    requestedFullRescoreGeneration: 0, currentRunOnly: false, expectedWeights: ACTIVE_WEIGHTS,
  });
  const publishedAt = performance.now();
  if (!publication.published || publication.feedStatsSnapshot === null) {
    throw new Error(`Production publication did not publish ${sampleId}`);
  }
  await updateScoringStatus({
    timestamp: new Date().toISOString(), duration_ms: publishedAt - startedAt,
    posts_scored: ROW_COUNT, posts_filtered: 0,
  });
  await __PUBLICATION_STAGES_FOR_TESTS.updateEpochMetrics(epochId, sampleId, publication.feedStatsSnapshot);
  await __PUBLICATION_STAGES_FOR_TESTS.updateCurrentRunScope(sampleId, epochId, publishedAt - startedAt, ROW_COUNT, 0);
  const completedAt = performance.now();
  return { totalMs: completedAt - startedAt, publicationMs: publishedAt - startedAt, sqlFinalizationMs: completedAt - publishedAt };
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
    __resetPipelineState();
    epochId = await seedBenchmarkRows();
    await runFeaturePublication(epochId, "feature-initial");
    await assertPublication("feature-initial");
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
    const featureTimings: FeatureTiming[] = [];
    let previousFeatureId = "feature-initial";
    const pairCount = WARMUP_PAIRS + MEASURED_PAIRS;

    for (let index = 0; index < pairCount; index += 1) {
      const baselineFirst = index % 2 === 0;
      const baselineId = `baseline-${index}`;
      const featureId = `feature-${index}`;
      let baselineTiming: PublicationTiming;
      let featureTiming: FeatureTiming;
      await assertPublication(previousFeatureId);
      if (baselineFirst) {
        baselineTiming = await runBaselinePublication(epochId, baselineId);
        featureTiming = await runFeaturePublication(epochId, featureId);
      } else {
        featureTiming = await runFeaturePublication(epochId, featureId);
        baselineTiming = await runBaselinePublication(epochId, baselineId);
      }
      await assertPublication(featureId);
      previousFeatureId = featureId;
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
      actual_production_publication_p95_ms: percentile95(featureTimings.map((timing) => timing.publicationMs)),
      actual_sql_finalization_p95_ms: percentile95(featureTimings.map((timing) => timing.sqlFinalizationMs)),
    };
    console.info(JSON.stringify({
      gate: 'transparency_publication_actual_B_1000_rows',
      baseline_scope: 'diagnostic old-publisher mirror only',
      feature_scope: 'actual production fenced publication plus status/metrics/current-scope SQL finalization',
      prior_current_and_lkg_rows: ROW_COUNT,
      warmup_pairs: WARMUP_PAIRS,
      baseline_samples: baselineTimings,
      feature_samples: featureTimings,
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
