import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbQueryMock } = vi.hoisted(() => ({
  dbQueryMock: vi.fn(),
}));
const { redisEvalMock } = vi.hoisted(() => ({ redisEvalMock: vi.fn() }));

vi.mock('../src/db/client.js', () => ({
  db: {
    query: dbQueryMock,
  },
}));

vi.mock('../src/db/redis.js', () => ({ redis: { eval: redisEvalMock } }));

import { registerPostExplainRoute } from '../src/transparency/routes/post-explain.js';

function publishedReceiptEnvelope(postUri: string, digest = 'a'.repeat(64)): string {
  const components = {
    recency: { raw_score: 0.5, weight: 1, weighted: 0.5 },
    engagement: { raw_score: 0.8, weight: 0, weighted: 0 },
    bridging: { raw_score: 0, weight: 0, weighted: 0 },
    source_diversity: { raw_score: 0, weight: 0, weighted: 0 },
    relevance: { raw_score: 0, weight: 0, weighted: 0 },
  };
  return JSON.stringify({
    pinnedAnnouncement: null,
    snapshots: [{
      snapshotStatus: 'current',
      found: true,
      explanation: JSON.stringify({
        post_uri: postUri,
        epoch_id: 2,
        ranked_position: 1,
        base_score: 0.5,
        publication_adjustment: 1,
        final_score: 0.5,
        components,
        source_score_run_id: 'score-run-1',
        scored_at: '2026-09-02T00:00:00.000Z',
        classification_method: 'keyword',
        engagement_only_position: 2,
      }),
      redisScore: '0.5',
      reverseRank: 0,
      epochId: '2',
      schemaVersion: '1',
      digest,
      weights: JSON.stringify({
        recency: 1,
        engagement: 0,
        bridging: 0,
        source_diversity: 0,
        relevance: 0,
      }),
      pinnedReverseRank: false,
      publicationRunId: 'publication-run-1',
      publishedAt: '2026-09-02T00:05:00.000Z',
    }],
  });
}

describe('post explain URI validation', () => {
  beforeEach(() => {
    dbQueryMock.mockReset();
    redisEvalMock.mockReset().mockResolvedValue(JSON.stringify({
      snapshots: [{ snapshotStatus: 'current', found: false }],
      pinnedAnnouncement: null,
    }));
  });

  it('returns 400 when post URI encoding is malformed', async () => {
    const app = Fastify();
    registerPostExplainRoute(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/transparency/post/%E0%A4%A',
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error).toBeDefined();
    expect(dbQueryMock).not.toHaveBeenCalled();

    await app.close();
  });

  it('continues normal flow for valid URI encoding', async () => {
    dbQueryMock
      .mockResolvedValueOnce({ rows: [{ id: 5 }] })
      .mockResolvedValueOnce({ rows: [] });

    const app = Fastify();
    registerPostExplainRoute(app);

    const response = await app.inject({
      method: 'GET',
      url: `/api/transparency/post/${encodeURIComponent('at://did:plc:user/app.bsky.feed.post/abc')}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: 'NotFound',
    });

    await app.close();
  });

  it('uses the legacy score-run path when no materialized publication exists', async () => {
    redisEvalMock.mockResolvedValue(JSON.stringify({ snapshots: [], pinnedAnnouncement: null }));
    dbQueryMock
      .mockResolvedValueOnce({ rows: [{ id: 5 }] })
      .mockResolvedValueOnce({ rows: [] });
    const app = Fastify();
    registerPostExplainRoute(app);

    const response = await app.inject({
      method: 'GET',
      url: `/api/transparency/post/${encodeURIComponent('at://did:plc:user/app.bsky.feed.post/abc')}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'NotFound' });
    expect(dbQueryMock).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it('returns 503 instead of hiding a materialized publication integrity failure', async () => {
    redisEvalMock.mockResolvedValue(JSON.stringify({
      snapshots: [],
      pinnedAnnouncement: null,
      unavailable: true,
    }));
    const app = Fastify();
    registerPostExplainRoute(app);

    const response = await app.inject({
      method: 'GET',
      url: `/api/transparency/post/${encodeURIComponent('at://did:plc:user/app.bsky.feed.post/abc')}`,
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: 'TransparencySnapshotIntegrityFailure' });
    expect(dbQueryMock).not.toHaveBeenCalled();
    await app.close();
  });

  it.each(['not-a-digest', 'A'.repeat(64)])(
    'returns 503 instead of falling back for invalid publication digest %s',
    async (digest) => {
      const postUri = 'at://did:plc:user/app.bsky.feed.post/published';
      redisEvalMock.mockResolvedValue(publishedReceiptEnvelope(postUri, digest));
      const app = Fastify();
      registerPostExplainRoute(app);

      const response = await app.inject({
        method: 'GET',
        url: `/api/transparency/post/${encodeURIComponent(postUri)}`,
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: 'TransparencySnapshotIntegrityFailure' });
      expect(dbQueryMock).not.toHaveBeenCalled();
      await app.close();
    }
  );

  it('preserves the legacy score-run path when the Redis receipt lookup is unavailable', async () => {
    redisEvalMock.mockRejectedValue(new Error('Redis unavailable'));
    dbQueryMock
      .mockResolvedValueOnce({ rows: [{ id: 5 }] })
      .mockResolvedValueOnce({ rows: [] });
    const app = Fastify();
    registerPostExplainRoute(app);

    const response = await app.inject({
      method: 'GET',
      url: `/api/transparency/post/${encodeURIComponent('at://did:plc:user/app.bsky.feed.post/abc')}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'NotFound' });
    expect(dbQueryMock).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it('returns the exact published snapshot receipt without querying PostgreSQL', async () => {
    const postUri = 'at://did:plc:user/app.bsky.feed.post/published';
    redisEvalMock.mockResolvedValue(publishedReceiptEnvelope(postUri));
    const app = Fastify();
    registerPostExplainRoute(app);

    const response = await app.inject({
      method: 'GET',
      url: `/api/transparency/post/${encodeURIComponent(postUri)}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      post_uri: postUri,
      epoch_id: 2,
      rank: 1,
      rank_scope: 'published_snapshot',
      published_position: 1,
      counterfactual: { pure_engagement_rank: 2 },
    });
    expect(dbQueryMock).not.toHaveBeenCalled();
    await app.close();
  });
});
