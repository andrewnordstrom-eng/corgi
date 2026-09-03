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
  invalidateContentRulesCacheMock,
  invalidateGovernanceGateCacheMock,
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
  invalidateContentRulesCacheMock: vi.fn(),
  invalidateGovernanceGateCacheMock: vi.fn(),
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
  getCurrentContentRulesFromDatabase: getCurrentContentRulesMock,
  hasActiveContentRules: hasActiveContentRulesMock,
  filterPosts: vi.fn(),
  invalidateContentRulesCacheStrict: invalidateContentRulesCacheMock,
}));

vi.mock('../src/ingestion/governance-gate.js', () => ({
  invalidateGovernanceGateCacheStrict: invalidateGovernanceGateCacheMock,
}));

vi.mock('../src/admin/status-tracker.js', () => ({
  updateScoringStatus: updateScoringStatusMock,
}));

import {
  runScoringPipeline,
  requestFullRescore,
  __resetPipelineState,
} from '../src/scoring/pipeline.js';
import { buildFeedPublicationRow } from './helpers/feed-publication.js';
import { buildEpochRow } from './helpers/index.js';

let fencePendingGeneration: string | null = null;

function makeEpochRow(id = 2) {
  return buildEpochRow({ id });
}

function setupDefaultMocks() {
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
      return Promise.resolve({
        rows: [{ pending_rescore_generation: fencePendingGeneration }],
      });
    }
    if (sql.includes('UPDATE governance_rescore_requests')) {
      return Promise.resolve({ rows: [{ requested_generation: fencePendingGeneration ?? '1' }] });
    }
    return Promise.resolve({ rows: [] });
  });
  dbConnectMock.mockResolvedValue({
    query: clientQueryMock,
    release: clientReleaseMock,
  });

  getCurrentContentRulesMock.mockResolvedValue({
    includeKeywords: [],
    excludeKeywords: [],
  });
  hasActiveContentRulesMock.mockReturnValue(false);
  invalidateContentRulesCacheMock.mockResolvedValue(undefined);
  invalidateGovernanceGateCacheMock.mockResolvedValue(undefined);
  updateScoringStatusMock.mockResolvedValue(undefined);
}

/** Run a pipeline cycle that returns no posts (fast, sets internal state). */
async function runEmptyCycle(epochId = 2) {
  dbQueryMock
    .mockResolvedValueOnce({ rows: [makeEpochRow(epochId)] }) // getActiveEpoch
    .mockResolvedValueOnce({ rows: [] })                       // posts query
    .mockResolvedValueOnce({ rows: [] })                       // writeToRedisFromDb
    .mockResolvedValueOnce({ rows: [] });                      // updateCurrentRunScope
  await runScoringPipeline();
}

async function runPublishedCycle(epochId = 2) {
  dbQueryMock
    .mockResolvedValueOnce({ rows: [makeEpochRow(epochId)] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({
      rows: [buildFeedPublicationRow({
        post_uri: 'at://did:plc:author/app.bsky.feed.post/1',
        total_score: 0.8,
        author_did: 'did:plc:author',
        bridging_score: 0.5,
        engagement_score: 0.4,
        embed_url: null,
        text_length: 120,
      })],
    })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] });
  await runScoringPipeline();
}

/** Check whether the posts query used full mode (no UNION ALL) or incremental (UNION ALL). */
function getPostsQueryMode(): 'full' | 'incremental' {
  const postsQuery = String(dbQueryMock.mock.calls[1][0]);
  return postsQuery.includes('UNION ALL') ? 'incremental' : 'full';
}

describe('periodic full rescore for recency decay', () => {
  beforeEach(() => {
    __resetPipelineState();
    fencePendingGeneration = null;
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it('first run is always full mode', async () => {
    await runEmptyCycle();
    expect(getPostsQueryMode()).toBe('full');
  });

  it('runs incremental for N-1 cycles after a full rescore', async () => {
    // First run: full (sets lastSuccessfulRunAt)
    await runEmptyCycle();

    // Runs 2-6 should be incremental (SCORING_FULL_RESCORE_INTERVAL defaults to 6)
    for (let i = 1; i <= 5; i++) {
      dbQueryMock.mockReset();
      setupDefaultMocks();
      await runEmptyCycle();
      expect(getPostsQueryMode()).toBe('incremental');
    }
  });

  it('triggers full rescore after SCORING_FULL_RESCORE_INTERVAL incremental runs', async () => {
    // Run 1: full (first run)
    await runEmptyCycle();

    // Runs 2-7: incremental (6 incremental runs, counter goes 0→5)
    for (let i = 0; i < 6; i++) {
      dbQueryMock.mockReset();
      setupDefaultMocks();
      await runEmptyCycle();
    }

    // Run 8: should be full (counter reached 6 = SCORING_FULL_RESCORE_INTERVAL)
    dbQueryMock.mockReset();
    setupDefaultMocks();
    await runEmptyCycle();
    expect(getPostsQueryMode()).toBe('full');
  });

  it('resets counter after a full rescore and starts incremental again', async () => {
    // Run 1: full (first run)
    await runEmptyCycle();

    // 6 incremental runs to trigger periodic full rescore
    for (let i = 0; i < 6; i++) {
      dbQueryMock.mockReset();
      setupDefaultMocks();
      await runEmptyCycle();
    }

    // Periodic full rescore (run 8)
    dbQueryMock.mockReset();
    setupDefaultMocks();
    await runEmptyCycle();
    expect(getPostsQueryMode()).toBe('full');

    // Run 9: counter reset, should be incremental again
    dbQueryMock.mockReset();
    setupDefaultMocks();
    await runEmptyCycle();
    expect(getPostsQueryMode()).toBe('incremental');
  });

  it('epoch change triggers full mode regardless of counter', async () => {
    // Run 1: full (epoch 2)
    await runEmptyCycle(2);

    // Run 2: incremental (same epoch)
    dbQueryMock.mockReset();
    setupDefaultMocks();
    await runEmptyCycle(2);
    expect(getPostsQueryMode()).toBe('incremental');

    // Run 3: epoch changed to 3 → full rescore regardless of counter
    dbQueryMock.mockReset();
    setupDefaultMocks();
    await runEmptyCycle(3);
    expect(getPostsQueryMode()).toBe('full');
  });

  it('epoch change resets the incremental counter', async () => {
    // Run 1: full (epoch 2)
    await runEmptyCycle(2);

    // 4 incremental runs (counter at 4)
    for (let i = 0; i < 4; i++) {
      dbQueryMock.mockReset();
      setupDefaultMocks();
      await runEmptyCycle(2);
    }

    // Epoch change → full rescore, resets counter to 0
    dbQueryMock.mockReset();
    setupDefaultMocks();
    await runEmptyCycle(3);
    expect(getPostsQueryMode()).toBe('full');

    // Next run should be incremental (counter was reset to 0)
    dbQueryMock.mockReset();
    setupDefaultMocks();
    await runEmptyCycle(3);
    expect(getPostsQueryMode()).toBe('incremental');
  });

  it('runs a full pass after policy changes within the same epoch', async () => {
    await runEmptyCycle(2);

    dbQueryMock.mockReset();
    setupDefaultMocks();
    await runEmptyCycle(2);
    expect(getPostsQueryMode()).toBe('incremental');

    requestFullRescore();

    dbQueryMock.mockReset();
    setupDefaultMocks();
    await runPublishedCycle(2);
    expect(getPostsQueryMode()).toBe('full');

    dbQueryMock.mockReset();
    setupDefaultMocks();
    await runEmptyCycle(2);
    expect(getPostsQueryMode()).toBe('incremental');
  });

  it('clears a pending policy request when an epoch change already causes a full pass', async () => {
    await runEmptyCycle(2);
    requestFullRescore();

    dbQueryMock.mockReset();
    setupDefaultMocks();
    await runPublishedCycle(3);
    expect(getPostsQueryMode()).toBe('full');

    dbQueryMock.mockReset();
    setupDefaultMocks();
    await runEmptyCycle(3);
    expect(getPostsQueryMode()).toBe('incremental');
  });

  it('coalesces multiple policy requests into one full pass', async () => {
    await runEmptyCycle(2);
    requestFullRescore();
    requestFullRescore();

    dbQueryMock.mockReset();
    setupDefaultMocks();
    await runPublishedCycle(2);
    expect(getPostsQueryMode()).toBe('full');

    dbQueryMock.mockReset();
    setupDefaultMocks();
    await runEmptyCycle(2);
    expect(getPostsQueryMode()).toBe('incremental');
  });

  it('keeps a full-rescore request pending when the attempted run fails', async () => {
    await runEmptyCycle(2);
    requestFullRescore();

    dbQueryMock.mockReset();
    setupDefaultMocks();
    dbQueryMock.mockRejectedValueOnce(new Error('epoch read failed'));
    await expect(runScoringPipeline()).rejects.toThrow('epoch read failed');

    dbQueryMock.mockReset();
    setupDefaultMocks();
    await runEmptyCycle(2);
    expect(getPostsQueryMode()).toBe('full');
  });

  it('keeps an in-memory policy rescore pending until feed publication succeeds', async () => {
    await runEmptyCycle(2);
    requestFullRescore();

    dbQueryMock.mockReset();
    setupDefaultMocks();
    await runEmptyCycle(2);
    expect(getPostsQueryMode()).toBe('full');

    dbQueryMock.mockReset();
    setupDefaultMocks();
    await runEmptyCycle(2);
    expect(getPostsQueryMode()).toBe('full');

    dbQueryMock.mockReset();
    setupDefaultMocks();
    await runPublishedCycle(2);
    expect(getPostsQueryMode()).toBe('full');

    dbQueryMock.mockReset();
    setupDefaultMocks();
    await runEmptyCycle(2);
    expect(getPostsQueryMode()).toBe('incremental');
  });

  it('rejects publication and preserves a policy change requested during an in-flight run', async () => {
    await runEmptyCycle(2);

    let releaseContentRules: ((value: { includeKeywords: string[]; excludeKeywords: string[] }) => void) | null = null;
    const pendingContentRules = new Promise<{ includeKeywords: string[]; excludeKeywords: string[] }>((resolve) => {
      releaseContentRules = resolve;
    });

    dbQueryMock.mockReset();
    setupDefaultMocks();
    dbQueryMock
      .mockResolvedValueOnce({ rows: [makeEpochRow(2)] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    getCurrentContentRulesMock.mockReturnValueOnce(pendingContentRules);

    const inFlightRun = runScoringPipeline();
    await vi.waitFor(() => {
      expect(getCurrentContentRulesMock).toHaveBeenCalled();
    });
    requestFullRescore();
    releaseContentRules?.({ includeKeywords: [], excludeKeywords: [] });
    await expect(inFlightRun).rejects.toThrow(
      'Governance policy changed while epoch 2 scoring was in progress'
    );
    expect(getPostsQueryMode()).toBe('incremental');

    dbQueryMock.mockReset();
    setupDefaultMocks();
    await runEmptyCycle(2);
    expect(getPostsQueryMode()).toBe('full');
  });

  it('__resetPipelineState resets the incremental counter', async () => {
    // Run 1: full
    await runEmptyCycle();

    // 5 incremental runs
    for (let i = 0; i < 5; i++) {
      dbQueryMock.mockReset();
      setupDefaultMocks();
      await runEmptyCycle();
    }

    // Reset state (simulates server restart)
    __resetPipelineState();

    // Next run should be full (first run after reset)
    dbQueryMock.mockReset();
    setupDefaultMocks();
    await runEmptyCycle();
    expect(getPostsQueryMode()).toBe('full');
  });

  it('keeps a durable policy rescore pending when cache invalidation fails', async () => {
    dbQueryMock.mockReset();
    setupDefaultMocks();
    dbQueryMock
      .mockResolvedValueOnce({
        rows: [{ ...makeEpochRow(2), pending_rescore_generation: '4' }],
      });
    invalidateContentRulesCacheMock.mockRejectedValueOnce(new Error('cache invalidation failed'));

    await expect(runScoringPipeline()).rejects.toThrow('cache invalidation failed');
    expect(getCurrentContentRulesMock).not.toHaveBeenCalled();
    expect(
      dbQueryMock.mock.calls.some(([sql]) => String(sql).includes('UPDATE governance_rescore_requests'))
    ).toBe(false);

    dbQueryMock.mockReset();
    vi.clearAllMocks();
    setupDefaultMocks();
    fencePendingGeneration = '4';
    dbQueryMock
      .mockResolvedValueOnce({
        rows: [{ ...makeEpochRow(2), pending_rescore_generation: '4' }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await runScoringPipeline();

    expect(getPostsQueryMode()).toBe('full');
    expect(invalidateContentRulesCacheMock).toHaveBeenCalledTimes(1);
    expect(invalidateGovernanceGateCacheMock).toHaveBeenCalledTimes(1);
    expect(
      dbQueryMock.mock.calls.some(([sql]) => String(sql).includes('UPDATE governance_rescore_requests'))
    ).toBe(false);
  });

  it('completes only the durable generation observed by a published run', async () => {
    dbQueryMock.mockReset();
    setupDefaultMocks();
    fencePendingGeneration = '4';
    dbQueryMock
      .mockResolvedValueOnce({
        rows: [{ ...makeEpochRow(2), pending_rescore_generation: '4' }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [buildFeedPublicationRow({
          post_uri: 'at://did:plc:author/app.bsky.feed.post/1',
          total_score: 0.8,
          author_did: 'did:plc:author',
          bridging_score: 0.5,
          engagement_score: 0.4,
          embed_url: null,
          text_length: 120,
        })],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await runScoringPipeline();

    const completion = clientQueryMock.mock.calls.find(
      ([sql]) => String(sql).includes('UPDATE governance_rescore_requests')
    );
    expect(completion?.[1]).toEqual([2, 4]);
    expect(invalidateContentRulesCacheMock).toHaveBeenCalledTimes(1);
    expect(invalidateGovernanceGateCacheMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a stale policy publication when a newer durable generation exists', async () => {
    fencePendingGeneration = '5';
    dbQueryMock
      .mockResolvedValueOnce({
        rows: [{ ...makeEpochRow(2), pending_rescore_generation: '4' }],
      })
      .mockResolvedValueOnce({ rows: [] });

    await expect(runScoringPipeline()).rejects.toThrow(
      'Governance policy changed while epoch 2 scoring was in progress'
    );

    expect(
      dbQueryMock.mock.calls.some(([sql]) => String(sql).includes('FROM post_scores ps'))
    ).toBe(false);
    expect(clientQueryMock).toHaveBeenCalledWith('ROLLBACK');
    expect(clientReleaseMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a routine run that started before a policy approval', async () => {
    fencePendingGeneration = '1';
    dbQueryMock
      .mockResolvedValueOnce({ rows: [makeEpochRow(2)] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(runScoringPipeline()).rejects.toThrow(
      'Governance policy changed while epoch 2 scoring was in progress'
    );

    expect(
      dbQueryMock.mock.calls.some(([sql]) => String(sql).includes('FROM post_scores ps'))
    ).toBe(false);
    expect(invalidateContentRulesCacheMock).not.toHaveBeenCalled();
    expect(clientQueryMock).toHaveBeenCalledWith('ROLLBACK');
  });

  it('publishes an approved policy from only scores written by that run', async () => {
    fencePendingGeneration = '4';
    dbQueryMock
      .mockResolvedValueOnce({
        rows: [{ ...makeEpochRow(2), pending_rescore_generation: '4' }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await runScoringPipeline();

    const publication = dbQueryMock.mock.calls.find(
      ([sql]) => String(sql).includes('FROM post_scores ps')
    );
    expect(String(publication?.[0])).toContain("ps.component_details->>'run_id' = $5");
    expect(publication?.[1]).toHaveLength(5);
    expect(publication?.[1]?.[0]).toBe(2);
    expect(publication?.[1]?.[4]).toEqual(expect.any(String));
  });
});
