import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbQueryMock } = vi.hoisted(() => ({
  dbQueryMock: vi.fn(),
}));
const { redisGetMock, redisEvalMock } = vi.hoisted(() => ({
  redisGetMock: vi.fn(),
  redisEvalMock: vi.fn(),
}));

vi.mock('../src/db/client.js', () => ({
  db: {
    query: dbQueryMock,
  },
}));

vi.mock('../src/db/redis.js', () => ({
  redis: {
    get: redisGetMock,
    eval: redisEvalMock,
  },
}));

import { registerPostExplainRoute } from '../src/transparency/routes/post-explain.js';
import { registerFeedStatsRoute } from '../src/transparency/routes/feed-stats.js';
import { registerCounterfactualRoute } from '../src/transparency/routes/counterfactual.js';

interface FeedStatsDbMockOptions {
  metricsRows: Record<string, unknown>[];
  voteCount?: string;
  metricsError?: Error;
  voteCountError?: Error;
  currentScoringRunValue?: unknown;
  currentScoringRunError?: Error;
}

function buildActiveEpochRow(): Record<string, unknown> {
  return {
    id: 2,
    status: 'active',
    recency_weight: 0.2,
    engagement_weight: 0.2,
    bridging_weight: 0.2,
    source_diversity_weight: 0.2,
    relevance_weight: 0.2,
    created_at: '2026-02-09T00:00:00.000Z',
  };
}

function mockFeedStatsDbQueries(options: FeedStatsDbMockOptions): void {
  dbQueryMock.mockImplementation((query: unknown) => {
    const sql = String(query);

    if (sql.includes('FROM governance_epochs')) {
      return Promise.resolve({ rows: [buildActiveEpochRow()] });
    }

    if (sql.includes('FROM epoch_metrics')) {
      if (options.metricsError) {
        return Promise.reject(options.metricsError);
      }
      return Promise.resolve({ rows: options.metricsRows });
    }

    if (sql.includes('COUNT(*) as count FROM governance_votes')) {
      if (options.voteCountError) {
        return Promise.reject(options.voteCountError);
      }
      return Promise.resolve({ rows: [{ count: options.voteCount ?? '5' }] });
    }

    if (sql.includes("WHERE key = 'current_scoring_run'")) {
      if (options.currentScoringRunError) {
        return Promise.reject(options.currentScoringRunError);
      }
      const rows = options.currentScoringRunValue === undefined
        ? []
        : [{ value: options.currentScoringRunValue }];
      return Promise.resolve({ rows });
    }

    return Promise.reject(new Error(`Unhandled feed stats test query: ${sql}`));
  });
}

describe('transparency routes current-run scoping', () => {
  beforeEach(() => {
    dbQueryMock.mockReset();
    redisGetMock.mockReset();
    redisEvalMock.mockReset().mockResolvedValue(JSON.stringify({
      snapshots: [{ snapshotStatus: 'current', found: false }],
      pinnedAnnouncement: null,
    }));
  });

  it('serves feed stats from materialized epoch metrics without request-time score scans', async () => {
    mockFeedStatsDbQueries({
      metricsRows: [
        {
          run_id: 'run-1',
          author_gini: '0.2',
          avg_bridging: '0.3',
          median_bridging: '0.25',
          avg_engagement: '0.4',
          median_total: '0.5',
          vs_chronological_overlap: '0',
          vs_engagement_overlap: 0,
          posts_scored: '10',
          unique_authors: '8',
          computed_at: '2026-02-09T00:05:00.000Z',
          metrics_source: 'current_feed',
        },
      ],
    });

    const app = Fastify();
    registerFeedStatsRoute(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/transparency/stats',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      feed_stats: {
        total_posts_scored: number;
        unique_authors: number;
        avg_bridging_score: number;
        avg_engagement_score: number;
        median_total_score: number;
      };
      metrics: {
        vs_chronological_overlap: number | null;
        vs_engagement_overlap: number | null;
      };
      stats_status: { source: string; degraded: boolean; run_id: string | null };
    };
    expect(body.feed_stats).toMatchObject({
      total_posts_scored: 10,
      unique_authors: 8,
      avg_bridging_score: 0.3,
      avg_engagement_score: 0.4,
      median_total_score: 0.5,
    });
    expect(body.stats_status).toMatchObject({
      source: 'scoring_run',
      degraded: false,
      run_id: 'run-1',
    });
    expect(body.metrics).toMatchObject({
      vs_chronological_overlap: 0,
      vs_engagement_overlap: 0,
    });

    const postScoreScanCalls = dbQueryMock.mock.calls
      .map((call) => String(call[0]))
      .filter((query) => query.includes('FROM post_scores ps'));

    expect(postScoreScanCalls).toEqual([]);
    expect(redisGetMock).not.toHaveBeenCalled();

    await app.close();
  });

  it('marks legacy materialized feed stats as degraded without request-time score scans', async () => {
    mockFeedStatsDbQueries({
      metricsRows: [
        {
          run_id: 'legacy-run',
          author_gini: '0.2',
          avg_bridging: '0.3',
          median_bridging: '0.25',
          avg_engagement: null,
          median_total: null,
          vs_chronological_overlap: null,
          vs_engagement_overlap: null,
          posts_scored: '10',
          unique_authors: '8',
          computed_at: '2026-02-09T00:05:00.000Z',
          metrics_source: 'legacy',
        },
      ],
    });

    const app = Fastify();
    registerFeedStatsRoute(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/transparency/stats',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      feed_stats: {
        avg_engagement_score: number;
        median_total_score: number;
      };
      stats_status: { source: string; degraded: boolean; message: string | null };
    };
    expect(body.feed_stats.avg_engagement_score).toBe(0);
    expect(body.feed_stats.median_total_score).toBe(0);
    expect(body.stats_status).toMatchObject({
      source: 'scoring_run',
      degraded: true,
    });
    expect(body.stats_status.message).toContain('legacy transparency metrics');

    const postScoreScanCalls = dbQueryMock.mock.calls
      .map((call) => String(call[0]))
      .filter((query) => query.includes('FROM post_scores ps'));

    expect(postScoreScanCalls).toEqual([]);
    expect(redisGetMock).not.toHaveBeenCalled();

    await app.close();
  });

  it('returns a degraded stats shape when materialized metrics are not available', async () => {
    redisGetMock.mockResolvedValueOnce('25');
    mockFeedStatsDbQueries({
      metricsRows: [],
      currentScoringRunValue: {
        run_id: 'run-2',
        epoch_id: 2,
        posts_scored: 12,
        timestamp: '2026-02-09T00:06:00.000Z',
      },
    });

    const app = Fastify();
    registerFeedStatsRoute(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/transparency/stats',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      feed_stats: { total_posts_scored: number; unique_authors: number };
      stats_status: { source: string; degraded: boolean; run_id: string | null };
    };
    expect(body.feed_stats.total_posts_scored).toBe(25);
    expect(body.feed_stats.unique_authors).toBe(0);
    expect(body.stats_status).toMatchObject({
      source: 'fallback',
      degraded: true,
      run_id: 'run-2',
    });

    await app.close();
  });

  it('returns degraded fallback stats when materialized metrics query fails', async () => {
    redisGetMock.mockResolvedValueOnce('19');
    mockFeedStatsDbQueries({
      metricsRows: [],
      metricsError: new Error('epoch_metrics unavailable'),
      currentScoringRunValue: {
        run_id: 'run-metrics-failed',
        epoch_id: 2,
        posts_scored: 7,
        timestamp: '2026-02-09T00:06:00.000Z',
      },
    });

    const app = Fastify();
    registerFeedStatsRoute(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/transparency/stats',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      feed_stats: { total_posts_scored: number; unique_authors: number };
      governance: { votes_this_epoch: number };
      stats_status: { source: string; degraded: boolean; run_id: string | null };
    };
    expect(body.feed_stats).toMatchObject({
      total_posts_scored: 19,
      unique_authors: 0,
    });
    expect(body.governance.votes_this_epoch).toBe(5);
    expect(body.stats_status).toMatchObject({
      source: 'fallback',
      degraded: true,
      run_id: 'run-metrics-failed',
    });

    await app.close();
  });

  it('defaults governance votes to zero when the vote-count query fails', async () => {
    mockFeedStatsDbQueries({
      metricsRows: [
        {
          run_id: 'run-votes-failed',
          author_gini: '0.2',
          avg_bridging: '0.3',
          median_bridging: '0.25',
          avg_engagement: '0.4',
          median_total: '0.5',
          vs_chronological_overlap: null,
          vs_engagement_overlap: null,
          posts_scored: '10',
          unique_authors: '8',
          computed_at: '2026-02-09T00:05:00.000Z',
          metrics_source: 'current_feed',
        },
      ],
      voteCountError: new Error('governance_votes unavailable'),
    });

    const app = Fastify();
    registerFeedStatsRoute(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/transparency/stats',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      feed_stats: { total_posts_scored: number };
      governance: { votes_this_epoch: number };
      stats_status: { source: string; degraded: boolean };
    };
    expect(body.feed_stats.total_posts_scored).toBe(10);
    expect(body.governance.votes_this_epoch).toBe(0);
    expect(body.stats_status).toMatchObject({
      source: 'scoring_run',
      degraded: false,
    });

    await app.close();
  });

  it('does not use Redis feed count when fallback scoring scope is from another epoch', async () => {
    redisGetMock.mockResolvedValueOnce('25');
    mockFeedStatsDbQueries({
      metricsRows: [],
      currentScoringRunValue: {
        run_id: 'run-other-epoch',
        epoch_id: 99,
        posts_scored: 12,
        timestamp: '2026-02-09T00:06:00.000Z',
      },
    });

    const app = Fastify();
    registerFeedStatsRoute(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/transparency/stats',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      feed_stats: { total_posts_scored: number };
      stats_status: { source: string; degraded: boolean; computed_at: string | null; run_id: string | null };
    };
    expect(body.feed_stats.total_posts_scored).toBe(0);
    expect(body.stats_status).toMatchObject({
      source: 'fallback',
      degraded: true,
      computed_at: null,
      run_id: null,
    });
    expect(redisGetMock).not.toHaveBeenCalled();

    await app.close();
  });

  it('keeps degraded fallback scoped when Redis feed count fails', async () => {
    redisGetMock.mockRejectedValueOnce(new Error('redis feed count failed'));
    mockFeedStatsDbQueries({
      metricsRows: [],
      currentScoringRunValue: {
        run_id: 'run-redis-failed',
        epoch_id: 2,
        posts_scored: 12,
        timestamp: '2026-02-09T00:06:00.000Z',
      },
    });

    const app = Fastify();
    registerFeedStatsRoute(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/transparency/stats',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      feed_stats: { total_posts_scored: number };
      stats_status: { source: string; degraded: boolean; run_id: string | null };
    };
    expect(body.feed_stats.total_posts_scored).toBe(12);
    expect(body.stats_status).toMatchObject({
      source: 'fallback',
      degraded: true,
      run_id: 'run-redis-failed',
    });

    await app.close();
  });

  it('returns degraded zeros when fallback run-scope lookup fails', async () => {
    mockFeedStatsDbQueries({
      metricsRows: [],
      currentScoringRunError: new Error('current scoring run lookup failed'),
    });

    const app = Fastify();
    registerFeedStatsRoute(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/transparency/stats',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      feed_stats: { total_posts_scored: number };
      stats_status: { source: string; degraded: boolean; run_id: string | null };
    };
    expect(body.feed_stats.total_posts_scored).toBe(0);
    expect(body.stats_status).toMatchObject({
      source: 'fallback',
      degraded: true,
      run_id: null,
    });
    expect(redisGetMock).not.toHaveBeenCalled();

    await app.close();
  });

  it('preserves null overlap metrics from materialized stats', async () => {
    mockFeedStatsDbQueries({
      metricsRows: [
        {
          run_id: 'run-null-overlap',
          author_gini: null,
          avg_bridging: '0.3',
          median_bridging: '0.25',
          avg_engagement: '0.4',
          median_total: '0.5',
          vs_chronological_overlap: null,
          vs_engagement_overlap: null,
          posts_scored: '10',
          unique_authors: '8',
          computed_at: '2026-02-09T00:05:00.000Z',
          metrics_source: 'current_feed',
        },
      ],
    });

    const app = Fastify();
    registerFeedStatsRoute(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/transparency/stats',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      metrics: {
        author_gini: number | null;
        vs_chronological_overlap: number | null;
        vs_engagement_overlap: number | null;
      };
    };
    expect(body.metrics).toMatchObject({
      author_gini: null,
      vs_chronological_overlap: null,
      vs_engagement_overlap: null,
    });

    await app.close();
  });

  it('does not scope counterfactual rankings to the latest incremental run', async () => {
    dbQueryMock
      .mockResolvedValueOnce({
        rows: [{ id: 2, recency_weight: 0.2, engagement_weight: 0.2, bridging_weight: 0.2, source_diversity_weight: 0.2, relevance_weight: 0.2 }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            post_uri: 'at://did:plc:a/app.bsky.feed.post/1',
            total_score: '0.6',
            components_raw: {
              recency: '0.8',
              engagement: '0.7',
              bridging: '0.6',
              sourceDiversity: '0.5',
              relevance: '0.4',
            },
            components_weight: {
              recency: '0.2',
              engagement: '0.2',
              bridging: '0.2',
              sourceDiversity: '0.2',
              relevance: '0.2',
            },
            components_weighted: {
              recency: '0.16',
              engagement: '0.14',
              bridging: '0.12',
              sourceDiversity: '0.1',
              relevance: '0.08',
            },
          },
        ],
      });

    const app = Fastify();
    registerCounterfactualRoute(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/transparency/counterfactual',
    });

    expect(response.statusCode).toBe(200);
    expect(dbQueryMock).toHaveBeenCalledTimes(2);
    expect(String(dbQueryMock.mock.calls[1]?.[0])).not.toContain("component_details->>'run_id'");
    expect(dbQueryMock.mock.calls.some(([query]) => String(query).includes('system_status'))).toBe(false);

    await app.close();
  });

  it('resolves post explanations for scores from older incremental runs', async () => {
    // Post-PROJ-817 with read flag flipped to true:
    //   0: epoch lookup
    //   1: readPostScore long-path #1 — post_scores header
    //   2: readPostScore long-path #2 — post_score_components SELECT
    //   3: rank query (total_score)  ← assertion target
    //   4: countPostsWithComponentAbove long-path JOIN  ← assertion target
    //   5: topic_vector (try-block, non-fatal)
    //   6: topic_weights (try-block, non-fatal)
    dbQueryMock
      .mockResolvedValueOnce({ rows: [{ id: 3, description: 'epoch' }] })
      .mockResolvedValueOnce({
        rows: [
          {
            post_uri: 'at://did:plc:a/app.bsky.feed.post/1',
            epoch_id: 3,
            total_score: 0.7,
            scored_at: '2026-02-09T00:00:00.000Z',
            classification_method: 'keyword',
            component_details: { run_id: 'older-run' },
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { component_key: 'recency', raw: '0.8', weight: '0.2', weighted: '0.16' },
          { component_key: 'engagement', raw: '0.6', weight: '0.2', weighted: '0.12' },
          { component_key: 'bridging', raw: '0.5', weight: '0.2', weighted: '0.1' },
          { component_key: 'sourceDiversity', raw: '0.4', weight: '0.2', weighted: '0.08' },
          { component_key: 'relevance', raw: '0.3', weight: '0.2', weighted: '0.06' },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ rank: '2' }] })
      .mockResolvedValueOnce({ rows: [{ count: '4' }] })
      .mockResolvedValueOnce({ rows: [{ topic_vector: { atproto: 0.8 } }] })
      .mockResolvedValueOnce({ rows: [{ topic_weights: { atproto: 0.5 } }] });

    const app = Fastify();
    registerPostExplainRoute(app);

    const response = await app.inject({
      method: 'GET',
      url: `/api/transparency/post/${encodeURIComponent('at://did:plc:a/app.bsky.feed.post/1')}`,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      components: { relevance: { topicBreakdown?: Record<string, unknown> } };
    };
    expect(body.components.relevance.topicBreakdown?.atproto).toEqual({
      postScore: 0.8,
      communityWeight: 0.5,
      contribution: 0.4,
    });
    // The initial score lookup is epoch-scoped so older incremental-run rows
    // can resolve. Rank-by-total query (call 3) and counterfactual long-path
    // JOIN (call 4) still filter on the resolved score row's run_id.
    expect(String(dbQueryMock.mock.calls[1]?.[0])).not.toContain("component_details->>'run_id'");
    expect(String(dbQueryMock.mock.calls[3]?.[0])).toContain("component_details->>'run_id'");
    expect(String(dbQueryMock.mock.calls[4]?.[0])).toContain("component_details->>'run_id'");
    expect(dbQueryMock.mock.calls[3]?.[1]).toEqual([3, 0.7, 'older-run']);
    expect(dbQueryMock.mock.calls[4]?.[1]).toEqual([3, 'engagement', 0.6, 'older-run']);
    expect(dbQueryMock.mock.calls.some(([query]) => String(query).includes('system_status'))).toBe(false);
    expect(dbQueryMock).toHaveBeenCalledTimes(7);

    await app.close();
  });

  it('does not scope post explanation rank calculations when the score row has no run id', async () => {
    dbQueryMock
      .mockResolvedValueOnce({ rows: [{ id: 3, description: 'epoch' }] })
      .mockResolvedValueOnce({
        rows: [
          {
            post_uri: 'at://did:plc:a/app.bsky.feed.post/1',
            epoch_id: 3,
            total_score: 0.7,
            scored_at: '2026-02-09T00:00:00.000Z',
            classification_method: 'keyword',
            component_details: {},
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { component_key: 'recency', raw: '0.8', weight: '0.2', weighted: '0.16' },
          { component_key: 'engagement', raw: '0.6', weight: '0.2', weighted: '0.12' },
          { component_key: 'bridging', raw: '0.5', weight: '0.2', weighted: '0.1' },
          { component_key: 'sourceDiversity', raw: '0.4', weight: '0.2', weighted: '0.08' },
          { component_key: 'relevance', raw: '0.3', weight: '0.2', weighted: '0.06' },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ rank: '2' }] })
      .mockResolvedValueOnce({ rows: [{ count: '4' }] })
      .mockResolvedValueOnce({ rows: [{ topic_vector: {} }] })
      .mockResolvedValueOnce({ rows: [{ topic_weights: {} }] });

    const app = Fastify();
    registerPostExplainRoute(app);

    const response = await app.inject({
      method: 'GET',
      url: `/api/transparency/post/${encodeURIComponent('at://did:plc:a/app.bsky.feed.post/1')}`,
    });

    expect(response.statusCode).toBe(200);
    expect(String(dbQueryMock.mock.calls[3]?.[0])).not.toContain("component_details->>'run_id'");
    expect(String(dbQueryMock.mock.calls[4]?.[0])).not.toContain("component_details->>'run_id'");
    expect(dbQueryMock.mock.calls.some(([query]) => String(query).includes('system_status'))).toBe(false);
    expect(dbQueryMock).toHaveBeenCalledTimes(7);

    await app.close();
  });

  it('returns a controlled error for invalid score timestamps', async () => {
    dbQueryMock
      .mockResolvedValueOnce({ rows: [{ id: 3, description: 'epoch' }] })
      .mockResolvedValueOnce({
        rows: [
          {
            post_uri: 'at://did:plc:a/app.bsky.feed.post/1',
            epoch_id: 3,
            total_score: 0.7,
            scored_at: 'not-a-date',
            classification_method: 'keyword',
            component_details: { run_id: 'run-3' },
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { component_key: 'recency', raw: '0.8', weight: '0.2', weighted: '0.16' },
          { component_key: 'engagement', raw: '0.6', weight: '0.2', weighted: '0.12' },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ rank: '2' }] })
      .mockResolvedValueOnce({ rows: [{ count: '4' }] });

    const app = Fastify();
    registerPostExplainRoute(app);

    const response = await app.inject({
      method: 'GET',
      url: `/api/transparency/post/${encodeURIComponent('at://did:plc:a/app.bsky.feed.post/1')}`,
    });

    expect(response.statusCode).toBe(503);
    const body = JSON.parse(response.body) as { error: string };
    expect(body.error).toBe('ScoreTimestampInvalid');

    await app.close();
  });
});
