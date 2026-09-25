/**
 * Scoring Pipeline — Long-Table Dual-Write Tests (PROJ-814 / P1)
 *
 * Verifies that storeScore() dual-writes the per-component decomposition into
 * post_score_components (migration 021) in addition to the existing 15-column
 * wide row in post_scores, gated by SCORE_LONGTABLE_DUALWRITE_ENABLED.
 *
 * Wide-row behavior is exhaustively covered by scoring-pipeline-rescore.test.ts;
 * this file focuses on the new long-table side.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  dbQueryMock,
  dbConnectMock,
  clientQueryMock,
  clientReleaseMock,
  redisPipelineFactoryMock,
  pipelineDelMock,
  pipelineZaddMock,
  pipelineSetMock,
  pipelineExecMock,
  getCurrentContentRulesMock,
  hasActiveContentRulesMock,
  updateScoringStatusMock,
  loggerErrorMock,
  configMock,
} = vi.hoisted(() => ({
  dbQueryMock: vi.fn(),
  dbConnectMock: vi.fn(),
  clientQueryMock: vi.fn(),
  clientReleaseMock: vi.fn(),
  redisPipelineFactoryMock: vi.fn(),
  pipelineDelMock: vi.fn(),
  pipelineZaddMock: vi.fn(),
  pipelineSetMock: vi.fn(),
  pipelineExecMock: vi.fn(),
  getCurrentContentRulesMock: vi.fn(),
  hasActiveContentRulesMock: vi.fn(),
  updateScoringStatusMock: vi.fn(),
  loggerErrorMock: vi.fn(),
  configMock: {
    SCORING_WINDOW_HOURS: 48,
    FEED_MAX_POSTS: 300,
    SCORING_FULL_RESCORE_INTERVAL: 6,
    SCORING_CANDIDATE_LIMIT: 5000,
    SCORING_TIMEOUT_MS: 240000,
    SCORING_CONCURRENCY: 8,
    TOPIC_EMBEDDING_ENABLED: false,
    TOPIC_EMBEDDING_MIN_SIMILARITY: 0.35,
    FEED_MIN_RELEVANCE: 0,
    FEED_DEDUP_ENABLED: false,
    FEED_DEDUP_MIN_TEXT: 100,
    SCORE_LONGTABLE_DUALWRITE_ENABLED: true,
  },
}));

vi.mock('../src/db/client.js', () => ({
  db: { query: dbQueryMock, connect: dbConnectMock },
}));

vi.mock('../src/db/redis.js', () => ({
  redis: {
    pipeline: redisPipelineFactoryMock,
    multi: redisPipelineFactoryMock,
    incr: vi.fn().mockResolvedValue(1),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    eval: vi.fn().mockResolvedValue(1),
  },
}));

vi.mock('../src/governance/content-filter.js', () => ({
  getCurrentContentRules: getCurrentContentRulesMock,
  hasActiveContentRules: hasActiveContentRulesMock,
  filterPosts: vi.fn(),
}));

vi.mock('../src/admin/status-tracker.js', () => ({
  updateScoringStatus: updateScoringStatusMock,
}));

vi.mock('../src/config.js', () => ({
  config: configMock,
}));

vi.mock('../src/lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: loggerErrorMock,
    debug: vi.fn(),
  },
}));

import { runScoringPipeline, __resetPipelineState } from '../src/scoring/pipeline.js';
import { buildEpochRow, buildPostRow } from './helpers/index.js';

function setupDefaultMocks() {
  const pipeline = {
    del: pipelineDelMock.mockReturnThis(),
    expire: vi.fn().mockReturnThis(),
    zadd: pipelineZaddMock.mockReturnThis(),
    set: pipelineSetMock.mockReturnThis(),
    exec: pipelineExecMock.mockResolvedValue([]),
  };
  redisPipelineFactoryMock.mockReturnValue(pipeline);
  clientQueryMock.mockImplementation((sql: string) => {
    if (sql.includes('pending_rescore_generation')) {
      return Promise.resolve({ rows: [{ pending_rescore_generation: null }] });
    }
    return Promise.resolve({ rows: [] });
  });
  dbConnectMock.mockResolvedValue({ query: clientQueryMock, release: clientReleaseMock });

  getCurrentContentRulesMock.mockResolvedValue({
    includeKeywords: [],
    excludeKeywords: [],
  });
  hasActiveContentRulesMock.mockReturnValue(false);
  updateScoringStatusMock.mockResolvedValue(undefined);
}

/** Find a db.query call by an SQL substring; helper used by the assertions below. */
function findCall(needle: string): unknown[] | undefined {
  return [...dbQueryMock.mock.calls, ...clientQueryMock.mock.calls].find(
    (c: unknown[]) => String(c[0]).includes(needle)
  );
}

function findCalls(needle: string): unknown[][] {
  return [...dbQueryMock.mock.calls, ...clientQueryMock.mock.calls].filter(
    (c: unknown[]) => String(c[0]).includes(needle)
  );
}

describe('scoring pipeline long-table dual-write (PROJ-814)', () => {
  beforeEach(() => {
    __resetPipelineState();
    vi.clearAllMocks();
    // Clear queued one-shot query results too. Changes in pipeline query
    // routing can leave an old response queued and shift every later fixture.
    dbQueryMock.mockReset();
    clientQueryMock.mockReset();
    configMock.SCORE_LONGTABLE_DUALWRITE_ENABLED = true;
    setupDefaultMocks();
  });

  it('writes both wide-row post_scores and long-table post_score_components when flag is on', async () => {
    const postRow = buildPostRow({ uri: 'at://did:plc:test/post/dualwrite' });

    dbQueryMock
      .mockResolvedValueOnce({ rows: [buildEpochRow({ id: 1 })] }) // getActiveEpoch
      .mockResolvedValueOnce({ rows: [postRow] })                   // getPostsForScoring
      .mockResolvedValueOnce({ rows: [] })                          // bridging engager
      .mockResolvedValueOnce({ rows: [] })                          // INSERT INTO post_scores
      .mockResolvedValueOnce({ rows: [] })                          // INSERT INTO post_score_components
      .mockResolvedValueOnce({ rows: [] })                          // writeToRedisFromDb
      .mockResolvedValueOnce({ rows: [] });                         // updateCurrentRunScope

    await runScoringPipeline();

    const wideCall = findCall('INSERT INTO post_scores');
    const longCall = findCall('INSERT INTO post_score_components');

    expect(wideCall).toBeDefined();
    expect(longCall).toBeDefined();
  });

  it('writes one long-table row per registered scoring component (5 by default)', async () => {
    const postRow = buildPostRow({ uri: 'at://did:plc:test/post/n-components' });

    dbQueryMock
      .mockResolvedValueOnce({ rows: [buildEpochRow({ id: 1 })] })
      .mockResolvedValueOnce({ rows: [postRow] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await runScoringPipeline();

    const longCall = findCall('INSERT INTO post_score_components');
    expect(longCall).toBeDefined();

    // Params layout: 7 columns × N components (PROJ-917 added created_at, the
    // partition key, bound per row). Default registry → 5 components → 35 params.
    const params = longCall![1] as unknown[];
    expect(params.length).toBe(5 * 7);

    // Verify the component_key column is the 3rd of each 7-tuple and matches the
    // registry order in DEFAULT_COMPONENTS.
    const componentKeys = [params[2], params[9], params[16], params[23], params[30]];
    expect(componentKeys).toEqual([
      'recency',
      'engagement',
      'bridging',
      'sourceDiversity',
      'relevance',
    ]);

    // created_at (7th of each tuple) is bound directly from the scored post, not
    // re-looked-up via `(SELECT created_at FROM posts WHERE uri = ...)` — that
    // subquery is unsafe once uri stops being unique on its own.
    const sql = String(longCall![0]);
    expect(sql).not.toMatch(/SELECT created_at FROM posts/);
    for (const idx of [6, 13, 20, 27, 34]) {
      expect(params[idx]).toBeInstanceOf(Date);
    }
  });

  it('skips the long-table write when flag is off', async () => {
    configMock.SCORE_LONGTABLE_DUALWRITE_ENABLED = false;
    const postRow = buildPostRow({ uri: 'at://did:plc:test/post/flag-off' });

    dbQueryMock
      .mockResolvedValueOnce({ rows: [buildEpochRow({ id: 1 })] })
      .mockResolvedValueOnce({ rows: [postRow] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await runScoringPipeline();

    expect(findCall('INSERT INTO post_scores')).toBeDefined();
    expect(findCall('INSERT INTO post_score_components')).toBeUndefined();
  });

  it('uses ON CONFLICT DO UPDATE for idempotency on rescore', async () => {
    const postRow = buildPostRow({ uri: 'at://did:plc:test/post/rescore' });

    dbQueryMock
      .mockResolvedValueOnce({ rows: [buildEpochRow({ id: 1 })] })
      .mockResolvedValueOnce({ rows: [postRow] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await runScoringPipeline();

    const longCall = findCall('INSERT INTO post_score_components');
    expect(longCall).toBeDefined();

    const sql = String(longCall![0]);
    // PROJ-917: post_score_components' PK widened to include created_at
    // (the partition key) — see migration 029.
    expect(sql).toMatch(
      /ON CONFLICT \(post_uri, epoch_id, component_key, created_at\) DO UPDATE SET/
    );
    // Update clause must refresh all three numeric columns plus scored_at.
    expect(sql).toMatch(/raw = EXCLUDED\.raw/);
    expect(sql).toMatch(/weight = EXCLUDED\.weight/);
    expect(sql).toMatch(/weighted = EXCLUDED\.weighted/);
    expect(sql).toMatch(/scored_at = NOW\(\)/);
  });

  it('skips the long-table write when there are no candidate posts to score', async () => {
    // No posts in the scoring window → storeScore is never called → no
    // long-table INSERT, even though the dual-write flag is on.
    dbQueryMock
      .mockResolvedValueOnce({ rows: [buildEpochRow({ id: 1 })] }) // getActiveEpoch
      .mockResolvedValueOnce({ rows: [] })                          // getPostsForScoring (empty)
      .mockResolvedValueOnce({ rows: [] })                          // writeToRedisFromDb
      .mockResolvedValueOnce({ rows: [] });                         // updateCurrentRunScope

    await runScoringPipeline();

    expect(findCall('INSERT INTO post_scores')).toBeUndefined();
    expect(findCall('INSERT INTO post_score_components')).toBeUndefined();
  });

  it('issues exactly one long-table INSERT per scored post', async () => {
    // Score 3 posts; expect 3 wide-INSERT calls and 3 long-INSERT calls
    // (one batched VALUES INSERT per post, each carrying N component rows).
    const postRows = [
      buildPostRow({ uri: 'at://did:plc:test/post/count-1' }),
      buildPostRow({ uri: 'at://did:plc:test/post/count-2' }),
      buildPostRow({ uri: 'at://did:plc:test/post/count-3' }),
    ];

    dbQueryMock
      .mockResolvedValueOnce({ rows: [buildEpochRow({ id: 1 })] }) // getActiveEpoch
      .mockResolvedValueOnce({ rows: postRows })                    // getPostsForScoring
      // For each post: bridging engager query, wide INSERT, long INSERT.
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      // writeToRedisFromDb + updateCurrentRunScope
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await runScoringPipeline();

    const wideCount = findCalls('INSERT INTO post_scores').length;
    const longCount = findCalls('INSERT INTO post_score_components').length;

    expect(wideCount).toBe(3);
    expect(longCount).toBe(3);
  });

  it('continues the scoring loop when the long-table INSERT throws', async () => {
    // Long-table failure must not crash the pipeline. The wide row should have
    // been written for the failing post (storeScore writes wide first), and
    // subsequent posts should still process. This is the documented eventual-
    // consistency contract: backfill or the next cycle converges the gap.
    const failPost = buildPostRow({ uri: 'at://did:plc:test/post/long-fails' });
    const okPost = buildPostRow({ uri: 'at://did:plc:test/post/long-ok' });

    dbQueryMock.mockImplementation(async (sql: unknown, _params?: unknown[]) => {
      const text = String(sql);
      if (text.includes('FROM governance_epochs') || text.includes('WHERE status')) {
        return { rows: [buildEpochRow({ id: 1 })] };
      }
      if (text.includes('FROM posts p') && text.includes('LEFT JOIN post_engagement')) {
        return { rows: [failPost, okPost] };
      }
      if (text.includes('INSERT INTO post_score_components')) {
        // Fail only the first long-table write; succeed on the second.
        const longCount = dbQueryMock.mock.calls.filter((c: unknown[]) =>
          String(c[0]).includes('INSERT INTO post_score_components')
        ).length;
        if (longCount === 1) {
          throw new Error('simulated long-table INSERT failure');
        }
        return { rows: [] };
      }
      return { rows: [] };
    });
    clientQueryMock.mockImplementation(async (sql: unknown) => {
      const text = String(sql);
      if (text.includes('pending_rescore_generation')) {
        return { rows: [{ pending_rescore_generation: null }] };
      }
      if (text.includes('INSERT INTO post_score_components')) {
        // Fail only the first long-table write; succeed on the second.
        const longCount = clientQueryMock.mock.calls.filter((c: unknown[]) =>
          String(c[0]).includes('INSERT INTO post_score_components')
        ).length;
        if (longCount === 1) {
          throw new Error('simulated long-table INSERT failure');
        }
      }
      return { rows: [] };
    });

    await expect(runScoringPipeline()).resolves.toBeUndefined();

    // Both posts should have had a wide-row INSERT attempted.
    const wideInserts = findCalls('INSERT INTO post_scores');
    expect(wideInserts.length).toBe(2);

    // Both long-table INSERT attempts happen; one threw, the loop continued.
    const longInserts = findCalls('INSERT INTO post_score_components');
    expect(longInserts.length).toBe(2);

    // Error-logging contract: scoreAllPosts logs each scoring failure via
    // logger.error (see pipeline.ts "Failed to score post"). Lock in that the
    // simulated long-table failure produced exactly one such error log so a
    // future refactor that swallows the log silently is caught here.
    const failureLogs = loggerErrorMock.mock.calls.filter((call: unknown[]) => {
      const arg = call[0] as { err?: unknown } | undefined;
      return (
        arg !== undefined &&
        typeof arg === 'object' &&
        'err' in arg &&
        String(call[1]).includes('Failed to score post')
      );
    });
    expect(failureLogs.length).toBe(1);
  });
});
