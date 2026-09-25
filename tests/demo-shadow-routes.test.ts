import { describe, expect, it, vi } from 'vitest';
import swagger from '@fastify/swagger';
import { ShadowDemoService } from '../src/demo/service.js';
import { MemoryDemoStore } from '../src/demo/store.js';
import { DemoStoreUnavailableError } from '../src/demo/store.js';
import { registerShadowDemoRoutes } from '../src/demo/routes.js';
import { isPayloadTooLargeError } from '../src/feed/error-classification.js';
import { DemoRateLimitError, type DemoRateLimitGuard } from '../src/demo/rate-limit.js';
import type {
  ShadowDemoCommunityId,
  ShadowDemoCorpus,
  ShadowDemoEnvelope,
  ShadowDemoSessionPayload,
} from '../src/demo/types.js';
import {
  SHADOW_DEMO_GUIDED_EPOCHS,
  SHADOW_DEMO_MAX_EPOCHS_PER_SESSION,
  SHADOW_DEMO_SHARED_CORPUS_TTL_SECONDS,
  SHADOW_DEMO_SYNTHETIC_VOTER_COUNT,
  SHADOW_DEMO_TOTAL_DEMO_VOTERS,
} from '../src/demo/types.js';
import { buildTestApp } from './helpers/index.js';

const NOW = new Date('2026-07-09T12:00:00.000Z');

describe('shadow demo routes', () => {
  it('distinguishes omitted, disabled, and injected demo services', async () => {
    const omitted = buildTestApp();
    const disabled = buildTestApp();
    const injected = buildTestApp();
    const service = new ShadowDemoService({
      projectDisplay: async (_corpus, items) => new Map(items.map((item) => [item.postUri, item.displayPost])),
      store: new MemoryDemoStore(),
      loadCorpus: async () => demoCorpus(),
      now: () => NOW,
    });
    try {
      registerShadowDemoRoutes(omitted, undefined, null);
      registerShadowDemoRoutes(disabled, null, null);
      registerShadowDemoRoutes(injected, service, null);

      expect(omitted.hasRoute({ method: 'POST', url: '/api/demo/sessions' })).toBe(true);
      expect(disabled.hasRoute({ method: 'POST', url: '/api/demo/sessions' })).toBe(false);
      expect(injected.hasRoute({ method: 'POST', url: '/api/demo/sessions' })).toBe(true);
    } finally {
      await omitted.close();
      await disabled.close();
      await injected.close();
    }
  });

  it('preserves Fastify body-limit errors as production HTTP 413 classifications', () => {
    const byCode = Object.assign(new Error('body too large'), { code: 'FST_ERR_CTP_BODY_TOO_LARGE' });
    const byStatus = Object.assign(new Error('body too large'), { statusCode: 413 });
    expect(isPayloadTooLargeError(byCode)).toBe(true);
    expect(isPayloadTooLargeError(byStatus)).toBe(true);
    expect(isPayloadTooLargeError(new Error('other failure'))).toBe(false);
  });

  it('publishes demo endpoints under the Demo OpenAPI tag', async () => {
    const app = buildTestApp();
    await app.register(swagger, {
      openapi: {
        info: { title: 'Shadow demo test', version: '1.0.0' },
      },
    });
    const service = new ShadowDemoService({
      projectDisplay: async (_corpus, items) => new Map(items.map((item) => [item.postUri, item.displayPost])),
      store: new MemoryDemoStore(),
      loadCorpus: async () => demoCorpus(),
      now: () => NOW,
    });
    registerShadowDemoRoutes(app, service, null);
    await app.ready();

    const specification = app.swagger() as {
      paths?: Record<string, { post?: { tags?: string[] }; get?: { tags?: string[] } }>;
    };
    expect(specification.paths?.['/api/demo/sessions']?.post?.tags).toContain('Demo');
    expect(specification.paths?.['/api/demo/sessions/{sessionId}/feed']?.get?.tags).toContain('Demo');

    await app.close();
  });

  it('returns a generic conflict without exposing a session on nonce reuse', async () => {
    const app = buildTestApp();
    const loadCorpus = vi.fn(async () => demoCorpus());
    const service = new ShadowDemoService({
      projectDisplay: async (_corpus, items) => new Map(items.map((item) => [item.postUri, item.displayPost])),
      store: new MemoryDemoStore(),
      loadCorpus,
      now: () => NOW,
    });
    registerShadowDemoRoutes(app, service, null);
    const request = {
      method: 'POST' as const,
      url: '/api/demo/sessions',
      payload: { communityId: 'open_science_builders', clientNonce: 'lost-response-retry' },
    };

    const first = await app.inject(request);
    const duplicate = await app.inject(request);

    expect(first.statusCode).toBe(200);
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().message).toBe('Session creation nonce has already been used');
    expect(duplicate.body).not.toContain(first.json().payload.session.sessionId);
    expect(loadCorpus).toHaveBeenCalledOnce();
    await app.close();
  });

  it('requires a bounded client nonce for retry-safe session creation', async () => {
    const app = buildTestApp();
    registerShadowDemoRoutes(app, new ShadowDemoService({
      projectDisplay: async (_corpus, items) => new Map(items.map((item) => [item.postUri, item.displayPost])),
      store: new MemoryDemoStore(),
      loadCorpus: async () => demoCorpus(),
      now: () => NOW,
    }), null);

    const response = await app.inject({
      method: 'POST',
      url: '/api/demo/sessions',
      payload: { communityId: 'open_science_builders' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain('clientNonce: Required');
    await app.close();
  });

  it('allows only one concurrent creation request for a nonce', async () => {
    const app = buildTestApp();
    const loadCorpus = vi.fn(async () => demoCorpus());
    registerShadowDemoRoutes(app, new ShadowDemoService({
      projectDisplay: async (_corpus, items) => new Map(items.map((item) => [item.postUri, item.displayPost])),
      store: new MemoryDemoStore(),
      loadCorpus,
      now: () => NOW,
    }), null);
    const request = {
      method: 'POST' as const,
      url: '/api/demo/sessions',
      payload: { communityId: 'open_science_builders', clientNonce: 'concurrent-retry' },
    };

    const responses = await Promise.all([app.inject(request), app.inject(request)]);
    const statuses = responses.map((response) => response.statusCode).sort();

    expect(statuses).toEqual([200, 409]);
    const created = responses.find((response) => response.statusCode === 200);
    const conflict = responses.find((response) => response.statusCode === 409);
    expect(created).toBeDefined();
    expect(conflict?.body).not.toContain(created?.json().payload.session.sessionId);
    expect(loadCorpus).toHaveBeenCalledOnce();
    await app.close();
  });

  it('runs the reviewer vote, deterministic synthetic voters, epoch advance, feed, and receipt flow', async () => {
    const app = buildTestApp();
    const service = new ShadowDemoService({
      projectDisplay: async (_corpus, items) => new Map(items.map((item) => [item.postUri, item.displayPost])),
      store: new MemoryDemoStore(),
      loadCorpus: async () => demoCorpus(),
      now: () => NOW,
    });
    registerShadowDemoRoutes(app, service, null);

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/demo/sessions',
      payload: { communityId: 'open_science_builders', clientNonce: 'full-flow' },
    });
    expect(createResponse.statusCode).toBe(200);
    const createBody = createResponse.json() as ShadowDemoEnvelope<ShadowDemoSessionPayload>;
    const sessionId = createBody.payload.session.sessionId;
    const firstEpochId = createBody.payload.session.currentEpochId;
    expect(createBody.payload.session.maxEpochs).toBe(10);
    expect(createBody.payload.session.guidedEpochs).toBe(SHADOW_DEMO_GUIDED_EPOCHS);
    expect(createBody.payload.session.syntheticVoterCount).toBe(SHADOW_DEMO_SYNTHETIC_VOTER_COUNT);
    expect(createBody.payload.session.totalDemoVoters).toBe(SHADOW_DEMO_TOTAL_DEMO_VOTERS);
    expect(createBody.payload.session.corpusProvenance.description).toContain('frozen for this demo run');
    expect(createBody.payload.session.voterProfiles.map((profile) => profile.id)).toEqual([
      'research_practitioner',
      'dataset_steward',
      'current_awareness',
      'community_discussant',
      'interdisciplinary_connector',
    ]);

    const initialFeedResponse = await app.inject({
      method: 'GET',
      url: `/api/demo/sessions/${sessionId}/feed?limit=3`,
    });
    expect(initialFeedResponse.statusCode).toBe(200);
    expect(initialFeedResponse.json().payload.posts[0].post.uri).toBe('at://did:plc:demo2/app.bsky.feed.post/two');

    const votePayload = {
      baseEpochId: firstEpochId,
      idempotencyKey: 'vote-1',
      weights: {
        recency: 0,
        engagement: 0,
        bridging: 0,
        source_diversity: 0,
        relevance: 1,
      },
      topicIntent: {
        topicWeights: {
          'science-research': 0.9,
          'data-science': 0.85,
          'software-development': 0.7,
          'open-source': 0.8,
        },
      },
    };
    const voteResponse = await app.inject({
      method: 'POST',
      url: `/api/demo/sessions/${sessionId}/votes`,
      payload: votePayload,
    });
    expect(voteResponse.statusCode).toBe(200);
    expect(voteResponse.json().payload.session.voteCount).toBe(1);

    const repeatedVoteResponse = await app.inject({
      method: 'POST',
      url: `/api/demo/sessions/${sessionId}/votes`,
      payload: votePayload,
    });
    expect(repeatedVoteResponse.statusCode).toBe(200);
    expect(repeatedVoteResponse.json().payload.session.voteCount).toBe(1);

    const conflictingVoteResponse = await app.inject({
      method: 'POST',
      url: `/api/demo/sessions/${sessionId}/votes`,
      payload: {
        ...votePayload,
        weights: {
          recency: 1,
          engagement: 0,
          bridging: 0,
          source_diversity: 0,
          relevance: 0,
        },
      },
    });
    expect(conflictingVoteResponse.statusCode).toBe(409);

    const syntheticVotersResponse = await app.inject({
      method: 'POST',
      url: `/api/demo/sessions/${sessionId}/agents/run`,
      payload: {
        baseEpochId: firstEpochId,
        idempotencyKey: 'synthetic-voters-1', // gitleaks:allow -- deterministic test-only idempotency fixture
      },
    });
    expect(syntheticVotersResponse.statusCode).toBe(200);
    expect(syntheticVotersResponse.json().payload.session.voteCount).toBe(SHADOW_DEMO_TOTAL_DEMO_VOTERS);
    expect(syntheticVotersResponse.json().payload.session.votes).toHaveLength(SHADOW_DEMO_TOTAL_DEMO_VOTERS);
    expect(syntheticVotersResponse.json().payload.session.epochs[0].aggregate).toMatchObject({
      voteCount: 0,
      trimCount: 0,
    });
    expect(syntheticVotersResponse.json().payload.session.pendingAggregate).toMatchObject({
      voteCount: SHADOW_DEMO_TOTAL_DEMO_VOTERS,
      trimCount: 2,
    });

    const advanceResponse = await app.inject({
      method: 'POST',
      url: `/api/demo/sessions/${sessionId}/epochs/advance`,
      payload: {
        fromEpochId: firstEpochId,
        idempotencyKey: 'advance-1',
      },
    });
    expect(advanceResponse.statusCode).toBe(200);
    const nextEpochId = advanceResponse.json().payload.session.currentEpochId;
    expect(nextEpochId).not.toBe(firstEpochId);

    const rerankedFeedResponse = await app.inject({
      method: 'GET',
      url: `/api/demo/sessions/${sessionId}/feed?epochId=${nextEpochId}&limit=3`,
    });
    expect(rerankedFeedResponse.statusCode).toBe(200);
    const rerankedPosts = rerankedFeedResponse.json().payload.posts;
    const firstPost = rerankedPosts[0];
    expect(firstPost.post.kind).toBe('public_post');
    expect(firstPost.previousRank).toBeTypeOf('number');
    expect(rerankedPosts.some((post: { movement: number | null }) => post.movement !== null && post.movement !== 0)).toBe(true);

    const receiptResponse = await app.inject({
      method: 'GET',
      url: `/api/demo/sessions/${sessionId}/receipts?epochId=${nextEpochId}&postUri=${encodeURIComponent(firstPost.post.uri)}`,
    });
    expect(receiptResponse.statusCode).toBe(200);
    const receipt = receiptResponse.json().payload.receipt;
    const contributionSum = receipt.components.reduce(
      (sum: number, component: { contribution: number }) => sum + component.contribution,
      0
    );
    expect(contributionSum).toBeCloseTo(receipt.score, 5);
    expect(receipt.counterfactuals.map((entry: { label: string }) => entry.label)).toEqual([
      'previous_epoch',
      'engagement_only',
      'direct_reviewer_ballot_removed',
    ]);
    expect(receipt.aggregate).toMatchObject({ voteCount: 25, trimCount: 2 });
    expect(receipt.reviewerBallotShare).toBe(1 / 25);
    expect(receipt.topicRelevanceFormula.effectiveRelevance).toBeCloseTo(
      receipt.components.find((component: { signal: string }) => component.signal === 'relevance').rawScore,
      6
    );
    expect(receipt.provenance).toMatchObject({
      corpusId: createBody.payload.session.corpusProvenance.corpusId,
      productionEpochId: 2,
      shadowEpochId: nextEpochId,
    });

    const staleVoteResponse = await app.inject({
      method: 'POST',
      url: `/api/demo/sessions/${sessionId}/votes`,
      payload: {
        baseEpochId: firstEpochId,
        weights: votePayload.weights,
        topicIntent: votePayload.topicIntent,
      },
    });
    expect(staleVoteResponse.statusCode).toBe(409);

    const outsideReceiptResponse = await app.inject({
      method: 'GET',
      url: `/api/demo/sessions/${sessionId}/receipts?postUri=${encodeURIComponent('at://did:plc:nope/app.bsky.feed.post/nope')}`,
    });
    expect(outsideReceiptResponse.statusCode).toBe(400);

    await app.close();
  });

  it('does not expose score math for rows hidden by Bluesky public-view policy', async () => {
    const app = buildTestApp();
    const service = new ShadowDemoService({
      projectDisplay: async (_corpus, items) => new Map(items.map((item) => [item.postUri, item.displayPost])),
      store: new MemoryDemoStore(),
      loadCorpus: async () => ({
        ...demoCorpus(),
        items: [
          {
            ...item({
              index: 4,
              text: 'Hidden but internally rankable',
              rawScores: {
                recency: 1,
                engagement: 1,
                bridging: 1,
                source_diversity: 1,
                relevance: 1,
              },
            }),
            displayPost: {
              kind: 'hidden_post',
              reason: 'Hidden by Bluesky public-view label !hide',
            },
          },
          item({
            index: 1,
            text: 'Public comparator',
            rawScores: {
              recency: 0.1,
              engagement: 0.1,
              bridging: 0.1,
              source_diversity: 0.1,
              relevance: 0.1,
            },
          }),
        ],
      }),
      now: () => NOW,
    });
    registerShadowDemoRoutes(app, service, null);

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/demo/sessions',
      payload: { communityId: 'open_science_builders', clientNonce: 'receipt-rank-flow' },
    });
    const sessionId = createResponse.json().payload.session.sessionId;
    const feedResponse = await app.inject({
      method: 'GET',
      url: `/api/demo/sessions/${sessionId}/feed?limit=2`,
    });
    const hiddenRow = feedResponse.json().payload.posts[0];

    expect(hiddenRow.post).toEqual({
      kind: 'hidden_post',
      reason: 'Hidden by Bluesky public-view label !hide',
    });
    expect(hiddenRow.score).toBeNull();
    expect(hiddenRow.rawScores).toBeNull();
    expect(hiddenRow.weightedComponents).toBeNull();

    await app.close();
  });

  it('caps a session at ten shadow epochs', async () => {
    const app = buildTestApp();
    const service = new ShadowDemoService({
      projectDisplay: async (_corpus, items) => new Map(items.map((item) => [item.postUri, item.displayPost])),
      store: new MemoryDemoStore(),
      loadCorpus: async () => demoCorpus(),
      now: () => NOW,
    });
    registerShadowDemoRoutes(app, service, null);

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/demo/sessions',
      payload: { communityId: 'open_science_builders', clientNonce: 'epoch-limit-flow' },
    });
    const sessionId = createResponse.json().payload.session.sessionId;
    let currentEpochId = createResponse.json().payload.session.currentEpochId as string;

    for (let sequence = 1; sequence < SHADOW_DEMO_MAX_EPOCHS_PER_SESSION; sequence += 1) {
      const voteResponse = await app.inject({
        method: 'POST',
        url: `/api/demo/sessions/${sessionId}/votes`,
        payload: {
          baseEpochId: currentEpochId,
          idempotencyKey: `vote-${sequence}`,
          weights: {
            recency: 0.2,
            engagement: 0.2,
            bridging: 0.2,
            source_diversity: 0.2,
            relevance: 0.2,
          },
          topicIntent: { topicWeights: { 'science-research': 0.8 } },
        },
      });
      expect(voteResponse.statusCode).toBe(200);
      const votersResponse = await app.inject({
        method: 'POST',
        url: `/api/demo/sessions/${sessionId}/agents/run`,
        payload: {
          baseEpochId: currentEpochId,
          idempotencyKey: `voters-${sequence}`,
        },
      });
      expect(votersResponse.statusCode).toBe(200);
      const advanceResponse = await app.inject({
        method: 'POST',
        url: `/api/demo/sessions/${sessionId}/epochs/advance`,
        payload: {
          fromEpochId: currentEpochId,
          idempotencyKey: `advance-${sequence}`,
        },
      });
      expect(advanceResponse.statusCode).toBe(200);
      currentEpochId = advanceResponse.json().payload.session.currentEpochId as string;
    }

    const cappedResponse = await app.inject({
      method: 'POST',
      url: `/api/demo/sessions/${sessionId}/epochs/advance`,
      payload: {
        fromEpochId: currentEpochId,
        idempotencyKey: 'advance-over-cap',
      },
    });

    expect(cappedResponse.statusCode).toBe(409);
    expect(cappedResponse.json().message).toContain('10 epoch limit');

    await app.close();
  });

  it('reuses a one-hour shared corpus across concurrent session creation while freezing separate corpora', async () => {
    const app = buildTestApp();
    let loadCount = 0;
    const store = new RecordingSharedCorpusStore();
    const service = new ShadowDemoService({
      projectDisplay: async (_corpus, items) => new Map(items.map((item) => [item.postUri, item.displayPost])),
      store,
      loadCorpus: async () => {
        loadCount += 1;
        return demoCorpus();
      },
      now: () => NOW,
    });
    registerShadowDemoRoutes(app, service, null);

    const [firstResponse, secondResponse] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/demo/sessions',
        payload: { communityId: 'open_science_builders', clientNonce: 'shared-corpus-first' },
      }),
      app.inject({
        method: 'POST',
        url: '/api/demo/sessions',
        payload: { communityId: 'open_science_builders', clientNonce: 'shared-corpus-second' },
      }),
    ]);

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    expect(loadCount).toBe(1);
    expect(store.sharedCorpusTtlSeconds).toBe(SHADOW_DEMO_SHARED_CORPUS_TTL_SECONDS);
    expect(store.sharedCorpusTtlSeconds).toBe(60 * 60);

    const firstBody = firstResponse.json() as ShadowDemoEnvelope<ShadowDemoSessionPayload>;
    const secondBody = secondResponse.json() as ShadowDemoEnvelope<ShadowDemoSessionPayload>;
    expect(firstBody.payload.session.sessionId).not.toBe(secondBody.payload.session.sessionId);
    expect(firstBody.payload.session.corpusProvenance.corpusId).not.toBe(
      secondBody.payload.session.corpusProvenance.corpusId
    );

    await app.close();
  });

  it('retries a degraded source on the next session instead of sharing it for an hour', async () => {
    const store = new MemoryDemoStore();
    const degraded = demoCorpus();
    degraded.health = { ...degraded.health, status: 'degraded', source: 'fixture_fallback' };
    const loadCorpus = vi.fn().mockResolvedValueOnce(degraded).mockResolvedValue(demoCorpus());
    const service = new ShadowDemoService({
      projectDisplay: async (_corpus, items) => new Map(items.map((item) => [item.postUri, item.displayPost])), store, loadCorpus, now: () => NOW });
    const first = await service.createSession({ communityId: 'open_science_builders', clientNonce: 'degraded-first' });
    await expect(store.readSharedCorpus('open_science_builders')).resolves.toBeNull();
    const second = await service.createSession({ communityId: 'open_science_builders', clientNonce: 'recovered-second' });
    await service.createSession({ communityId: 'open_science_builders', clientNonce: 'reused-third' });
    expect(loadCorpus).toHaveBeenCalledTimes(2);
    expect((await store.readSession(first.payload.session.sessionId))?.corpus.health.source).toBe('fixture_fallback');
    expect((await store.readSession(second.payload.session.sessionId))?.corpus.health.source).not.toBe('fixture_fallback');
  });

  for (const source of ['fixture_fallback', 'production_scores_appview'] as const) {
    it(`reacquires released ownership for concurrent noncacheable ${source} corpora`, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const store = new MemoryDemoStore();
      const commit = vi.spyOn(store, 'commitSharedCorpus');
      let activeBuilders = 0;
      let maximumBuilders = 0;
      let settled = 0;
      const loadCorpus = vi.fn(async () => {
        activeBuilders += 1;
        maximumBuilders = Math.max(maximumBuilders, activeBuilders);
        try {
          await testDelay(20);
          const corpus = demoCorpus();
          corpus.health = { ...corpus.health, status: 'degraded', source };
          return corpus;
        } finally {
          activeBuilders -= 1;
        }
      });
      const service = new ShadowDemoService({
        store, loadCorpus, now: () => NOW,
        projectDisplay: async (_corpus, items) => new Map(items.map((item) => [item.postUri, item.displayPost])),
      });
      const requests = ['first', 'second'].map((id) => service.createSession({
        communityId: 'open_science_builders', clientNonce: `noncacheable-${source}-${id}`,
      }).finally(() => { settled += 1; }));
      const results = Promise.allSettled(requests);
      try {
        await vi.advanceTimersByTimeAsync(500);
        expect(settled).toBe(2);
        const completed = await results;
        expect(completed.every((result) => result.status === 'fulfilled')).toBe(true);
        const sessions = completed.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
        expect(new Set(sessions.map((session) => session.sessionId)).size).toBe(2);
        expect(new Set(sessions.map((session) => session.payload.session.corpusProvenance.corpusId)).size).toBe(2);
        expect(loadCorpus).toHaveBeenCalledTimes(2);
        expect(maximumBuilders).toBe(1);
        expect(commit).not.toHaveBeenCalled();
        await expect(store.readSharedCorpus('open_science_builders')).resolves.toBeNull();
      } finally {
        await vi.advanceTimersByTimeAsync(16_000);
        await results;
        vi.useRealTimers();
      }
    });
  }

  it('rechecks cache after acquiring ownership before starting another builder', async () => {
    const store = new MemoryDemoStore();
    const acquire = store.acquireCorpusBuildLock.bind(store);
    vi.spyOn(store, 'acquireCorpusBuildLock').mockImplementation(async (communityId, token, ttlMs) => {
      // Publication became visible after the caller's initial cache read.
      await store.writeSharedCorpus(communityId, demoCorpus(), 3600);
      return acquire(communityId, token, ttlMs);
    });
    const loadCorpus = vi.fn(async () => demoCorpus());
    const release = vi.spyOn(store, 'releaseCorpusBuildLock');
    const service = new ShadowDemoService({
      store, loadCorpus, now: () => NOW,
      projectDisplay: async (_corpus, items) => new Map(items.map((item) => [item.postUri, item.displayPost])),
    });
    await service.createSession({ communityId: 'open_science_builders', clientNonce: 'published-before-acquire' });
    expect(loadCorpus).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it('reacquires an expired corpus build lease within the original wait budget', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const store = new ExpiringCorpusLockStore();
    await store.acquireCorpusBuildLock('open_science_builders', 'expired-builder', 15_000);
    const loadCorpus = vi.fn(async () => demoCorpus());
    const service = new ShadowDemoService({
      store, loadCorpus, now: () => NOW,
      projectDisplay: async (_corpus, items) => new Map(items.map((item) => [item.postUri, item.displayPost])),
    });
    const pending = service.createSession({ communityId: 'open_science_builders', clientNonce: 'expired-owner-recovery' });
    const completed = Promise.allSettled([pending]);
    try {
      await vi.advanceTimersByTimeAsync(15_600);
      expect((await completed)[0].status).toBe('fulfilled');
      expect(loadCorpus).toHaveBeenCalledOnce();
      expect(store.successfulAcquireCount).toBe(2);
    } finally {
      await completed;
      vi.useRealTimers();
    }
  });

  it('refuses corpus publication when ownership is lost before commit', async () => {
    const store = new MemoryDemoStore();
    vi.spyOn(store, 'renewCorpusBuildLock').mockResolvedValue(false);
    const commit = vi.spyOn(store, 'commitSharedCorpus');
    const release = vi.spyOn(store, 'releaseCorpusBuildLock');
    const service = new ShadowDemoService({
      store, loadCorpus: async () => demoCorpus(), now: () => NOW,
      projectDisplay: async (_corpus, items) => new Map(items.map((item) => [item.postUri, item.displayPost])),
    });
    await expect(service.createSession({ communityId: 'open_science_builders', clientNonce: 'lost-corpus-owner' }))
      .rejects.toThrow('Corpus build lease was lost');
    expect(commit).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    await expect(store.readSharedCorpus('open_science_builders')).resolves.toBeNull();
  });

  it('rejects public corpus refresh controls', async () => {
    const app = buildTestApp();
    const service = new ShadowDemoService({
      projectDisplay: async (_corpus, items) => new Map(items.map((item) => [item.postUri, item.displayPost])),
      store: new MemoryDemoStore(),
      loadCorpus: async () => demoCorpus(),
      now: () => NOW,
    });
    registerShadowDemoRoutes(app, service, null);

    const response = await app.inject({
      method: 'POST',
      url: '/api/demo/sessions',
      payload: { communityId: 'open_science_builders', clientNonce: 'invalid-refresh', refreshCorpus: true },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain('Unrecognized key');
    await app.close();
  });

  it('waits through a slow shared corpus build instead of creating a false conflict', async () => {
    vi.useFakeTimers();
    const store = new MemoryDemoStore();
    await store.acquireCorpusBuildLock('open_science_builders', 'slow-builder', 15_000);
    const service = new ShadowDemoService({
      projectDisplay: async (_corpus, items) => new Map(items.map((item) => [item.postUri, item.displayPost])),
      store,
      loadCorpus: async () => demoCorpus(),
      now: () => NOW,
    });

    try {
      const sessionPromise = service.createSession({
        communityId: 'open_science_builders',
        clientNonce: 'slow-build-session',
      });
      setTimeout(() => {
        void store.writeSharedCorpus('open_science_builders', demoCorpus(), 300);
      }, 3_000);

      await vi.advanceTimersByTimeAsync(3_100);

      await expect(sessionPromise).resolves.toMatchObject({
        payload: {
          session: {
            community: { id: 'open_science_builders' },
          },
        },
      });
    } finally {
      await store.releaseCorpusBuildLock('open_science_builders', 'slow-builder');
      vi.useRealTimers();
    }
  });

  it('returns one conflict when the corpus build remains owned throughout the wait budget', async () => {
    vi.useFakeTimers();
    const store = new ExpiringCorpusLockStore();
    await store.acquireCorpusBuildLock('open_science_builders', 'stalled-builder', 30_000);
    const service = new ShadowDemoService({
      projectDisplay: async (_corpus, items) => new Map(items.map((item) => [item.postUri, item.displayPost])),
      store,
      loadCorpus: async () => demoCorpus(),
      now: () => NOW,
    });

    try {
      const sessionPromise = service.createSession({
        communityId: 'open_science_builders',
        clientNonce: 'stalled-build-session',
      });
      const conflict = expect(sessionPromise).rejects.toThrow(/corpus is warming/);

      await vi.advanceTimersByTimeAsync(15_600);

      await conflict;
    } finally {
      await store.releaseCorpusBuildLock('open_science_builders', 'stalled-builder');
      vi.useRealTimers();
    }
  });

  it('renews a long corpus-build lease so a second builder cannot take ownership', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const store = new ExpiringCorpusLockStore();
    const service = new ShadowDemoService({
      projectDisplay: async (_corpus, items) => new Map(items.map((item) => [item.postUri, item.displayPost])),
      store,
      loadCorpus: async () => {
        for (let batch = 0; batch < 4; batch += 1) {
          await testDelay(8_000);
        }
        return demoCorpus();
      },
      now: () => NOW,
    });

    try {
      const firstSession = service.createSession({
        communityId: 'open_science_builders',
        clientNonce: 'long-build-first',
      });
      await vi.advanceTimersByTimeAsync(16_000);
      const secondSession = service.createSession({
        communityId: 'open_science_builders',
        clientNonce: 'long-build-second',
      });
      const secondConflict = expect(secondSession).rejects.toThrow(/corpus is warming/);

      await vi.advanceTimersByTimeAsync(17_000);

      await expect(firstSession).resolves.toMatchObject({ sessionId: expect.stringMatching(/^demo-/) });
      await secondConflict;
      expect(store.successfulAcquireCount).toBe(1);
      expect(store.renewalCount).toBeGreaterThanOrEqual(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects malformed header idempotency keys with the same validation as body keys', async () => {
    const app = buildTestApp();
    const service = new ShadowDemoService({
      projectDisplay: async (_corpus, items) => new Map(items.map((item) => [item.postUri, item.displayPost])),
      store: new MemoryDemoStore(),
      loadCorpus: async () => demoCorpus(),
      now: () => NOW,
    });
    registerShadowDemoRoutes(app, service, null);
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/demo/sessions',
      payload: { communityId: 'open_science_builders', clientNonce: 'idempotency-header-flow' },
    });
    const sessionId = createResponse.json().payload.session.sessionId;
    const epochId = createResponse.json().payload.session.currentEpochId;

    const response = await app.inject({
      method: 'POST',
      url: `/api/demo/sessions/${sessionId}/votes`,
      headers: { 'idempotency-key': 'contains spaces' },
      payload: {
        baseEpochId: epochId,
        weights: {
          recency: 0.2,
          engagement: 0.2,
          bridging: 0.2,
          source_diversity: 0.2,
          relevance: 0.2,
        },
        topicIntent: { topicWeights: {} },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain('idempotency-key header is malformed');
    await app.close();
  });

  it('returns a recoverable conflict when another mutation owns the session lock', async () => {
    const app = buildTestApp();
    const store = new MemoryDemoStore();
    const service = new ShadowDemoService({
      projectDisplay: async (_corpus, items) => new Map(items.map((item) => [item.postUri, item.displayPost])),
      store,
      loadCorpus: async () => demoCorpus(),
      now: () => NOW,
    });
    registerShadowDemoRoutes(app, service, null);
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/demo/sessions',
      payload: { communityId: 'open_science_builders', clientNonce: 'malformed-header-flow' },
    });
    const sessionId = createResponse.json().payload.session.sessionId;
    const epochId = createResponse.json().payload.session.currentEpochId;
    vi.spyOn(store, 'acquireSessionLock').mockResolvedValueOnce(false);

    const response = await app.inject({
      method: 'POST',
      url: `/api/demo/sessions/${sessionId}/votes`,
      payload: {
        baseEpochId: epochId,
        weights: {
          recency: 0.2,
          engagement: 0.2,
          bridging: 0.2,
          source_diversity: 0.2,
          relevance: 0.2,
        },
        topicIntent: { topicWeights: {} },
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().message).toContain(`session is busy: ${sessionId}`);
    await app.close();
  });

  it('rejects non-Open-Science topic keys and oversized mutation bodies', async () => {
    const app = buildTestApp();
    const service = new ShadowDemoService({
      projectDisplay: async (_corpus, items) => new Map(items.map((item) => [item.postUri, item.displayPost])),
      store: new MemoryDemoStore(),
      loadCorpus: async () => demoCorpus(),
      now: () => NOW,
    });
    registerShadowDemoRoutes(app, service, null);
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/demo/sessions',
      payload: { communityId: 'open_science_builders', clientNonce: 'payload-limit-flow' },
    });
    const sessionId = createResponse.json().payload.session.sessionId;
    const epochId = createResponse.json().payload.session.currentEpochId;

    const invalidTopic = await app.inject({
      method: 'POST',
      url: `/api/demo/sessions/${sessionId}/votes`,
      payload: {
        baseEpochId: epochId,
        weights: {
          recency: 0.2,
          engagement: 0.2,
          bridging: 0.2,
          source_diversity: 0.2,
          relevance: 0.2,
        },
        topicIntent: { topicWeights: { politics: 1 } },
      },
    });
    expect(invalidTopic.statusCode).toBe(400);

    const oversized = await app.inject({
      method: 'POST',
      url: '/api/demo/sessions',
      payload: { communityId: 'open_science_builders', clientNonce: 'oversized-body', padding: 'x'.repeat(17 * 1024) },
    });
    expect(oversized.statusCode).toBe(413);
    await app.close();
  });

  it('caps anonymous active sessions at fifty', async () => {
    const app = buildTestApp();
    const service = new ShadowDemoService({
      projectDisplay: async (_corpus, items) => new Map(items.map((item) => [item.postUri, item.displayPost])),
      store: new MemoryDemoStore(),
      loadCorpus: async () => demoCorpus(),
      now: () => NOW,
    });
    registerShadowDemoRoutes(app, service, null);

    for (let index = 0; index < 50; index += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/demo/sessions',
        payload: { communityId: 'open_science_builders', clientNonce: `capacity-${index}` },
      });
      expect(response.statusCode).toBe(200);
    }
    const capped = await app.inject({
      method: 'POST',
      url: '/api/demo/sessions',
      payload: { communityId: 'open_science_builders', clientNonce: 'capacity-overflow' },
    });
    expect(capped.statusCode).toBe(503);
    expect(capped.headers['retry-after']).toBe('60');
    expect(capped.json().retryAfterSeconds).toBe(60);
    expect(capped.json().message).toContain('50-session capacity');
    await app.close();
  });

  it('fails only the demo route when isolated storage is unavailable', async () => {
    const app = buildTestApp();
    const store = new MemoryDemoStore();
    vi.spyOn(store, 'readSharedCorpus').mockRejectedValue(
      new DemoStoreUnavailableError('read shared corpus', 'connection refused')
    );
    registerShadowDemoRoutes(app, new ShadowDemoService({
      projectDisplay: async (_corpus, items) => new Map(items.map((item) => [item.postUri, item.displayPost])),
      store,
      loadCorpus: async () => demoCorpus(),
      now: () => NOW,
    }), null);

    const response = await app.inject({
      method: 'POST',
      url: '/api/demo/sessions',
      payload: { communityId: 'open_science_builders', clientNonce: 'unavailable-storage' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().message).toContain('production Corgi feed is unaffected');
    await app.close();
  });

  it('enforces the isolated demo limiter and returns Retry-After without invoking the service', async () => {
    const app = buildTestApp();
    const service = new ShadowDemoService({
      projectDisplay: async (_corpus, items) => new Map(items.map((item) => [item.postUri, item.displayPost])),
      store: new MemoryDemoStore(),
      loadCorpus: vi.fn(async () => demoCorpus()),
      now: () => NOW,
    });
    const createSession = vi.spyOn(service, 'createSession');
    const close = vi.fn(async () => undefined);
    const guard: DemoRateLimitGuard = {
      check: vi.fn(async () => {
        throw new DemoRateLimitError(7);
      }),
      close,
    };
    registerShadowDemoRoutes(app, service, guard);

    const response = await app.inject({
      method: 'POST',
      url: '/api/demo/sessions',
      payload: { communityId: 'open_science_builders', clientNonce: 'rate-limited' },
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('7');
    expect(response.json()).toMatchObject({
      error: 'DemoRateLimitError',
      retryAfterSeconds: 7,
    });
    expect(guard.check).toHaveBeenCalledWith('session_create', '127.0.0.1');
    expect(createSession).not.toHaveBeenCalled();
    await app.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it('fails closed with 503 when noeviction rejects an isolated rate-limit write', async () => {
    const app = buildTestApp();
    const service = new ShadowDemoService({
      projectDisplay: async (_corpus, items) => new Map(items.map((item) => [item.postUri, item.displayPost])),
      store: new MemoryDemoStore(),
      loadCorpus: vi.fn(async () => demoCorpus()),
      now: () => NOW,
    });
    const createSession = vi.spyOn(service, 'createSession');
    const guard: DemoRateLimitGuard = {
      check: vi.fn(async () => {
        throw new DemoStoreUnavailableError('apply demo rate limit', 'OOM command not allowed');
      }),
      close: vi.fn(async () => undefined),
    };
    registerShadowDemoRoutes(app, service, guard);

    const response = await app.inject({
      method: 'POST',
      url: '/api/demo/sessions',
      payload: { communityId: 'open_science_builders', clientNonce: 'rate-limit-storage' },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().message).toContain('production Corgi feed is unaffected');
    expect(createSession).not.toHaveBeenCalled();
    await app.close();
  });

  it('does not publish computed mutation state after lock ownership is lost', async () => {
    const app = buildTestApp();
    const store = new MemoryDemoStore();
    registerShadowDemoRoutes(app, new ShadowDemoService({
      projectDisplay: async (_corpus, items) => new Map(items.map((item) => [item.postUri, item.displayPost])),
      store,
      loadCorpus: async () => demoCorpus(),
      now: () => NOW,
    }), null);
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/demo/sessions',
      payload: { communityId: 'open_science_builders', clientNonce: 'receipt-outside-flow' },
    });
    const sessionId = createResponse.json().payload.session.sessionId;
    const epochId = createResponse.json().payload.session.currentEpochId;
    vi.spyOn(store, 'commitSessionMutation').mockResolvedValueOnce(false);

    const voteResponse = await app.inject({
      method: 'POST',
      url: `/api/demo/sessions/${sessionId}/votes`,
      payload: {
        baseEpochId: epochId,
        weights: {
          recency: 0.2,
          engagement: 0.2,
          bridging: 0.2,
          source_diversity: 0.2,
          relevance: 0.2,
        },
        topicIntent: { topicWeights: { 'science-research': 0.8 } },
      },
    });
    expect(voteResponse.statusCode).toBe(409);

    const recovered = await app.inject({
      method: 'GET',
      url: `/api/demo/sessions/${sessionId}`,
    });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json().payload.session).toMatchObject({ phase: 'created', voteCount: 0 });
    await app.close();
  });
});

function demoCorpus(): ShadowDemoCorpus {
  return {
    corpusId: 'corpus-test',
    communityId: 'open_science_builders',
    baseProductionEpochId: 2,
    baseWeights: {
      recency: 0,
      engagement: 1,
      bridging: 0,
      source_diversity: 0,
      relevance: 0,
    },
    baseTopicIntent: {
      topicWeights: {},
    },
    createdAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 90 * 60 * 1000).toISOString(),
    health: {
      status: 'live',
      source: 'production_scores_appview',
      candidatePosts72h: 3,
      publicScoredPosts: 3,
      uniqueAuthors72h: 3,
      bridgePostShare: 0.333,
      topAuthorConcentration: 0.333,
      sampledAt: NOW.toISOString(),
    },
    warnings: [],
    items: [
      item({
        index: 1,
        text: 'Open-source bird-call classifier dataset just dropped.',
        rawScores: {
          recency: 0.4,
          engagement: 0.2,
          bridging: 0.9,
          source_diversity: 0.7,
          relevance: 0.95,
        },
      }),
      item({
        index: 2,
        text: 'Programmers will do anything except go outside.',
        rawScores: {
          recency: 0.5,
          engagement: 0.98,
          bridging: 0.2,
          source_diversity: 0.2,
          relevance: 0.35,
        },
      }),
      item({
        index: 3,
        text: 'Field notes from a rainy owl survey, plus the messy CSV.',
        rawScores: {
          recency: 0.7,
          engagement: 0.5,
          bridging: 0.8,
          source_diversity: 0.8,
          relevance: 0.82,
        },
      }),
    ],
  };
}

class RecordingSharedCorpusStore extends MemoryDemoStore {
  sharedCorpusTtlSeconds: number | null = null;

  override async commitSharedCorpus(
    communityId: ShadowDemoCommunityId,
    token: string,
    corpus: ShadowDemoCorpus,
    ttlSeconds: number
  ): Promise<boolean> {
    this.sharedCorpusTtlSeconds = ttlSeconds;
    return super.commitSharedCorpus(communityId, token, corpus, ttlSeconds);
  }
}

class ExpiringCorpusLockStore extends MemoryDemoStore {
  successfulAcquireCount = 0;
  renewalCount = 0;
  private corpusLockOwner: string | null = null;
  private corpusLockExpiresAt = 0;

  override async acquireCorpusBuildLock(
    _communityId: 'open_science_builders',
    token: string,
    ttlMs: number
  ): Promise<boolean> {
    if (this.corpusLockOwner !== null && this.corpusLockExpiresAt > Date.now()) {
      return false;
    }
    this.corpusLockOwner = token;
    this.corpusLockExpiresAt = Date.now() + ttlMs;
    this.successfulAcquireCount += 1;
    return true;
  }

  override async renewCorpusBuildLock(
    _communityId: 'open_science_builders',
    token: string,
    ttlMs: number
  ): Promise<boolean> {
    if (this.corpusLockOwner !== token || this.corpusLockExpiresAt <= Date.now()) {
      return false;
    }
    this.corpusLockExpiresAt = Date.now() + ttlMs;
    this.renewalCount += 1;
    return true;
  }

  override async commitSharedCorpus(
    communityId: ShadowDemoCommunityId,
    token: string,
    corpus: ShadowDemoCorpus,
    ttlSeconds: number
  ): Promise<boolean> {
    if (this.corpusLockOwner !== token || this.corpusLockExpiresAt <= Date.now()) return false;
    await super.writeSharedCorpus(communityId, corpus, ttlSeconds);
    return true;
  }

  override async releaseCorpusBuildLock(
    _communityId: 'open_science_builders',
    token: string
  ): Promise<void> {
    if (this.corpusLockOwner === token) {
      this.corpusLockOwner = null;
      this.corpusLockExpiresAt = 0;
    }
  }
}

async function testDelay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function item(options: {
  index: number;
  text: string;
  rawScores: ShadowDemoCorpus['items'][number]['rawScores'];
}): ShadowDemoCorpus['items'][number] {
  const uri = `at://did:plc:demo${options.index}/app.bsky.feed.post/${numberWord(options.index)}`;
  return {
    postUri: uri,
    authorDid: `did:plc:demo${options.index}`,
    createdAt: NOW.toISOString(),
    topicVector: { 'science-research': options.rawScores.relevance },
    rawScores: options.rawScores,
    productionScore: options.rawScores.engagement,
    productionEpochId: 2,
    scoredAt: NOW.toISOString(),
    componentDetails: null,
    inclusionReasons: {
      matchedTopics: [{ topic: 'science-research', score: options.rawScores.relevance }],
      matchedTerms: ['research'],
    },
    displayPost: {
      kind: 'public_post',
      uri,
      cid: `bafy${options.index}`,
      authorDid: `did:plc:demo${options.index}`,
      authorHandle: `user${options.index}.bsky.social`,
      authorDisplayName: `User ${options.index}`,
      authorAvatar: null,
      text: options.text,
      likeCount: options.index,
      repostCount: options.index,
      replyCount: options.index,
      quoteCount: 0,
      indexedAt: NOW.toISOString(),
      createdAt: NOW.toISOString(),
      bskyUrl: `https://bsky.app/profile/user${options.index}.bsky.social/post/${numberWord(options.index)}`,
    },
  };
}

function numberWord(value: number): string {
  if (value === 1) {
    return 'one';
  }
  if (value === 2) {
    return 'two';
  }
  return 'three';
}
