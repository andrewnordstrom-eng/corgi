/**
 * URL Deduplication Tests
 *
 * Tests that writeToRedisFromDb applies a decay multiplier to posts
 * sharing the same external embed URL, while preserving posts with
 * substantial original commentary.
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
  pipelineHsetMock,
  pipelineSetMock,
  pipelineExecMock,
  getCurrentContentRulesMock,
  hasActiveContentRulesMock,
  updateScoringStatusMock,
} = vi.hoisted(() => ({
  dbQueryMock: vi.fn(),
  dbConnectMock: vi.fn(),
  clientQueryMock: vi.fn(),
  clientReleaseMock: vi.fn(),
  redisPipelineFactoryMock: vi.fn(),
  pipelineDelMock: vi.fn(),
  pipelineZaddMock: vi.fn(),
  pipelineHsetMock: vi.fn(),
  pipelineSetMock: vi.fn(),
  pipelineExecMock: vi.fn(),
  getCurrentContentRulesMock: vi.fn(),
  hasActiveContentRulesMock: vi.fn(),
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
  filterPosts: vi.fn(),
}));

vi.mock('../src/admin/status-tracker.js', () => ({
  updateScoringStatus: updateScoringStatusMock,
}));

import {
  runScoringPipeline,
  __resetPipelineState,
} from '../src/scoring/pipeline.js';
import type { FeedPublicationDatabaseRow } from '../src/scoring/pipeline.js';
import { config } from '../src/config.js';
import { buildEpochRow } from './helpers/index.js';
import { buildFeedPublicationRow } from './helpers/feed-publication.js';

function makeEpochRow(id = 2) {
  return buildEpochRow({ id });
}

function setupDefaultMocks() {
  const pipeline = {
    del: pipelineDelMock.mockReturnThis(),
    expire: vi.fn().mockReturnThis(),
    zadd: pipelineZaddMock.mockReturnThis(),
    rpush: vi.fn().mockReturnThis(),
    hset: pipelineHsetMock.mockReturnThis(),
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

/**
 * Run a pipeline cycle with specific writeToRedisFromDb results.
 * The pipeline makes these DB calls:
 *   0: getActiveEpoch
 *   1: getPostsForScoring (full mode, first run)
 *   2: writeToRedisFromDb SELECT
 *   3: updateCurrentRunScope
 *
 * @param feedRows - rows returned by the writeToRedisFromDb query
 */
interface FeedRowInput {
  post_uri: string;
  total_score: number;
  embed_url: string | null;
  text_length: number;
}

function completeFeedRow(row: FeedRowInput, index: number): FeedPublicationDatabaseRow {
  return buildFeedPublicationRow({
    ...row,
    author_did: `did:plc:test-${index}`,
    created_at: new Date(Date.UTC(2026, 8, 2, 20, 0, 0) - index * 1_000).toISOString(),
    scored_at: '2026-09-02T20:01:00.000Z',
    source_score_run_id: 'score-run-test',
  });
}

async function runWithFeedRows(feedRows: FeedRowInput[]) {
  const completeRows = feedRows.map(completeFeedRow);
  dbQueryMock
    .mockResolvedValueOnce({ rows: [makeEpochRow()] })  // getActiveEpoch
    .mockResolvedValueOnce({ rows: [] })                  // getPostsForScoring (no posts to score)
    .mockResolvedValueOnce({ rows: completeRows })        // writeToRedisFromDb SELECT
    .mockResolvedValueOnce({ rows: [] });                 // updateCurrentRunScope
  await runScoringPipeline();
}

/** Extract zadd calls as an array of { score, member } objects. */
function getZaddCalls(): Array<{ score: number; member: string }> {
  return pipelineZaddMock.mock.calls
    .filter((call: unknown[]) => String(call[0]).startsWith('feed:staging:current:'))
    .flatMap((call: unknown[]) => {
      expect(call.length).toBeGreaterThanOrEqual(3);
      expect((call.length - 1) % 2).toBe(0);
      const entries: Array<{ score: number; member: string }> = [];
      for (let index = 1; index < call.length; index += 2) {
        expect(typeof call[index]).toBe('number');
        expect(Number.isFinite(call[index])).toBe(true);
        expect(typeof call[index + 1]).toBe('string');
        entries.push({
          score: call[index] as number,
          member: call[index + 1] as string,
        });
      }
      return entries;
    });
}

describe('URL deduplication in writeToRedisFromDb', () => {
  beforeEach(() => {
    __resetPipelineState();
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it('parses multiple score-member pairs from one staged ZADD', () => {
    pipelineZaddMock(
      'feed:staging:current:test-run',
      0.9,
      'at://post/1',
      0.7,
      'at://post/2'
    );

    expect(getZaddCalls()).toEqual([
      { score: 0.9, member: 'at://post/1' },
      { score: 0.7, member: 'at://post/2' },
    ]);
  });

  it('rejects a malformed staged ZADD command', () => {
    pipelineZaddMock('feed:staging:current:test-run', 0.9);

    expect(() => getZaddCalls()).toThrow();
  });

  it('rejects a staged ZADD with no score-member pairs', () => {
    pipelineZaddMock('feed:staging:current:test-run');

    expect(() => getZaddCalls()).toThrow();
  });

  it('rejects a staged ZADD with a non-numeric score', () => {
    pipelineZaddMock('feed:staging:current:test-run', '0.9', 'at://post/1');

    expect(() => getZaddCalls()).toThrow();
  });

  it('rejects a staged ZADD with a non-string member', () => {
    pipelineZaddMock('feed:staging:current:test-run', 0.9, 12345);

    expect(() => getZaddCalls()).toThrow();
  });

  it('first post with a URL gets full score', async () => {
    await runWithFeedRows([
      { post_uri: 'at://post/1', total_score: 10.0, embed_url: 'https://example.com/article', text_length: 50 },
    ]);

    const calls = getZaddCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].score).toBeCloseTo(10.0);
  });

  it('second post with same URL gets 0.7x score', async () => {
    await runWithFeedRows([
      { post_uri: 'at://post/1', total_score: 10.0, embed_url: 'https://example.com/article', text_length: 50 },
      { post_uri: 'at://post/2', total_score: 8.0, embed_url: 'https://example.com/article', text_length: 30 },
    ]);

    const calls = getZaddCalls();
    // Find by post_uri since re-sort may change order
    const post1 = calls.find(c => c.member === 'at://post/1')!;
    const post2 = calls.find(c => c.member === 'at://post/2')!;
    expect(post1.score).toBeCloseTo(10.0);  // 1st: 1.0x
    expect(post2.score).toBeCloseTo(5.6);   // 2nd: 8.0 * 0.7
  });

  it('third post with same URL gets 0.5x score', async () => {
    await runWithFeedRows([
      { post_uri: 'at://post/1', total_score: 10.0, embed_url: 'https://example.com/article', text_length: 50 },
      { post_uri: 'at://post/2', total_score: 8.0, embed_url: 'https://example.com/article', text_length: 30 },
      { post_uri: 'at://post/3', total_score: 6.0, embed_url: 'https://example.com/article', text_length: 40 },
    ]);

    const calls = getZaddCalls();
    const post3 = calls.find(c => c.member === 'at://post/3')!;
    expect(post3.score).toBeCloseTo(3.0);  // 3rd: 6.0 * 0.5
  });

  it('fourth+ post with same URL gets 0.3x score', async () => {
    await runWithFeedRows([
      { post_uri: 'at://post/1', total_score: 10.0, embed_url: 'https://example.com/article', text_length: 50 },
      { post_uri: 'at://post/2', total_score: 8.0, embed_url: 'https://example.com/article', text_length: 30 },
      { post_uri: 'at://post/3', total_score: 6.0, embed_url: 'https://example.com/article', text_length: 40 },
      { post_uri: 'at://post/4', total_score: 5.0, embed_url: 'https://example.com/article', text_length: 20 },
      { post_uri: 'at://post/5', total_score: 4.0, embed_url: 'https://example.com/article', text_length: 10 },
    ]);

    const calls = getZaddCalls();
    const post4 = calls.find(c => c.member === 'at://post/4')!;
    const post5 = calls.find(c => c.member === 'at://post/5')!;
    expect(post4.score).toBeCloseTo(1.5);  // 4th: 5.0 * 0.3
    expect(post5.score).toBeCloseTo(1.2);  // 5th: 4.0 * 0.3
  });

  it('posts with no embed_url are unaffected', async () => {
    await runWithFeedRows([
      { post_uri: 'at://post/1', total_score: 10.0, embed_url: null, text_length: 50 },
      { post_uri: 'at://post/2', total_score: 8.0, embed_url: null, text_length: 30 },
    ]);

    const calls = getZaddCalls();
    const post1 = calls.find(c => c.member === 'at://post/1')!;
    const post2 = calls.find(c => c.member === 'at://post/2')!;
    expect(post1.score).toBeCloseTo(10.0);
    expect(post2.score).toBeCloseTo(8.0);
  });

  it('posts with 200+ chars text skip penalty even with shared URL', async () => {
    await runWithFeedRows([
      { post_uri: 'at://post/1', total_score: 10.0, embed_url: 'https://example.com/article', text_length: 50 },
      { post_uri: 'at://post/2', total_score: 8.0, embed_url: 'https://example.com/article', text_length: 250 },
    ]);

    const calls = getZaddCalls();
    const post1 = calls.find(c => c.member === 'at://post/1')!;
    const post2 = calls.find(c => c.member === 'at://post/2')!;
    expect(post1.score).toBeCloseTo(10.0);  // 1st, full score
    expect(post2.score).toBeCloseTo(8.0);   // 200+ chars, skips penalty
  });

  it('different URLs are tracked independently', async () => {
    await runWithFeedRows([
      { post_uri: 'at://post/1', total_score: 10.0, embed_url: 'https://example.com/a', text_length: 50 },
      { post_uri: 'at://post/2', total_score: 9.0, embed_url: 'https://example.com/b', text_length: 30 },
      { post_uri: 'at://post/3', total_score: 8.0, embed_url: 'https://example.com/a', text_length: 40 },
      { post_uri: 'at://post/4', total_score: 7.0, embed_url: 'https://example.com/b', text_length: 20 },
    ]);

    const calls = getZaddCalls();
    const post1 = calls.find(c => c.member === 'at://post/1')!;
    const post2 = calls.find(c => c.member === 'at://post/2')!;
    const post3 = calls.find(c => c.member === 'at://post/3')!;
    const post4 = calls.find(c => c.member === 'at://post/4')!;
    expect(post1.score).toBeCloseTo(10.0);  // 1st of URL A
    expect(post2.score).toBeCloseTo(9.0);   // 1st of URL B
    expect(post3.score).toBeCloseTo(5.6);   // 2nd of URL A: 8.0 * 0.7
    expect(post4.score).toBeCloseTo(4.9);   // 2nd of URL B: 7.0 * 0.7
  });

  it('re-sorts after dedup (high-scored duplicate may drop below non-duplicate)', async () => {
    await runWithFeedRows([
      { post_uri: 'at://post/dup1', total_score: 10.0, embed_url: 'https://example.com/viral', text_length: 50 },
      { post_uri: 'at://post/dup2', total_score: 9.0, embed_url: 'https://example.com/viral', text_length: 30 },
      { post_uri: 'at://post/unique', total_score: 7.0, embed_url: null, text_length: 100 },
    ]);

    const calls = getZaddCalls();
    // dup2 was 9.0 originally but becomes 6.3 (9.0 * 0.7), while unique stays 7.0
    // After re-sort: dup1 (10.0), unique (7.0), dup2 (6.3)
    expect(calls[0].member).toBe('at://post/dup1');
    expect(calls[0].score).toBeCloseTo(10.0);
    expect(calls[1].member).toBe('at://post/unique');
    expect(calls[1].score).toBeCloseTo(7.0);
    expect(calls[2].member).toBe('at://post/dup2');
    expect(calls[2].score).toBeCloseTo(6.3);
  });

  it('handles null embed_url gracefully', async () => {
    await runWithFeedRows([
      { post_uri: 'at://post/1', total_score: 10.0, embed_url: null, text_length: 50 },
      { post_uri: 'at://post/2', total_score: 8.0, embed_url: 'https://example.com/a', text_length: 30 },
      { post_uri: 'at://post/3', total_score: 6.0, embed_url: null, text_length: 0 },
    ]);

    const calls = getZaddCalls();
    expect(calls).toHaveLength(3);
    const post1 = calls.find(c => c.member === 'at://post/1')!;
    const post3 = calls.find(c => c.member === 'at://post/3')!;
    expect(post1.score).toBeCloseTo(10.0);
    expect(post3.score).toBeCloseTo(6.0);  // null embed_url, no penalty
  });

  it('FEED_DEDUP_ENABLED=false bypasses all dedup logic', async () => {
    const original = config.FEED_DEDUP_ENABLED;
    (config as Record<string, unknown>).FEED_DEDUP_ENABLED = false;
    try {
      await runWithFeedRows([
        { post_uri: 'at://post/1', total_score: 10.0, embed_url: 'https://example.com/article', text_length: 50 },
        { post_uri: 'at://post/2', total_score: 8.0, embed_url: 'https://example.com/article', text_length: 30 },
        { post_uri: 'at://post/3', total_score: 6.0, embed_url: 'https://example.com/article', text_length: 40 },
      ]);

      const calls = getZaddCalls();
      // All scores should be unchanged — no dedup applied
      const post1 = calls.find(c => c.member === 'at://post/1')!;
      const post2 = calls.find(c => c.member === 'at://post/2')!;
      const post3 = calls.find(c => c.member === 'at://post/3')!;
      expect(post1.score).toBeCloseTo(10.0);
      expect(post2.score).toBeCloseTo(8.0);
      expect(post3.score).toBeCloseTo(6.0);
    } finally {
      (config as Record<string, unknown>).FEED_DEDUP_ENABLED = original;
    }
  });
});
