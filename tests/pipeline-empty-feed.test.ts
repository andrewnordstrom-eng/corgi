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
  pipelineExpireMock,
  redisIncrMock,
  redisSetMock,
  redisDelMock,
  redisEvalMock,
  getCurrentContentRulesMock,
  hasActiveContentRulesMock,
  filterPostsMock,
  updateScoringStatusMock,
  loggerWarnMock,
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
  pipelineExpireMock: vi.fn(),
  redisIncrMock: vi.fn(),
  redisSetMock: vi.fn(),
  redisDelMock: vi.fn(),
  redisEvalMock: vi.fn(),
  getCurrentContentRulesMock: vi.fn(),
  hasActiveContentRulesMock: vi.fn(),
  filterPostsMock: vi.fn(),
  updateScoringStatusMock: vi.fn(),
  loggerWarnMock: vi.fn(),
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
    incr: redisIncrMock,
    set: redisSetMock,
    del: redisDelMock,
    eval: redisEvalMock,
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

vi.mock('../src/lib/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: loggerWarnMock,
  },
}));

import { runScoringPipeline, __resetPipelineState } from '../src/scoring/pipeline.js';
import { config } from '../src/config.js';
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

function makePostRow() {
  return {
    uri: 'at://did:plc:test/post/1',
    cid: 'bafytest',
    author_did: 'did:plc:author',
    text: 'hello world',
    reply_root: null,
    reply_parent: null,
    langs: ['en'],
    has_media: false,
    created_at: new Date().toISOString(),
    like_count: 1,
    repost_count: 0,
    reply_count: 0,
  };
}

describe('scoring pipeline empty-feed Redis updates', () => {
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
    pipelineExpireMock.mockReset();
    redisIncrMock.mockReset().mockResolvedValue(1);
    redisSetMock.mockReset().mockResolvedValue('OK');
    redisDelMock.mockReset().mockResolvedValue(1);
    redisEvalMock.mockReset().mockResolvedValue(1);
    clientQueryMock.mockImplementation((sql: string) => {
      if (sql.includes('pending_rescore_generation')) {
        return Promise.resolve({ rows: [{ pending_rescore_generation: null }] });
      }
      return Promise.resolve({ rows: [] });
    });
    dbConnectMock.mockResolvedValue({ query: clientQueryMock, release: clientReleaseMock });
    getCurrentContentRulesMock.mockReset();
    hasActiveContentRulesMock.mockReset();
    filterPostsMock.mockReset();
    updateScoringStatusMock.mockReset();

    const pipeline = {
      del: pipelineDelMock.mockReturnThis(),
      expire: pipelineExpireMock.mockReturnThis(),
      zadd: pipelineZaddMock.mockReturnThis(),
      rpush: vi.fn().mockReturnThis(),
      hset: vi.fn().mockReturnThis(),
      set: pipelineSetMock.mockReturnThis(),
      exec: pipelineExecMock.mockResolvedValue(
        Array.from({ length: 19 }, () => [null, 'OK'] as [null, string])
      ),
    };
    redisPipelineFactoryMock.mockReturnValue(pipeline);
  });

  it('preserves the served feed and records telemetry when all posts are filtered out', async () => {
    dbQueryMock
      .mockResolvedValueOnce({ rows: [makeEpochRow()] })   // getActiveEpoch
      .mockResolvedValueOnce({ rows: [makePostRow()] })     // getPostsForScoring
      .mockResolvedValueOnce({ rows: [] })                   // writeToRedisFromDb
      .mockResolvedValueOnce({ rows: [] });                  // updateCurrentRunScope

    getCurrentContentRulesMock.mockResolvedValue({
      includeKeywords: ['topic'],
      excludeKeywords: [],
    });
    hasActiveContentRulesMock.mockReturnValue(true);
    filterPostsMock.mockReturnValue({
      passed: [],
      filtered: [{ post: makePostRow(), reason: 'no_include_match' }],
    });

    await runScoringPipeline();

    expect(redisPipelineFactoryMock).not.toHaveBeenCalled();
    expect(redisDelMock).not.toHaveBeenCalled();
    expect(redisEvalMock).not.toHaveBeenCalled();
    expect(redisIncrMock).toHaveBeenCalledWith('feed:empty_result_skipped_total');
    expect(redisSetMock).toHaveBeenCalledTimes(1);
    expect(redisSetMock).toHaveBeenCalledWith('feed:last_empty_result_at', expect.any(String));
    expect(pipelineZaddMock).not.toHaveBeenCalled();
    expect(updateScoringStatusMock).toHaveBeenCalledWith(
      expect.objectContaining({
        posts_scored: 0,
        posts_filtered: 1,
      })
    );
    expect(
      dbQueryMock.mock.calls.some(([query]) => String(query).includes('INSERT INTO epoch_metrics'))
    ).toBe(false);
  });

  it('preserves the served feed when no posts are fetched', async () => {
    dbQueryMock
      .mockResolvedValueOnce({ rows: [makeEpochRow()] })   // getActiveEpoch
      .mockResolvedValueOnce({ rows: [] })                   // getPostsForScoring
      .mockResolvedValueOnce({ rows: [] })                   // writeToRedisFromDb
      .mockResolvedValueOnce({ rows: [] });                  // updateCurrentRunScope

    getCurrentContentRulesMock.mockResolvedValue({
      includeKeywords: [],
      excludeKeywords: [],
    });
    hasActiveContentRulesMock.mockReturnValue(false);

    await runScoringPipeline();

    expect(redisPipelineFactoryMock).not.toHaveBeenCalled();
    expect(redisDelMock).not.toHaveBeenCalled();
    expect(redisEvalMock).not.toHaveBeenCalled();
    expect(redisIncrMock).toHaveBeenCalledWith('feed:empty_result_skipped_total');
    expect(redisSetMock).toHaveBeenCalledTimes(1);
    expect(redisSetMock).toHaveBeenCalledWith('feed:last_empty_result_at', expect.any(String));
    expect(pipelineZaddMock).not.toHaveBeenCalled();
    expect(updateScoringStatusMock).toHaveBeenCalledWith(
      expect.objectContaining({
        posts_scored: 0,
        posts_filtered: 0,
      })
    );
  });

  it('preserves the served feed when empty-result telemetry fails', async () => {
    const telemetryError = new Error('empty-result telemetry unavailable');
    dbQueryMock
      .mockResolvedValueOnce({ rows: [makeEpochRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    getCurrentContentRulesMock.mockResolvedValue({ includeKeywords: [], excludeKeywords: [] });
    hasActiveContentRulesMock.mockReturnValue(false);
    redisIncrMock.mockRejectedValueOnce(telemetryError);

    await expect(runScoringPipeline()).resolves.toBeUndefined();

    expect(redisPipelineFactoryMock).not.toHaveBeenCalled();
    expect(redisEvalMock).not.toHaveBeenCalled();
    expect(redisDelMock).not.toHaveBeenCalled();
    expect(redisSetMock).toHaveBeenCalledWith('feed:last_empty_result_at', expect.any(String));
    expect(updateScoringStatusMock).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(loggerWarnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          failures: [{ key: 'feed:empty_result_skipped_total', error: telemetryError }],
          epochId: 2,
          runId: expect.any(String),
        }),
        'Failed to record empty feed publish telemetry'
      );
    });
  });

  it('preserves the served feed when empty-result timestamp telemetry fails', async () => {
    const telemetryError = new Error('empty-result timestamp unavailable');
    dbQueryMock
      .mockResolvedValueOnce({ rows: [makeEpochRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    getCurrentContentRulesMock.mockResolvedValue({ includeKeywords: [], excludeKeywords: [] });
    hasActiveContentRulesMock.mockReturnValue(false);
    redisSetMock.mockRejectedValueOnce(telemetryError);

    await expect(runScoringPipeline()).resolves.toBeUndefined();

    expect(redisIncrMock).toHaveBeenCalledWith('feed:empty_result_skipped_total');
    expect(redisPipelineFactoryMock).not.toHaveBeenCalled();
    expect(redisEvalMock).not.toHaveBeenCalled();
    expect(redisDelMock).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(loggerWarnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          failures: [{ key: 'feed:last_empty_result_at', error: telemetryError }],
          epochId: 2,
          runId: expect.any(String),
        }),
        'Failed to record empty feed publish telemetry'
      );
    });
  });

  it('builds SQL keyword prefilter so LIMIT applies to matching posts', async () => {
    dbQueryMock
      .mockResolvedValueOnce({ rows: [makeEpochRow()] })   // getActiveEpoch
      .mockResolvedValueOnce({ rows: [] })                   // getPostsForScoring
      .mockResolvedValueOnce({ rows: [] })                   // writeToRedisFromDb
      .mockResolvedValueOnce({ rows: [] });                  // updateCurrentRunScope

    getCurrentContentRulesMock.mockResolvedValue({
      includeKeywords: ['atproto', 'foss'],
      excludeKeywords: ['nsfw', 'porn'],
    });
    hasActiveContentRulesMock.mockReturnValue(false);

    await runScoringPipeline();

    const postsQueryCall = dbQueryMock.mock.calls[1];
    const queryText = String(postsQueryCall[0]);
    const queryParams = postsQueryCall[1] as unknown[];

    expect(queryText).toContain("p.text ILIKE $");
    expect(queryText).toContain('p.text ~* $');
    expect(queryText).toContain('NOT (');
    expect(queryText).toContain('LIMIT $');
    expect(queryParams.at(-1)).toBe(5000);
  });

  it('stages and publishes current plus last-known-good feeds for non-empty results', async () => {
    dbQueryMock
      .mockResolvedValueOnce({ rows: [makeEpochRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [buildFeedPublicationRow({
          post_uri: 'at://did:plc:test/post/1',
          total_score: 0.8,
          author_did: 'did:plc:author',
          bridging_score: 0.2,
          engagement_score: 0.4,
          embed_url: null,
          text_length: 50,
        })],
      })
      .mockResolvedValueOnce({ rows: [] });
    getCurrentContentRulesMock.mockResolvedValue({ includeKeywords: [], excludeKeywords: [] });
    hasActiveContentRulesMock.mockReturnValue(false);

    await runScoringPipeline();

    expect(pipelineZaddMock).toHaveBeenCalledWith(
      expect.stringMatching(/^feed:staging:current:/),
      0.8,
      'at://did:plc:test/post/1'
    );
    expect(pipelineZaddMock).toHaveBeenCalledWith(
      expect.stringMatching(/^feed:staging:last_known_good:/),
      0.8,
      'at://did:plc:test/post/1'
    );
    const expectedStagingTtlSeconds = Math.ceil((config.SCORING_TIMEOUT_MS * 2) / 1000);
    expect(pipelineExpireMock).toHaveBeenCalledWith(
      expect.stringMatching(/^feed:staging:current:/),
      expectedStagingTtlSeconds
    );
    expect(pipelineSetMock).toHaveBeenCalledWith(
      expect.stringMatching(/^feed:staging:metadata:.*:3$/),
      '1'
    );
    expect(pipelineSetMock).toHaveBeenCalledWith(
      expect.stringMatching(/^feed:staging:metadata:.*:10$/),
      '1'
    );
    expect(pipelineSetMock).toHaveBeenCalledWith(
      expect.stringMatching(/^feed:staging:metadata:.*:14$/),
      expect.stringMatching(/^[0-9a-f]{40}$/)
    );
    expect(pipelineSetMock).toHaveBeenCalledWith(
      expect.stringMatching(/^feed:staging:metadata:.*:15$/),
      expect.stringMatching(/^[0-9a-f]{40}$/)
    );
    const publishArgs = redisEvalMock.mock.calls[0] as unknown[];
    expect(publishArgs[0]).toEqual(expect.stringContaining("redis.call('EXISTS'"));
    expect(publishArgs[0]).toEqual(expect.stringContaining('redis.sha1hex'));
    expect(publishArgs[0]).toEqual(expect.stringContaining(
      'validateProjection(1, 3, 5, 7, 9, 23)'
    ));
    expect(publishArgs[0]).toEqual(expect.stringContaining(
      'validateProjection(2, 4, 6, 8, 16, 24)'
    ));
    expect(publishArgs[1]).toBe(50);
    expect(publishArgs).toContain('feed:order');
    expect(publishArgs).toContain('feed:last_known_good_order');
    expect(publishArgs).toContain('feed:explanations');
    expect(publishArgs).toContain('feed:last_known_good_explanations');
    expect(publishArgs).toContain('feed:explanation_seals');
    expect(publishArgs).toContain('feed:last_known_good_explanation_seals');
    expect(publishArgs).toContain('feed:snapshot_digest');
    expect(publishArgs).toContain('feed:last_known_good_snapshot_digest');
    expect(publishArgs).toContain('feed:publication_integrity_seal');
    expect(publishArgs).toContain('feed:last_known_good_publication_integrity_seal');
    expect(publishArgs).toContain('feed:current_snapshot_generation');
    expect(publishArgs).toContain('feed:current_snapshot_id');
    expect(publishArgs.at(-1)).toBe('24');
  });

  it('rejects malformed publication numbers without replacing the served feed', async () => {
    dbQueryMock
      .mockResolvedValueOnce({ rows: [makeEpochRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [buildFeedPublicationRow({
          post_uri: 'at://did:plc:test/post/invalid-score',
          total_score: 'not-a-number',
        })],
      });
    getCurrentContentRulesMock.mockResolvedValue({ includeKeywords: [], excludeKeywords: [] });
    hasActiveContentRulesMock.mockReturnValue(false);

    await expect(runScoringPipeline()).rejects.toThrow(
      'Feed publication row has non-finite total_score for at://did:plc:test/post/invalid-score: not-a-number'
    );

    expect(redisPipelineFactoryMock).not.toHaveBeenCalled();
    expect(redisEvalMock).not.toHaveBeenCalled();
  });

  it('cleans staged keys and surfaces a failed atomic publish', async () => {
    const publishError = new Error('publish failed');
    dbQueryMock
      .mockResolvedValueOnce({ rows: [makeEpochRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [buildFeedPublicationRow({
          post_uri: 'at://did:plc:test/post/1',
          total_score: 0.8,
          author_did: 'did:plc:author',
          bridging_score: 0.2,
          engagement_score: 0.4,
          embed_url: null,
          text_length: 50,
        })],
      });
    getCurrentContentRulesMock.mockResolvedValue({ includeKeywords: [], excludeKeywords: [] });
    hasActiveContentRulesMock.mockReturnValue(false);
    redisEvalMock.mockRejectedValueOnce(publishError);

    await expect(runScoringPipeline()).rejects.toThrow('publish failed');

    expect(pipelineExpireMock).toHaveBeenCalledTimes(24);
    expect(redisDelMock).toHaveBeenCalledWith(
      expect.stringMatching(/^feed:staging:current:/),
      expect.stringMatching(/^feed:staging:last_known_good:/),
      expect.stringMatching(/^feed:staging:order:current:/),
      expect.stringMatching(/^feed:staging:order:last_known_good:/),
      expect.stringMatching(/^feed:staging:explanations:current:/),
      expect.stringMatching(/^feed:staging:explanations:last_known_good:/),
      expect.stringMatching(/^feed:staging:explanation-seals:current:/),
      expect.stringMatching(/^feed:staging:explanation-seals:last_known_good:/),
      expect.stringMatching(/^feed:staging:metadata:.*:0$/),
      expect.stringMatching(/^feed:staging:metadata:.*:1$/),
      expect.stringMatching(/^feed:staging:metadata:.*:2$/),
      expect.stringMatching(/^feed:staging:metadata:.*:3$/),
      expect.stringMatching(/^feed:staging:metadata:.*:4$/),
      expect.stringMatching(/^feed:staging:metadata:.*:5$/),
      expect.stringMatching(/^feed:staging:metadata:.*:6$/),
      expect.stringMatching(/^feed:staging:metadata:.*:7$/),
      expect.stringMatching(/^feed:staging:metadata:.*:8$/),
      expect.stringMatching(/^feed:staging:metadata:.*:9$/),
      expect.stringMatching(/^feed:staging:metadata:.*:10$/),
      expect.stringMatching(/^feed:staging:metadata:.*:11$/),
      expect.stringMatching(/^feed:staging:metadata:.*:12$/),
      expect.stringMatching(/^feed:staging:metadata:.*:13$/),
      expect.stringMatching(/^feed:staging:metadata:.*:14$/),
      expect.stringMatching(/^feed:staging:metadata:.*:15$/)
    );
  });

  it('cleans staged keys when atomic publish returns an unexpected value', async () => {
    dbQueryMock
      .mockResolvedValueOnce({ rows: [makeEpochRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [buildFeedPublicationRow({
          post_uri: 'at://did:plc:test/post/1',
          total_score: 0.8,
          author_did: 'did:plc:author',
          bridging_score: 0.2,
          engagement_score: 0.4,
          embed_url: null,
          text_length: 50,
        })],
      });
    getCurrentContentRulesMock.mockResolvedValue({ includeKeywords: [], excludeKeywords: [] });
    hasActiveContentRulesMock.mockReturnValue(false);
    redisEvalMock.mockResolvedValueOnce(0);

    await expect(runScoringPipeline()).rejects.toThrow(
      'Atomic feed publish returned unexpected result: 0'
    );

    expect(redisDelMock).toHaveBeenCalledOnce();
  });

  it('does not publish when staged materialization is aborted', async () => {
    dbQueryMock
      .mockResolvedValueOnce({ rows: [makeEpochRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [buildFeedPublicationRow({
          post_uri: 'at://did:plc:test/post/1',
          total_score: 0.8,
          author_did: 'did:plc:author',
          bridging_score: 0.2,
          engagement_score: 0.4,
          embed_url: null,
          text_length: 50,
        })],
      });
    getCurrentContentRulesMock.mockResolvedValue({ includeKeywords: [], excludeKeywords: [] });
    hasActiveContentRulesMock.mockReturnValue(false);
    pipelineExecMock.mockResolvedValueOnce(null);

    await expect(runScoringPipeline()).rejects.toThrow('exec returned null');

    expect(redisEvalMock).not.toHaveBeenCalled();
    expect(redisDelMock).toHaveBeenCalledOnce();
  });

  it('does not publish when a staged materialization command fails', async () => {
    const stagingError = new Error('staging command failed');
    dbQueryMock
      .mockResolvedValueOnce({ rows: [makeEpochRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [buildFeedPublicationRow({
          post_uri: 'at://did:plc:test/post/1',
          total_score: 0.8,
          author_did: 'did:plc:author',
          bridging_score: 0.2,
          engagement_score: 0.4,
          embed_url: null,
          text_length: 50,
        })],
      });
    getCurrentContentRulesMock.mockResolvedValue({ includeKeywords: [], excludeKeywords: [] });
    hasActiveContentRulesMock.mockReturnValue(false);
    pipelineExecMock.mockResolvedValueOnce([
      [null, 1],
      [stagingError, null],
    ]);

    await expect(runScoringPipeline()).rejects.toThrow(
      'staged feed materialization at command 1: staging command failed'
    );

    expect(redisEvalMock).not.toHaveBeenCalled();
    expect(redisDelMock).toHaveBeenCalledOnce();
  });
});
