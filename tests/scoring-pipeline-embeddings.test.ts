/**
 * Scoring Pipeline — Classification Method Tracking Tests
 *
 * Verifies that the scoring pipeline reads classification_method from
 * the posts table and passes it through to post_scores, rather than
 * hardcoding 'keyword' for every post.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Hoisted mocks ---

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
  configMock: {
    SCORING_WINDOW_HOURS: 48,
    FEED_MAX_POSTS: 300,
    FEED_DEDUP_ENABLED: false,
    FEED_DEDUP_MIN_TEXT: 200,
    SCORING_FULL_RESCORE_INTERVAL: 6,
    SCORING_CONCURRENCY: 4,
    TOPIC_EMBEDDING_ENABLED: false,
    TOPIC_EMBEDDING_MIN_SIMILARITY: 0.35,
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
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { runScoringPipeline, __resetPipelineState } from '../src/scoring/pipeline.js';
import { buildEpochRow, buildPostRow } from './helpers/index.js';

// --- Helpers ---

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

function makeEpochRow(id = 1) {
  return buildEpochRow({ id });
}

function makePostRow(
  uri: string,
  text = 'hello world',
  topicVector: Record<string, number> = { general: 0.5 },
  classificationMethod: 'keyword' | 'embedding' = 'keyword',
) {
  return buildPostRow({
    uri,
    text,
    topic_vector: topicVector,
    like_count: 1,
    repost_count: 0,
    reply_count: 0,
    classification_method: classificationMethod,
  });
}

/**
 * Set up mocks for a pipeline run that processes one post.
 */
function setupSinglePostRun(
  epochId = 1,
  topicVector: Record<string, number> = { general: 0.5 },
  classificationMethod: 'keyword' | 'embedding' = 'keyword',
) {
  const postRow = makePostRow(
    'at://did:plc:test/app.bsky.feed.post/1',
    'test post about technology',
    topicVector,
    classificationMethod,
  );
  const epochRow = makeEpochRow(epochId);

  dbQueryMock
    .mockResolvedValueOnce({ rows: [epochRow] })   // getActiveEpoch
    .mockResolvedValueOnce({ rows: [postRow] })     // getPostsForScoring
    .mockResolvedValueOnce({ rows: [] })             // storeScore INSERT
    .mockResolvedValueOnce({ rows: [] })             // writeToRedisFromDb
    .mockResolvedValueOnce({ rows: [] });            // updateCurrentRunScope
}

/** Extract the classification_method stored in post_scores via storeScore. */
function getStoredClassificationMethod(): string | undefined {
  for (const call of dbQueryMock.mock.calls) {
    const sql = String(call[0]);
    if (sql.includes('INSERT INTO post_scores')) {
      const params = call[1] as unknown[];
      // classification_method is $20 (index 19)
      return params[19] as string;
    }
  }
  return undefined;
}

describe('scoring pipeline classification method tracking', () => {
  beforeEach(() => {
    __resetPipelineState();
    vi.clearAllMocks();
    dbQueryMock.mockReset();
    clientQueryMock.mockReset();
    setupDefaultMocks();
  });

  it('reads classification_method from post row (keyword)', async () => {
    setupSinglePostRun(1, { 'software-development': 0.85 }, 'keyword');

    await runScoringPipeline();

    const method = getStoredClassificationMethod();
    expect(method).toBe('keyword');
  });

  it('reads classification_method from post row (embedding)', async () => {
    setupSinglePostRun(1, { 'ai-machine-learning': 0.52 }, 'embedding');

    await runScoringPipeline();

    const method = getStoredClassificationMethod();
    expect(method).toBe('embedding');
  });

  it('defaults to keyword when classification_method is null', async () => {
    const postRow = buildPostRow({
      uri: 'at://did:plc:test/app.bsky.feed.post/1',
      text: 'test post',
      topic_vector: { general: 0.5 },
      like_count: 1,
      repost_count: 0,
      reply_count: 0,
      classification_method: null,
    });

    dbQueryMock
      .mockResolvedValueOnce({ rows: [makeEpochRow()] })
      .mockResolvedValueOnce({ rows: [postRow] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await runScoringPipeline();

    const method = getStoredClassificationMethod();
    expect(method).toBe('keyword');
  });

  it('TOPIC_EMBEDDING_ENABLED has no effect on scoring behavior', async () => {
    configMock.TOPIC_EMBEDDING_ENABLED = true;
    setupSinglePostRun(1, { general: 0.5 }, 'keyword');

    // Pipeline should complete without calling any embedding functions
    await expect(runScoringPipeline()).resolves.not.toThrow();

    const method = getStoredClassificationMethod();
    expect(method).toBe('keyword');
  });

  it('posts with keyword vectors score correctly', async () => {
    setupSinglePostRun(1, { 'ai-machine-learning': 0.7 });

    await runScoringPipeline();

    const storeCall = dbQueryMock.mock.calls.find(
      (c: unknown[]) => String(c[0]).includes('INSERT INTO post_scores')
    );
    expect(storeCall).toBeDefined();
  });

  it('posts with embedding-style vectors score correctly', async () => {
    setupSinglePostRun(1, { 'software-development': 0.62, 'devops-infrastructure': 0.38 }, 'embedding');

    await runScoringPipeline();

    const storeCall = dbQueryMock.mock.calls.find(
      (c: unknown[]) => String(c[0]).includes('INSERT INTO post_scores')
    );
    expect(storeCall).toBeDefined();
    expect(getStoredClassificationMethod()).toBe('embedding');
  });

  it('completes scoring run when no posts to score', async () => {
    dbQueryMock
      .mockResolvedValueOnce({ rows: [makeEpochRow()] }) // getActiveEpoch
      .mockResolvedValueOnce({ rows: [] })                // getPostsForScoring (empty)
      .mockResolvedValueOnce({ rows: [] })                // writeToRedisFromDb
      .mockResolvedValueOnce({ rows: [] });               // updateCurrentRunScope

    await expect(runScoringPipeline()).resolves.not.toThrow();
  });
});
