import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbQueryMock, redisEvalMock } = vi.hoisted(() => ({ dbQueryMock: vi.fn(), redisEvalMock: vi.fn() }));
vi.mock('../src/db/client.js', () => ({ db: { query: dbQueryMock } }));
vi.mock('../src/db/redis.js', () => ({ redis: { eval: redisEvalMock } }));

// The test uses actual config parsing and the actual route/helper implementations.
// Values keep this isolated process pointed at synthetic endpoints; no service is contacted.
process.env.FEEDGEN_SERVICE_DID = 'did:plc:integrationtest';
process.env.FEEDGEN_PUBLISHER_DID = 'did:plc:integrationtest';
process.env.FEEDGEN_HOSTNAME = 'localhost';
process.env.JETSTREAM_URL = 'wss://jetstream.invalid';
process.env.JETSTREAM_FALLBACK_URL = 'wss://jetstream-fallback.invalid';
process.env.JETSTREAM_COLLECTIONS = 'app.bsky.feed.post';
process.env.DATABASE_URL = 'postgresql://127.0.0.1/integration_test';
process.env.REDIS_URL = 'redis://127.0.0.1:6379';

const { config } = await import('../src/config.js');
const { registerFeedSnapshotRoute } = await import('../src/transparency/routes/feed-snapshot.js');

const hiddenPosition = 25;
const hiddenUri = `at://did:plc:integrationtest/app.bsky.feed.post/${hiddenPosition}`;
const weights = { recency: 1, engagement: 0, bridging: 0, source_diversity: 0, relevance: 0 };

function postUri(position: number): string {
  return `at://did:plc:integrationtest/app.bsky.feed.post/${position}`;
}

function publicationEnvelope(): string {
  const ranked = Array.from({ length: 50 }, (_value, index) => {
    const position = index + 1;
    const uri = postUri(position);
    const score = (101 - position) / 101;
    const explanation = {
      post_uri: uri,
      ranked_position: position,
      base_score: score,
      publication_adjustment: 1,
      final_score: score,
      components: {
        recency: { raw_score: score, weight: 1, weighted: score },
        engagement: { raw_score: 0, weight: 0, weighted: 0 },
        bridging: { raw_score: 0, weight: 0, weighted: 0 },
        source_diversity: { raw_score: 0, weight: 0, weighted: 0 },
        relevance: { raw_score: 0, weight: 0, weighted: 0 },
      },
      source_score_run_id: `integration-score-run-${position}`,
      scored_at: '2026-09-02T00:00:00.000Z',
      epoch_id: 2,
      classification_method: 'keyword',
      engagement_only_position: position,
    };
    return { postUri: uri, redisScore: String(score), explanation: JSON.stringify(explanation) };
  });
  return JSON.stringify({
    snapshots: [{
      status: 'current',
      epochId: '2',
      publicationRunId: 'integration-publication-run',
      publishedAt: '2026-09-02T00:05:00.000Z',
      totalPublishedItems: '50',
      schemaVersion: '1',
      digest: 'a'.repeat(64),
      weights: JSON.stringify(weights),
      ranked,
    }],
    pinnedAnnouncement: null,
  });
}

function appViewPost(uri: string): Record<string, unknown> {
  const position = Number(uri.split('/').at(-1));
  return {
    uri,
    cid: `synthetic-cid-${position}`,
    author: {
      did: 'did:plc:integrationtest',
      handle: position === hiddenPosition ? 'opted-out.synthetic.test' : 'public.synthetic.test',
      labels: position === hiddenPosition ? [{ val: '!no-unauthenticated' }] : [],
    },
    record: { text: position === hiddenPosition ? 'PRIVATE OPTED-OUT CONTENT SENTINEL' : `Public synthetic post ${position}` },
  };
}

describe('actual public eligibility helper through Fastify feed snapshot route', () => {
  beforeEach(() => {
    config.FEED_PRIVATE_MODE = false;
    redisEvalMock.mockReset().mockResolvedValue(publicationEnvelope());
    dbQueryMock.mockReset().mockImplementation((query: { values: [string[], string[]] }) => Promise.resolve({
      rows: query.values[0].map((uri) => ({ uri, has_live_post: true, denied: false })),
    }));
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string | URL | Request) => {
      const requestedUris = new URL(String(input)).searchParams.getAll('uris');
      return Promise.resolve(Response.json({ posts: requestedUris.map(appViewPost) }));
    }));
  });

  it('withholds an opted-out author in one of fifty published slots without changing positions or disclosing its receipt', async () => {
    const app = Fastify();
    registerFeedSnapshotRoute(app);
    try {
      const response = await app.inject({ method: 'GET', url: '/api/transparency/feed-snapshot?limit=50' });
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json();
      expect(body.items).toHaveLength(50);
      expect(body.items.map((item: { position: number }) => item.position))
        .toEqual(Array.from({ length: 50 }, (_value, index) => index + 1));
      expect(body.items[hiddenPosition - 1]).toEqual({
        position: hiddenPosition,
        placement: 'withheld',
        reason: 'Post withheld from the public view',
      });
      expect(response.body).not.toContain(hiddenUri);
      expect(response.body).not.toContain('opted-out.synthetic.test');
      expect(response.body).not.toContain('PRIVATE OPTED-OUT CONTENT SENTINEL');
      expect(response.body).not.toContain(`integration-score-run-${hiddenPosition}`);
      expect(response.body).not.toContain(String((101 - hiddenPosition) / 101));
      expect(body.items[hiddenPosition - 2]).toMatchObject({ position: hiddenPosition - 1, post_uri: postUri(hiddenPosition - 1) });
      expect(body.items[hiddenPosition]).toMatchObject({ position: hiddenPosition + 1, post_uri: postUri(hiddenPosition + 1) });

      const fetchMock = vi.mocked(fetch);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).searchParams.getAll('uris').length)).toEqual([25, 25]);
      expect(dbQueryMock).toHaveBeenCalledTimes(1);
      const queriedUris = dbQueryMock.mock.calls[0][0].values[0] as string[];
      expect(queriedUris).toHaveLength(49);
      expect(queriedUris).not.toContain(hiddenUri);
      expect(redisEvalMock).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
      vi.unstubAllGlobals();
    }
  });
});
