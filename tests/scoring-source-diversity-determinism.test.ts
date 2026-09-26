/**
 * Scoring Pipeline — Source-Diversity Determinism Under Concurrency (PROJ-917)
 *
 * The score loop is parallelized (SCORING_CONCURRENCY). Source diversity is
 * precomputed in input order so score-write completion timing cannot change it.
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
    SCORE_LONGTABLE_DUALWRITE_ENABLED: false,
  },
}));

vi.mock('../src/db/client.js', () => ({
  db: { query: dbQueryMock, connect: dbConnectMock },
}));
vi.mock('../src/db/redis.js', () => ({
  redis: {
    pipeline: redisPipelineFactoryMock,
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
vi.mock('../src/admin/status-tracker.js', () => ({ updateScoringStatus: updateScoringStatusMock }));
vi.mock('../src/config.js', () => ({ config: configMock }));
vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: loggerErrorMock, debug: vi.fn() },
}));

import { runScoringPipeline, __resetPipelineState } from '../src/scoring/pipeline.js';
import { bridgingComponent } from '../src/scoring/components/bridging.js';
import type { ScoringContext } from '../src/scoring/component.interface.js';
import type { PostForScoring } from '../src/scoring/score.types.js';
import { buildEpochRow, buildPostRow } from './helpers/index.js';

const URI_A = 'at://did:plc:testauthor/app.bsky.feed.post/A';
const URI_B = 'at://did:plc:testauthor/app.bsky.feed.post/B';
const URI_C = 'at://did:plc:testauthor/app.bsky.feed.post/C';

/** Extract uri -> source_diversity_score ($6, params[5]) from every wide INSERT. */
function sourceDiversityByUri(): Map<string, number> {
  const out = new Map<string, number>();
  for (const call of dbQueryMock.mock.calls as unknown[][]) {
    if (String(call[0]).includes('INSERT INTO post_scores')) {
      const params = call[1] as unknown[];
      out.set(String(params[0]), Number(params[5]));
    }
  }
  return out;
}

/**
 * db mock: three same-author posts A,B,C fetched in that order; each post's
 * bridging engager query resolves after a deliberately DIFFERENT delay
 * (A slowest, B fastest) so a naive completion-order implementation would rank
 * B first. Everything else returns empty.
 */
let scoreWriteOrder: string[] = [];

function installMock() {
  clientQueryMock.mockImplementation((sql: string) => {
    if (sql.includes('pending_rescore_generation')) {
      return Promise.resolve({ rows: [{ pending_rescore_generation: null }] });
    }
    return Promise.resolve({ rows: [] });
  });
  dbConnectMock.mockResolvedValue({ query: clientQueryMock, release: clientReleaseMock });

  scoreWriteOrder = [];
  const scoreWriteDelayMs: Record<string, number> = { [URI_A]: 60, [URI_B]: 5, [URI_C]: 30 };
  dbQueryMock.mockImplementation(async (sql: unknown, params?: unknown[]) => {
    const text = String(sql);
    if (text.includes('FROM governance_epochs') || text.includes('WHERE status')) {
      return { rows: [buildEpochRow({ id: 1 })] };
    }
    if (text.includes('FROM posts p') && text.includes('LEFT JOIN post_engagement')) {
      return {
        rows: [
          buildPostRow({ uri: URI_A }),
          buildPostRow({ uri: URI_B }),
          buildPostRow({ uri: URI_C }),
        ],
      };
    }
    if (text.includes('INSERT INTO post_scores')) {
      const uri = String(params?.[0]);
      await new Promise((resolve) => setTimeout(resolve, scoreWriteDelayMs[uri] ?? 0));
      scoreWriteOrder.push(uri);
      return { rows: [] };
    }
    return { rows: [] }; // wide INSERT, writeToRedisFromDb, updateCurrentRunScope, etc.
  });
}

describe('source-diversity determinism under concurrency (PROJ-917)', () => {
  beforeEach(() => {
    __resetPipelineState();
    vi.clearAllMocks();
    configMock.SCORING_CONCURRENCY = 8;
    const pipeline = {
      del: pipelineDelMock.mockReturnThis(),
      zadd: pipelineZaddMock.mockReturnThis(),
      set: pipelineSetMock.mockReturnThis(),
      exec: pipelineExecMock.mockResolvedValue([]),
    };
    redisPipelineFactoryMock.mockReturnValue(pipeline);
    getCurrentContentRulesMock.mockResolvedValue({ includeKeywords: [], excludeKeywords: [] });
    hasActiveContentRulesMock.mockReturnValue(false);
    updateScoringStatusMock.mockResolvedValue(undefined);
    installMock();
  });

  it('assigns diversity penalties by INPUT order, not completion order (concurrency=8)', async () => {
    await runScoringPipeline();

    const byUri = sourceDiversityByUri();
    // Writes complete in a different order than candidates, while penalties
    // remain tied to the original candidate sequence.
    expect(scoreWriteOrder).toEqual([URI_B, URI_C, URI_A]);
    expect(byUri.get(URI_A)).toBe(1.0);
    expect(byUri.get(URI_B)).toBe(0.7);
    expect(byUri.get(URI_C)).toBe(0.5);
  });

  it('handles an empty candidate set without error (worker pool degenerates to a no-op)', async () => {
    dbQueryMock.mockImplementation(async (sql: unknown, params?: unknown[]) => {
      const text = String(sql);
      if (text.includes('FROM governance_epochs') || text.includes('WHERE status')) {
        return { rows: [buildEpochRow({ id: 1 })] };
      }
      if (text.includes('FROM posts p') && text.includes('LEFT JOIN post_engagement')) {
        return { rows: [] }; // no candidate posts
      }
      return { rows: [] };
    });

    await expect(runScoringPipeline()).resolves.toBeUndefined();

    const wideInserts = (dbQueryMock.mock.calls as unknown[][]).filter((c) =>
      String(c[0]).includes('INSERT INTO post_scores')
    );
    expect(wideInserts.length).toBe(0);
  });

  it('produces the identical mapping at concurrency=1 (sequential)', async () => {
    configMock.SCORING_CONCURRENCY = 1;
    await runScoringPipeline();

    const byUri = sourceDiversityByUri();
    expect(byUri.get(URI_A)).toBe(1.0);
    expect(byUri.get(URI_B)).toBe(0.7);
    expect(byUri.get(URI_C)).toBe(0.5);
  });

  it('scores every candidate through sequential batches capped at 16', async () => {
    const posts = Array.from({ length: 33 }, (_, index) =>
      buildPostRow({ uri: `at://did:plc:batch/app.bsky.feed.post/${index}` })
    );
    scoreWriteOrder = [];
    const scoreWriteDelayMs: Record<string, number> = {
      [posts[0].uri]: 60,
      [posts[1].uri]: 5,
      [posts[2].uri]: 30,
      [posts[16].uri]: 60,
      [posts[17].uri]: 5,
      [posts[18].uri]: 30,
    };
    dbQueryMock.mockImplementation(async (sql: unknown, params?: unknown[]) => {
      const text = String(sql);
      if (text.includes('FROM governance_epochs') || text.includes('WHERE status')) {
        return { rows: [buildEpochRow({ id: 1 })] };
      }
      if (text.includes('FROM posts p') && text.includes('LEFT JOIN post_engagement')) {
        return { rows: posts };
      }
      if (text.includes('INSERT INTO post_scores')) {
        const uri = String(params?.[0]);
        await new Promise((resolve) => setTimeout(resolve, scoreWriteDelayMs[uri] ?? 0));
        scoreWriteOrder.push(uri);
      }
      return { rows: [] };
    });

    await runScoringPipeline();

    const batchCalls = (clientQueryMock.mock.calls as unknown[][]).filter((call) =>
      String(call[0]).includes('WITH combined AS')
    );
    expect(batchCalls.map((call) => (call[1] as unknown[][])[0].length)).toEqual([16, 16, 1]);
    expect(batchCalls.flatMap((call) => (call[1] as unknown[][])[0])).toEqual(posts.map((post) => post.uri));
    const scored = sourceDiversityByUri();
    expect(scored.size).toBe(33);
    expect([...scored.keys()].sort()).toEqual(posts.map((post) => post.uri).sort());
    expect(scoreWriteOrder).toHaveLength(posts.length);
    expect([...scoreWriteOrder].sort()).toEqual(posts.map((post) => post.uri).sort());
    expect(scoreWriteOrder).not.toEqual(posts.map((post) => post.uri));
    expect(loggerErrorMock).not.toHaveBeenCalled();
    expect(posts.map((post) => scored.get(post.uri))).toEqual([
      1.0, 0.7, 0.5, ...Array.from({ length: 30 }, () => 0.3),
    ]);
  });

  it('aborts before score writes and publication when a bridging batch read fails', async () => {
    // Batch reads are a required precondition for scoring; a failure must not
    // silently publish a feed with default bridging scores.
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('WITH combined AS')) {
        throw new Error('simulated bridging batch failure');
      }
      return { rows: [] };
    });
    dbQueryMock.mockImplementation(async (sql: unknown, params?: unknown[]) => {
      const text = String(sql);
      if (text.includes('FROM governance_epochs') || text.includes('WHERE status')) {
        return { rows: [buildEpochRow({ id: 1 })] };
      }
      if (text.includes('FROM posts p') && text.includes('LEFT JOIN post_engagement')) {
        return {
          rows: [buildPostRow({ uri: URI_A }), buildPostRow({ uri: URI_B }), buildPostRow({ uri: URI_C })],
        };
      }
      return { rows: [] };
    });

    await expect(runScoringPipeline()).rejects.toThrow('simulated bridging batch failure');
    expect(sourceDiversityByUri().size).toBe(0);
    expect(redisPipelineFactoryMock).not.toHaveBeenCalled();
  });

  it('does not fall back to per-post reads when batch evidence is missing', async () => {
    const post = buildPostRow({ uri: URI_A }) as PostForScoring;
    const context = { bridgingEvidenceByPost: new Map() } as ScoringContext;
    await expect(bridgingComponent.score(post, context)).rejects.toThrow(
      `Bridging batch omitted candidate evidence for ${URI_A}`
    );
    expect(dbQueryMock).not.toHaveBeenCalled();
  });
});
