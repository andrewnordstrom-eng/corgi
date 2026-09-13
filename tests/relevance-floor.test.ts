/**
 * Relevance Floor Tests
 *
 * Tests the relevance floor in writeToRedisFromDb.
 * Posts with relevance_score below FEED_MIN_RELEVANCE are excluded
 * from the Redis feed sorted set.
 *
 * Uses the pipeline mock pattern from pipeline-empty-feed.test.ts.
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
  filterPostsMock,
  updateScoringStatusMock,
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
  filterPostsMock: vi.fn(),
  updateScoringStatusMock: vi.fn(),
}));

vi.mock('../src/db/client.js', () => ({
  db: {
    query: dbQueryMock,
    connect: dbConnectMock,
  },
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
  filterPosts: filterPostsMock,
}));

vi.mock('../src/admin/status-tracker.js', () => ({
  updateScoringStatus: updateScoringStatusMock,
}));

import { runScoringPipeline, __resetPipelineState } from '../src/scoring/pipeline.js';
import { buildFeedPublicationRow } from './helpers/feed-publication.js';

function makeEpochRow() {
  return {
    id: 2,
    status: 'active',
    recency_weight: 0.2,
    engagement_weight: 0.2,
    bridging_weight: 0.2,
    source_diversity_weight: 0.2,
    relevance_weight: 0.2,
    vote_count: 10,
    created_at: new Date().toISOString(),
    closed_at: null,
    description: 'test epoch',
  };
}

/** Helper: find the writeToRedisFromDb call by looking for the SELECT post_uri query. */
function findWriteToRedisCall(): [string, unknown[]] | null {
  for (const call of dbQueryMock.mock.calls) {
    const queryText = String(call[0]);
    if (queryText.includes('SELECT ps.post_uri') && queryText.includes('post_scores')) {
      return [queryText, call[1] as unknown[]];
    }
  }
  return null;
}

describe('relevance floor in feed output', () => {
  beforeEach(() => {
    __resetPipelineState();
    dbQueryMock.mockReset();
    dbConnectMock.mockReset();
    clientQueryMock.mockReset();
    clientReleaseMock.mockReset();
    redisPipelineFactoryMock.mockReset();
    pipelineDelMock.mockReset();
    pipelineZaddMock.mockReset();
    pipelineSetMock.mockReset();
    pipelineExecMock.mockReset();
    getCurrentContentRulesMock.mockReset();
    hasActiveContentRulesMock.mockReset();
    filterPostsMock.mockReset();
    updateScoringStatusMock.mockReset();

    const pipeline = {
      del: pipelineDelMock.mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      zadd: pipelineZaddMock.mockReturnThis(),
      rpush: vi.fn().mockReturnThis(),
      hset: vi.fn().mockReturnThis(),
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
  });

  it('SQL query contains relevance_score >= parameter', async () => {
    // No posts → pipeline skips scoring, goes straight to writeToRedisFromDb
    dbQueryMock
      .mockResolvedValueOnce({ rows: [makeEpochRow()] })   // getActiveEpoch
      .mockResolvedValueOnce({ rows: [] })                   // getPostsForScoring
      .mockResolvedValueOnce({ rows: [] })                   // writeToRedisFromDb
      .mockResolvedValueOnce({ rows: [] });                  // updateCurrentRunScope

    await runScoringPipeline();

    const writeCall = findWriteToRedisCall();
    expect(writeCall).not.toBeNull();
    expect(writeCall![0]).toContain('relevance_score >= $');
  });

  it('FEED_MIN_RELEVANCE config value is passed as query parameter', async () => {
    dbQueryMock
      .mockResolvedValueOnce({ rows: [makeEpochRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await runScoringPipeline();

    const writeCall = findWriteToRedisCall();
    expect(writeCall).not.toBeNull();
    const queryParams = writeCall![1];
    // 4th parameter should be FEED_MIN_RELEVANCE (default 0.15)
    expect(queryParams.length).toBe(4);
    expect(queryParams[3]).toBe(0.15);
  });

  it('excludes posts with relevance_score below floor (verified via SQL clause)', async () => {
    dbQueryMock
      .mockResolvedValueOnce({ rows: [makeEpochRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await runScoringPipeline();

    const writeCall = findWriteToRedisCall();
    expect(writeCall).not.toBeNull();
    // SQL has the exact clause
    expect(writeCall![0]).toContain('relevance_score >= $4');
    // Parameter matches FEED_MIN_RELEVANCE default
    expect(writeCall![1][3]).toBe(0.15);
  });

  it('preserves the served feed when no posts pass floor', async () => {
    // No posts to score → writeToRedisFromDb returns empty
    dbQueryMock
      .mockResolvedValueOnce({ rows: [makeEpochRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await runScoringPipeline();

    expect(redisPipelineFactoryMock).not.toHaveBeenCalled();
    expect(pipelineZaddMock).not.toHaveBeenCalled();
  });

  it('includes posts returned by DB query in Redis feed', async () => {
    const feedPosts = [
      buildFeedPublicationRow({ post_uri: 'at://did:plc:test/post/high', total_score: 0.85 }),
    ];

    // No posts to score, but writeToRedisFromDb returns 1 post
    dbQueryMock
      .mockResolvedValueOnce({ rows: [makeEpochRow()] })
      .mockResolvedValueOnce({ rows: [] })                     // no posts to score
      .mockResolvedValueOnce({ rows: feedPosts })               // writeToRedisFromDb
      .mockResolvedValueOnce({ rows: [] });

    await runScoringPipeline();

    expect(pipelineZaddMock).toHaveBeenCalledWith(
      expect.stringMatching(/^feed:staging:current:/),
      0.85,
      'at://did:plc:test/post/high'
    );
    expect(pipelineSetMock).toHaveBeenCalledWith(
      expect.stringMatching(/^feed:staging:metadata:.*:3$/),
      '1'
    );
  });

  it('writes correct metadata count for multiple posts', async () => {
    const feedPosts = [
      buildFeedPublicationRow({ post_uri: 'at://post/1', total_score: 0.9 }),
      buildFeedPublicationRow({ post_uri: 'at://post/2', total_score: 0.7 }),
    ];

    dbQueryMock
      .mockResolvedValueOnce({ rows: [makeEpochRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: feedPosts })
      .mockResolvedValueOnce({ rows: [] });

    await runScoringPipeline();

    expect(pipelineSetMock).toHaveBeenCalledWith(
      expect.stringMatching(/^feed:staging:metadata:.*:3$/),
      '2'
    );
    expect(pipelineZaddMock).toHaveBeenCalledTimes(2);
    expect(pipelineZaddMock).toHaveBeenCalledWith(
      expect.stringMatching(/^feed:staging:current:/),
      0.9,
      'at://post/1',
      0.7,
      'at://post/2'
    );
  });

  it('epoch ID is passed as first parameter to writeToRedisFromDb query', async () => {
    dbQueryMock
      .mockResolvedValueOnce({ rows: [makeEpochRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await runScoringPipeline();

    const writeCall = findWriteToRedisCall();
    expect(writeCall).not.toBeNull();
    // First param is epoch ID
    expect(writeCall![1][0]).toBe(2);
  });
});
