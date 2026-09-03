import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { configMock, redisEvalMock } = vi.hoisted(() => ({
  configMock: {
    FEEDGEN_PUBLISHER_DID: 'did:plc:corgitestpublisher',
    FEED_PRIVATE_MODE: false,
    SCORING_INTERVAL_MS: 300_000,
  },
  redisEvalMock: vi.fn(),
}));

vi.mock('../src/config.js', () => ({
  config: configMock,
}));

vi.mock('../src/db/redis.js', () => ({
  redis: { eval: redisEvalMock },
}));

vi.mock('../src/lib/logger.js', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { registerFeedSnapshotRoute } from '../src/transparency/routes/feed-snapshot.js';
import { readPublishedPostSnapshotReceipt } from '../src/transparency/feed-snapshot-store.js';

const weights = {
  recency: 1,
  engagement: 0,
  bridging: 0,
  source_diversity: 0,
  relevance: 0,
};

function explanation(postUri: string, rankedPosition: number, score: number): Record<string, unknown> {
  return {
    post_uri: postUri,
    ranked_position: rankedPosition,
    base_score: score,
    publication_adjustment: 1,
    final_score: score,
    components: {
      recency: { raw_score: score, weight: 1, weighted: score },
      engagement: { raw_score: rankedPosition === 1 ? 0.2 : 0.8, weight: 0, weighted: 0 },
      bridging: { raw_score: 0, weight: 0, weighted: 0 },
      source_diversity: { raw_score: 0, weight: 0, weighted: 0 },
      relevance: { raw_score: 0, weight: 0, weighted: 0 },
    },
    source_score_run_id: `score-run-${rankedPosition}`,
    scored_at: '2026-09-02T00:00:00.000Z',
    epoch_id: 2,
    classification_method: 'keyword',
    engagement_only_position: rankedPosition === 1 ? 2 : 1,
  };
}

function snapshotEnvelope(status: 'current' | 'last_known_good'): Record<string, unknown> {
  const first = explanation('at://did:plc:test/app.bsky.feed.post/1', 1, 0.5);
  const second = explanation('at://did:plc:test/app.bsky.feed.post/2', 2, 0.4);
  return {
    status,
    epochId: '2',
    publicationRunId: status === 'current' ? 'publication-run-1' : 'publication-run-lkg',
    publishedAt: '2026-09-02T00:05:00.000Z',
    totalPublishedItems: '2',
    schemaVersion: '1',
    digest: 'a'.repeat(64),
    weights: JSON.stringify(weights),
    ranked: [
      { postUri: first.post_uri, redisScore: '0.5', explanation: JSON.stringify(first) },
      { postUri: second.post_uri, redisScore: '0.4', explanation: JSON.stringify(second) },
    ],
  };
}

function snapshotResult(
  snapshots: readonly Record<string, unknown>[],
  pinnedAnnouncement: string | null
): string {
  return JSON.stringify({ snapshots, pinnedAnnouncement });
}

function currentEnvelope(pinnedAnnouncement: string | null): string {
  return snapshotResult([snapshotEnvelope('current')], pinnedAnnouncement);
}

function publishedPostCandidate(
  snapshotStatus: 'current' | 'last_known_good',
  explanationValue: Record<string, unknown>,
  activeWeights: typeof weights
): Record<string, unknown> {
  return {
    snapshotStatus,
    found: true,
    explanation: JSON.stringify(explanationValue),
    redisScore: String(explanationValue.final_score),
    reverseRank: Number(explanationValue.ranked_position) - 1,
    epochId: '2',
    schemaVersion: '1',
    digest: snapshotStatus === 'current' ? 'a'.repeat(64) : 'b'.repeat(64),
    weights: JSON.stringify(activeWeights),
    pinnedReverseRank: false,
    publicationRunId: snapshotStatus === 'current' ? 'publication-run-1' : 'publication-run-lkg',
    publishedAt: '2026-09-02T00:05:00.000Z',
  };
}

describe('public transparency feed snapshot', () => {
  beforeEach(() => {
    configMock.FEED_PRIVATE_MODE = false;
    redisEvalMock.mockReset();
  });

  it('serves one anonymous ordered snapshot with a scoreless pinned announcement', async () => {
    redisEvalMock.mockResolvedValue(currentEnvelope(JSON.stringify({
      uri: 'at://did:plc:corgi/app.bsky.feed.post/announcement',
    })));
    const app = Fastify();
    registerFeedSnapshotRoute(app);

    const response = await app.inject({ method: 'GET', url: '/api/transparency/feed-snapshot?limit=2' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('public, max-age=30, stale-while-revalidate=60');
    expect(response.headers.etag).toMatch(/^"[0-9a-f]{64}-2"$/);
    const body = response.json();
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toMatchObject({
      position: 1,
      ranked_position: null,
      placement: 'pinned_announcement',
      base_score: null,
      components: null,
    });
    expect(body.items[1]).toMatchObject({
      position: 2,
      epoch_id: 2,
      ranked_position: 1,
      placement: 'ranked',
      final_score: 0.5,
    });
    expect(JSON.stringify(body)).not.toContain('component_details');
    expect(redisEvalMock).toHaveBeenCalledTimes(1);
    const snapshotCall = redisEvalMock.mock.calls[0] as unknown[];
    expect(snapshotCall[0]).toEqual(expect.stringContaining('explanationSealMatches'));
    expect(snapshotCall[0]).toEqual(expect.stringContaining('redis.sha1hex'));
    expect(snapshotCall[1]).toBe(23);
    expect(snapshotCall).toContain('feed:explanation_seals');
    expect(snapshotCall).toContain('feed:last_known_good_explanation_seals');
    await app.close();
  });

  it('preserves the scoring receipt when the pinned announcement is already ranked', async () => {
    const rankedPinnedUri = 'at://did:plc:test/app.bsky.feed.post/2';
    redisEvalMock.mockResolvedValue(currentEnvelope(JSON.stringify({ uri: rankedPinnedUri })));
    const app = Fastify();
    registerFeedSnapshotRoute(app);

    const response = await app.inject({ method: 'GET', url: '/api/transparency/feed-snapshot?limit=2' });

    expect(response.statusCode).toBe(200);
    expect(response.json().items[1]).toMatchObject({
      position: 2,
      epoch_id: 2,
      ranked_position: 2,
      placement: 'pinned_announcement',
      post_uri: rankedPinnedUri,
      base_score: 0.4,
      final_score: 0.4,
      components: {
        recency: { raw_score: 0.4, weight: 1, weighted: 0.4 },
      },
      source_score_run_id: 'score-run-2',
      engagement_only_position: 1,
    });
    await app.close();
  });

  it('supports conditional 304 responses without returning a body', async () => {
    redisEvalMock.mockResolvedValue(currentEnvelope(null));
    const app = Fastify();
    registerFeedSnapshotRoute(app);
    const first = await app.inject({ method: 'GET', url: '/api/transparency/feed-snapshot' });

    const conditional = await app.inject({
      method: 'GET',
      url: '/api/transparency/feed-snapshot',
      headers: { 'if-none-match': first.headers.etag as string },
    });

    expect(conditional.statusCode).toBe(304);
    expect(conditional.body).toBe('');
    await app.close();
  });

  it('returns a degraded last-known-good representation instead of 304', async () => {
    redisEvalMock
      .mockResolvedValueOnce(currentEnvelope(null))
      .mockResolvedValueOnce(snapshotResult([snapshotEnvelope('last_known_good')], null));
    const app = Fastify();
    registerFeedSnapshotRoute(app);
    const current = await app.inject({ method: 'GET', url: '/api/transparency/feed-snapshot' });

    const degraded = await app.inject({
      method: 'GET',
      url: '/api/transparency/feed-snapshot',
      headers: { 'if-none-match': current.headers.etag as string },
    });

    expect(degraded.statusCode).toBe(200);
    expect(degraded.headers.etag).not.toBe(current.headers.etag);
    expect(degraded.json()).toMatchObject({ status: 'last_known_good' });
    await app.close();
  });

  it('uses representation-specific ETags for different limits', async () => {
    redisEvalMock.mockResolvedValue(currentEnvelope(null));
    const app = Fastify();
    registerFeedSnapshotRoute(app);

    const oneItem = await app.inject({
      method: 'GET',
      url: '/api/transparency/feed-snapshot?limit=1',
    });
    const twoItems = await app.inject({
      method: 'GET',
      url: '/api/transparency/feed-snapshot?limit=2',
    });

    expect(oneItem.headers.etag).toMatch(/-1"$/);
    expect(twoItems.headers.etag).toMatch(/-2"$/);
    expect(oneItem.headers.etag).not.toBe(twoItems.headers.etag);
    await app.close();
  });

  it.each(['51', '0', '-1', '1.5', 'abc', ''])(
    'rejects limit=%s before touching Redis',
    async (limit) => {
    const app = Fastify();
    registerFeedSnapshotRoute(app);
    const response = await app.inject({
      method: 'GET',
      url: `/api/transparency/feed-snapshot?limit=${limit}`,
    });
    expect(response.statusCode).toBe(400);
    expect(redisEvalMock).not.toHaveBeenCalled();
    await app.close();
    }
  );

  it('accepts the maximum limit without clamping it', async () => {
    redisEvalMock.mockResolvedValue(currentEnvelope(null));
    const app = Fastify();
    registerFeedSnapshotRoute(app);
    const response = await app.inject({
      method: 'GET',
      url: '/api/transparency/feed-snapshot?limit=50',
    });
    expect(response.statusCode).toBe(200);
    expect(redisEvalMock.mock.calls[0].at(-1)).toBe('50');
    await app.close();
  });

  it('fails closed in private mode before touching Redis', async () => {
    configMock.FEED_PRIVATE_MODE = true;
    const app = Fastify();
    registerFeedSnapshotRoute(app);

    const response = await app.inject({ method: 'GET', url: '/api/transparency/feed-snapshot' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: 'TransparencySnapshotUnavailable' });
    expect(redisEvalMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns explicit 503 when no complete current or last-known-good artifact exists', async () => {
    redisEvalMock.mockResolvedValue(snapshotResult([], null));
    const app = Fastify();
    registerFeedSnapshotRoute(app);
    const response = await app.inject({ method: 'GET', url: '/api/transparency/feed-snapshot' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: 'TransparencySnapshotUnavailable' });
    await app.close();
  });

  it('returns 503 when Redis reports a sealed snapshot integrity failure', async () => {
    redisEvalMock.mockResolvedValue(JSON.stringify({
      snapshots: [],
      pinnedAnnouncement: null,
      unavailable: true,
    }));
    const app = Fastify();
    registerFeedSnapshotRoute(app);
    const response = await app.inject({ method: 'GET', url: '/api/transparency/feed-snapshot' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: 'TransparencySnapshotIntegrityFailure' });
    await app.close();
  });

  it('serves a structurally complete last-known-good artifact', async () => {
    redisEvalMock.mockResolvedValue(snapshotResult([snapshotEnvelope('last_known_good')], null));
    const app = Fastify();
    registerFeedSnapshotRoute(app);

    const response = await app.inject({ method: 'GET', url: '/api/transparency/feed-snapshot?limit=2' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'last_known_good',
      publication_run_id: 'publication-run-lkg',
    });
    await app.close();
  });

  it('falls back to valid last-known-good when current fails semantic validation', async () => {
    const malformedCurrent = snapshotEnvelope('current');
    const ranked = malformedCurrent.ranked as Array<Record<string, unknown>>;
    const firstExplanation = JSON.parse(ranked[0].explanation as string) as Record<string, unknown>;
    firstExplanation.final_score = 999;
    ranked[0].explanation = JSON.stringify(firstExplanation);
    redisEvalMock.mockResolvedValue(snapshotResult([
      malformedCurrent,
      snapshotEnvelope('last_known_good'),
    ], null));
    const app = Fastify();
    registerFeedSnapshotRoute(app);

    const response = await app.inject({ method: 'GET', url: '/api/transparency/feed-snapshot?limit=2' });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('last_known_good');
    expect(redisEvalMock).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('returns 503 when list order and embedded rank disagree', async () => {
    const mismatched = snapshotEnvelope('current');
    (mismatched.ranked as unknown[]).reverse();
    redisEvalMock.mockResolvedValue(snapshotResult([mismatched], null));
    const app = Fastify();
    registerFeedSnapshotRoute(app);

    const response = await app.inject({ method: 'GET', url: '/api/transparency/feed-snapshot?limit=2' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: 'TransparencySnapshotIntegrityFailure' });
    await app.close();
  });

  it('returns 503 for weight, score-math, or digest disagreement', async () => {
    const invalidSnapshots = [
      (snapshot: Record<string, unknown>) => {
        snapshot.digest = 'not-a-digest';
      },
      (snapshot: Record<string, unknown>) => {
        const ranked = snapshot.ranked as Array<Record<string, unknown>>;
        const item = JSON.parse(ranked[0].explanation as string) as Record<string, unknown>;
        const components = item.components as Record<string, Record<string, number>>;
        components.recency.weight = 0.5;
        ranked[0].explanation = JSON.stringify(item);
      },
      (snapshot: Record<string, unknown>) => {
        const ranked = snapshot.ranked as Array<Record<string, unknown>>;
        const item = JSON.parse(ranked[0].explanation as string) as Record<string, unknown>;
        item.base_score = 0.9;
        item.final_score = 0.9;
        ranked[0].redisScore = '0.9';
        ranked[0].explanation = JSON.stringify(item);
      },
      (snapshot: Record<string, unknown>) => {
        snapshot.weights = JSON.stringify({ ...weights, engagement: -0.1 });
      },
    ];

    for (const invalidate of invalidSnapshots) {
      const invalid = snapshotEnvelope('current');
      invalidate(invalid);
      redisEvalMock.mockResolvedValueOnce(snapshotResult([invalid], null));
      const app = Fastify();
      registerFeedSnapshotRoute(app);
      const response = await app.inject({ method: 'GET', url: '/api/transparency/feed-snapshot?limit=2' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: 'TransparencySnapshotIntegrityFailure' });
      await app.close();
    }
  });
});

describe('published post snapshot receipt', () => {
  beforeEach(() => {
    redisEvalMock.mockReset();
  });

  it('returns the exact current materialized receipt with bounded pin lookup', async () => {
    const postUri = 'at://did:plc:test/app.bsky.feed.post/1';
    redisEvalMock.mockResolvedValue(JSON.stringify({
      pinnedAnnouncement: JSON.stringify({ uri: 'at://did:plc:corgi/app.bsky.feed.post/pinned' }),
      snapshots: [{
        snapshotStatus: 'current',
        found: true,
        explanation: JSON.stringify(explanation(postUri, 1, 0.5)),
        redisScore: '0.5',
        reverseRank: 0,
        epochId: '2',
        schemaVersion: '1',
        digest: 'a'.repeat(64),
        weights: JSON.stringify(weights),
        pinnedReverseRank: false,
        publicationRunId: 'publication-run-1',
        publishedAt: '2026-09-02T00:05:00.000Z',
      }],
    }));

    const receipt = await readPublishedPostSnapshotReceipt(postUri, 50);

    expect(receipt).toMatchObject({
      snapshotStatus: 'current',
      publishedPosition: 2,
      explanation: { post_uri: postUri, ranked_position: 1 },
      activeWeights: weights,
    });
    expect(receipt?.presentationSnapshotId).toMatch(/^[0-9a-f]{64}$/);
    const script = redisEvalMock.mock.calls[0][0] as string;
    expect(script).toContain("redis.call('LRANGE', KEYS[offset + 1], 0, viewDepth - 1)");
    expect(script).toContain('explanationSealMatches');
    expect(script).toContain('redis.sha1hex');
    expect(script).not.toContain('LPOS');
    const receiptCall = redisEvalMock.mock.calls[0] as unknown[];
    expect(receiptCall[1]).toBe(23);
    expect(receiptCall).toContain('feed:explanation_seals');
    expect(receiptCall).toContain('feed:last_known_good_explanation_seals');
    expect(receiptCall.at(-1)).toBe('50');
  });

  it('uses the requested presentation depth when deciding whether the pin is inserted', async () => {
    const postUri = 'at://did:plc:test/app.bsky.feed.post/1';
    const candidate = publishedPostCandidate('current', explanation(postUri, 1, 0.5), weights);
    candidate.pinnedReverseRank = 30;
    redisEvalMock.mockResolvedValue(JSON.stringify({
      pinnedAnnouncement: JSON.stringify({ uri: 'at://did:plc:corgi/app.bsky.feed.post/pinned' }),
      snapshots: [candidate],
    }));

    await expect(readPublishedPostSnapshotReceipt(postUri, 20)).resolves.toMatchObject({
      publishedPosition: 2,
    });
    expect(redisEvalMock.mock.calls[0].at(-1)).toBe('20');

    await expect(readPublishedPostSnapshotReceipt(postUri, 100)).resolves.toMatchObject({
      publishedPosition: 1,
    });
    expect(redisEvalMock.mock.calls[1].at(-1)).toBe('100');
  });

  it('falls back for a ranked item displaced beyond the requested presentation depth', async () => {
    const postUri = 'at://did:plc:test/app.bsky.feed.post/boundary';
    const pinnedUri = 'at://did:plc:corgi/app.bsky.feed.post/pinned';
    const displaced = publishedPostCandidate('current', explanation(postUri, 50, 0.5), weights);
    displaced.reverseRank = 49;
    redisEvalMock.mockResolvedValueOnce(JSON.stringify({
      pinnedAnnouncement: JSON.stringify({ uri: pinnedUri }),
      snapshots: [displaced],
    }));

    await expect(readPublishedPostSnapshotReceipt(postUri, 50)).resolves.toBeNull();

    const boundary = publishedPostCandidate('current', explanation(postUri, 49, 0.5), weights);
    boundary.reverseRank = 48;
    redisEvalMock.mockResolvedValueOnce(JSON.stringify({
      pinnedAnnouncement: JSON.stringify({ uri: pinnedUri }),
      snapshots: [boundary],
    }));
    await expect(readPublishedPostSnapshotReceipt(postUri, 50)).resolves.toMatchObject({
      publishedPosition: 50,
    });
  });

  it('keeps the ranked position when the published post is the already-ranked announcement', async () => {
    const postUri = 'at://did:plc:test/app.bsky.feed.post/1';
    const candidate = publishedPostCandidate('current', explanation(postUri, 1, 0.5), weights);
    candidate.pinnedReverseRank = 0;
    redisEvalMock.mockResolvedValue(JSON.stringify({
      pinnedAnnouncement: JSON.stringify({ uri: postUri }),
      snapshots: [candidate],
    }));

    const receipt = await readPublishedPostSnapshotReceipt(postUri, 50);

    expect(receipt).toMatchObject({
      snapshotStatus: 'current',
      publishedPosition: 1,
      explanation: {
        post_uri: postUri,
        ranked_position: 1,
        base_score: 0.5,
        final_score: 0.5,
      },
    });
  });

  it('rejects a current receipt whose active weights disagree', async () => {
    const postUri = 'at://did:plc:test/app.bsky.feed.post/1';
    redisEvalMock.mockResolvedValue(JSON.stringify({
      pinnedAnnouncement: null,
      snapshots: [{
        snapshotStatus: 'current',
        found: true,
        explanation: JSON.stringify(explanation(postUri, 1, 0.5)),
        redisScore: '0.5',
        reverseRank: 0,
        epochId: '2',
        schemaVersion: '1',
        digest: 'a'.repeat(64),
        weights: JSON.stringify({ ...weights, recency: 0.5 }),
        pinnedReverseRank: false,
        publicationRunId: 'publication-run-1',
        publishedAt: '2026-09-02T00:05:00.000Z',
      }],
    }));

    await expect(readPublishedPostSnapshotReceipt(postUri, 50)).rejects.toThrow(/disagrees with active weight/);
  });

  it('selects the same valid last-known-good publication as the batch reader', async () => {
    const postUri = 'at://did:plc:test/app.bsky.feed.post/1';
    const invalidCurrentExplanation = explanation(postUri, 1, 0.5);
    invalidCurrentExplanation.final_score = 999;
    const validLastKnownGoodExplanation = explanation(postUri, 1, 0.5);
    redisEvalMock.mockResolvedValue(JSON.stringify({
      pinnedAnnouncement: null,
      snapshots: [
        publishedPostCandidate('current', invalidCurrentExplanation, weights),
        publishedPostCandidate('last_known_good', validLastKnownGoodExplanation, weights),
      ],
    }));

    const receipt = await readPublishedPostSnapshotReceipt(postUri, 50);

    expect(receipt).toMatchObject({
      snapshotStatus: 'last_known_good',
      publishedPosition: 1,
      explanation: { post_uri: postUri, final_score: 0.5 },
    });
  });

  it('distinguishes a healthy off-snapshot post from an unavailable publication', async () => {
    const postUri = 'at://did:plc:test/app.bsky.feed.post/missing';
    redisEvalMock.mockResolvedValueOnce(JSON.stringify({
      snapshots: [{ snapshotStatus: 'current', found: false }],
      pinnedAnnouncement: null,
    }));
    await expect(readPublishedPostSnapshotReceipt(postUri, 50)).resolves.toBeNull();

    redisEvalMock.mockResolvedValueOnce(JSON.stringify({ snapshots: [], pinnedAnnouncement: null }));
    await expect(readPublishedPostSnapshotReceipt(postUri, 50)).resolves.toBeNull();

    redisEvalMock.mockResolvedValueOnce(JSON.stringify({
      snapshots: [],
      pinnedAnnouncement: null,
      unavailable: true,
    }));
    await expect(readPublishedPostSnapshotReceipt(postUri, 50)).rejects.toThrow(
      /snapshot is incomplete/
    );
  });
});
