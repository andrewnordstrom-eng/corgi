import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { createDisplayProjector } from '../src/demo/corpus.js';
import { ShadowDemoService } from '../src/demo/service.js';
import { MemoryDemoStore, type DemoSessionMutation } from '../src/demo/store.js';
import { registerShadowDemoRoutes, registerShadowDemoV4Routes } from '../src/demo/routes.js';
import type { ShadowDemoCorpus } from '../src/demo/types.js';
import { buildTestApp } from './helpers/index.js';
import { scoreFromRawWeights } from '../src/demo/weights.js';

const NOW = new Date('2026-07-11T22:30:00.000Z');
const TOPIC_SLUGS = [
  'adult-content', 'ai-machine-learning', 'art-creative', 'books-reading', 'climate-environment',
  'cooking-food', 'cybersecurity', 'data-science', 'decentralized-social', 'design-ux',
  'devops-infrastructure', 'dogs-pets', 'education', 'gaming', 'health-fitness',
  'mobile-development', 'music', 'news-journalism', 'open-source', 'politics-governance',
  'science-research', 'software-development', 'space-astronomy', 'startups-business',
  'systems-programming', 'web-development',
] as const;
const TOPICS = TOPIC_SLUGS.map((slug, index) => ({
  slug,
  name: slug.split('-').map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`).join(' '),
  description: null,
  baselineWeight: Number((0.2 + (index % 7) * 0.1).toFixed(1)),
}));

describe('shadow demo v4 route contract', () => {
  it('preserves published baseline order and requires the complete frozen topic catalog', async () => {
    const app = buildTestApp();
    try {
      const service = new ShadowDemoService({
      projectDisplay: async (_corpus, items) => new Map(items.map((item) => [item.postUri, item.displayPost])),
        store: new MemoryDemoStore(),
        loadCorpus: async () => corpus(),
        now: () => NOW,
      });
      registerShadowDemoRoutes(app, service, null);
      registerShadowDemoV4Routes(app, service, null);

    const wrongContract = await app.inject({
      method: 'POST',
      url: '/api/demo/sessions',
      payload: { communityId: 'community_gov', clientNonce: 'v3-community-gov' },
    });
    expect(wrongContract.statusCode).toBe(400);
    expect(wrongContract.headers['cache-control']).toBe('no-store');
    expect(wrongContract.json().message).toContain('only on the v4');

    const created = await app.inject({
      method: 'POST',
      url: '/api/demo/v4/sessions',
      payload: { communityId: 'community_gov', clientNonce: 'v4-baseline' },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().contractVersion).toBe('2026-07-11.shadow-demo.v4');
    const session = created.json().payload.session;
    expect(session.topicCatalog).toEqual(TOPICS);

    const baseline = await app.inject({
      method: 'GET',
      url: `/api/demo/v4/sessions/${session.sessionId}/feed?epochId=${session.currentEpochId}&limit=3`,
    });
    expect(baseline.statusCode).toBe(200);
    expect(baseline.json().payload.posts.map((post: { publishedRank: number; post: { uri: string } }) => [post.publishedRank, post.post.uri])).toEqual([
      [1, postUri(1)], [2, postUri(2)], [3, postUri(3)],
    ]);

    const incomplete = await app.inject({
      method: 'POST',
      url: `/api/demo/v4/sessions/${session.sessionId}/votes`,
      payload: votePayload(session.currentEpochId, { 'science-research': 1 }),
    });
    expect(incomplete.statusCode).toBe(400);
    expect(incomplete.json().message).toContain('complete frozen topic catalog');

    const unknown = await app.inject({
      method: 'POST',
      url: `/api/demo/v4/sessions/${session.sessionId}/votes`,
      payload: votePayload(session.currentEpochId, {
        ...Object.fromEntries(TOPICS.map((topic) => [topic.slug, topic.baselineWeight])),
        unknown: 0.5,
      }),
    });
    expect(unknown.statusCode).toBe(400);

    const acceptedPayload = votePayload(session.currentEpochId, Object.fromEntries(TOPICS.map((topic) => [topic.slug, topic.baselineWeight])));
    const accepted = await app.inject({
      method: 'POST',
      url: `/api/demo/v4/sessions/${session.sessionId}/votes`,
      payload: acceptedPayload,
    });
    expect(accepted.statusCode).toBe(200);
    const acceptedReplay = await app.inject({
      method: 'POST',
      url: `/api/demo/v4/sessions/${session.sessionId}/votes`,
      payload: acceptedPayload,
    });
    expect(acceptedReplay.statusCode).toBe(200);
    expect(acceptedReplay.json().payload).toEqual(accepted.json().payload);

    const voterPayload = { baseEpochId: session.currentEpochId, idempotencyKey: 'v4-voters' };
    const voters = await app.inject({
      method: 'POST',
      url: `/api/demo/v4/sessions/${session.sessionId}/agents/run`,
      payload: voterPayload,
    });
    expect(voters.statusCode).toBe(200);
    expect(voters.json().payload.session.pendingAggregate).toMatchObject({ voteCount: 25, trimCount: 2 });
    expect(voters.json().payload.session.voterProfiles.map((profile: { id: string }) => profile.id)).toEqual([
      'freshness_watcher', 'conversation_follower', 'bridge_builder', 'source_diversifier', 'relevance_steward',
    ]);
    const votersReplay = await app.inject({
      method: 'POST',
      url: `/api/demo/v4/sessions/${session.sessionId}/agents/run`,
      payload: voterPayload,
    });
    expect(votersReplay.statusCode).toBe(200);
    expect(votersReplay.json().payload).toEqual(voters.json().payload);

    const advancePayload = { fromEpochId: session.currentEpochId, idempotencyKey: 'v4-advance' };
    const advanced = await app.inject({
      method: 'POST',
      url: `/api/demo/v4/sessions/${session.sessionId}/epochs/advance`,
      payload: advancePayload,
    });
    expect(advanced.statusCode).toBe(200);
    const advancedReplay = await app.inject({
      method: 'POST',
      url: `/api/demo/v4/sessions/${session.sessionId}/epochs/advance`,
      payload: advancePayload,
    });
    expect(advancedReplay.statusCode).toBe(200);
    expect(advancedReplay.json().payload).toEqual(advanced.json().payload);
    const shadowEpochId = advanced.json().payload.session.currentEpochId;
    const reranked = await app.inject({
      method: 'GET',
      url: `/api/demo/v4/sessions/${session.sessionId}/feed?epochId=${shadowEpochId}&limit=3`,
    });
    expect(reranked.statusCode).toBe(200);
    expect(reranked.json().payload.posts.every((post: { publishedRank: number }) => post.publishedRank > 0)).toBe(true);
    for (const limit of [0, -1, 13, 1000]) {
      const invalidFeed = await app.inject({
        method: 'GET',
        url: `/api/demo/v4/sessions/${session.sessionId}/feed?epochId=${shadowEpochId}&limit=${limit}`,
      });
      expect(invalidFeed.statusCode).toBe(400);
    }
    const selected = reranked.json().payload.posts[0];
    const receipt = await app.inject({
      method: 'GET',
      url: `/api/demo/v4/sessions/${session.sessionId}/receipts?epochId=${shadowEpochId}&postUri=${encodeURIComponent(selected.post.uri)}`,
    });
    expect(receipt.statusCode).toBe(200);
    expect(receipt.json().payload.receipt).toMatchObject({
      epochId: shadowEpochId,
      postUri: selected.post.uri,
      aggregate: { voteCount: 25, trimCount: 2 },
      publishedRank: selected.publishedRank,
      publicationAdjustment: expect.any(Number),
      componentScore: expect.any(Number),
      provenance: {
        sourceFeedName: 'Corgi Commons',
        sourceRunId: 'run-1',
        sourceSnapshotDigest: 'a'.repeat(64),
      },
    });
    const outsideReceipt = await app.inject({
      method: 'GET',
      url: `/api/demo/v4/sessions/${session.sessionId}/receipts?epochId=${shadowEpochId}&postUri=${encodeURIComponent('at://did:plc:outside/app.bsky.feed.post/outside')}`,
    });
    expect(outsideReceipt.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('rejects a duplicate frozen topic catalog before accepting a vote', async () => {
    const app = buildTestApp();
    try {
      const duplicateCatalogCorpus = corpus();
      duplicateCatalogCorpus.topicCatalog = [...TOPICS];
      duplicateCatalogCorpus.topicCatalog[25] = { ...TOPICS[0] };
      const service = new ShadowDemoService({
      projectDisplay: async (_corpus, items) => new Map(items.map((item) => [item.postUri, item.displayPost])),
        store: new MemoryDemoStore(),
        loadCorpus: async () => duplicateCatalogCorpus,
        now: () => NOW,
      });
      registerShadowDemoV4Routes(app, service, null);
      const created = await app.inject({
        method: 'POST',
        url: '/api/demo/v4/sessions',
        payload: { communityId: 'community_gov', clientNonce: 'v4-duplicate-topics' },
      });
      expect(created.statusCode).toBe(200);
      expect(created.headers['cache-control']).toBe('no-store');
      const session = created.json().payload.session;
      const vote = await app.inject({
        method: 'POST',
        url: `/api/demo/v4/sessions/${session.sessionId}/votes`,
        payload: votePayload(
          session.currentEpochId,
          Object.fromEntries(TOPICS.map((topic) => [topic.slug, topic.baselineWeight]))
        ),
      });
      expect(vote.statusCode).toBe(400);
      expect(vote.json().message).toContain('unique topic slugs');
    } finally {
      await app.close();
    }
  });

  for (const crossing of [false, true]) {
    it(`keeps fixture baseline, movement and receipts consistent for ${crossing ? 'crossing' : 'unchanged'} order`, async () => {
      const fixture = corpus();
      fixture.items = fixture.items.slice(0, 2).map((entry, index) => ({
        ...entry, publishedRank: undefined, publishedScore: undefined, publicationAdjustment: undefined,
        rawScores: { recency: index === 0 ? 1 : 0, engagement: index === 1 ? 1 : 0, bridging: 0, source_diversity: 0, relevance: 1 },
      }));
      fixture.baseWeights = { recency: 0.2, engagement: 0.8, bridging: 0, source_diversity: 0, relevance: 0 };
      fixture.health = { ...fixture.health, status: 'degraded', source: 'fixture_fallback' };
      const store = new MemoryDemoStore();
      const service = new ShadowDemoService({
      projectDisplay: async (_corpus, items) => new Map(items.map((item) => [item.postUri, item.displayPost])), store, loadCorpus: async () => fixture, now: () => NOW });
      const created = await service.createSession({ communityId: 'community_gov', clientNonce: `oracle-${crossing}` });
      const session = created.payload.session;
      const baseline = await service.getFeed({ sessionId: session.sessionId, epochId: session.currentEpochId, limit: 12 });
      expect(baseline.payload.posts.map((post) => [post.post.kind === 'public_post' ? post.post.uri : null, post.rank, post.score])).toEqual([
        [postUri(2), 1, 0.8], [postUri(1), 2, 0.2],
      ]);
      const weights = crossing ? { ...fixture.baseWeights, recency: 0.8, engagement: 0.2 } : fixture.baseWeights;
      await service.castVote({ sessionId: session.sessionId, baseEpochId: session.currentEpochId, weights, topicIntent: fixture.baseTopicIntent, idempotencyKey: 'oracle-vote' });
      await service.runSyntheticVoters({ sessionId: session.sessionId, baseEpochId: session.currentEpochId, idempotencyKey: 'oracle-voters' });
      // Controlled arithmetic fixture: keep the valid25 voter identities, set a known unanimous policy.
      const stored = await store.readSession(session.sessionId);
      if (stored === null) throw new Error('Expected stored arithmetic fixture');
      stored.votes = stored.votes.map((vote) => ({ ...vote, weights, topicIntent: fixture.baseTopicIntent }));
      const advanced = await service.advanceEpoch({ sessionId: session.sessionId, fromEpochId: session.currentEpochId, idempotencyKey: 'oracle-advance' });
      const feed = await service.getFeed({ sessionId: session.sessionId, epochId: advanced.payload.session.currentEpochId, limit: 12 });
      expect(feed.payload.posts.map((post) => [post.post.kind === 'public_post' ? post.post.uri : null, post.previousRank, post.movement])).toEqual(crossing
        ? [[postUri(1), 2, 1], [postUri(2), 1, -1]]
        : [[postUri(2), 1, 0], [postUri(1), 2, 0]]);
      for (const post of feed.payload.posts) {
        if (post.post.kind !== 'public_post') throw new Error('Expected public arithmetic fixture');
        const receipt = await service.getReceipt({ sessionId: session.sessionId, epochId: advanced.payload.session.currentEpochId, postUri: post.post.uri });
        expect(receipt.payload.receipt.score).toBeCloseTo(post.rank === 1 ? 0.8 : 0.2, 12);
        expect(receipt.payload.receipt.previousRank).toBe(post.previousRank);
      }
    });
  }

  it('preserves the baseline adjustment and recomputes URL dedup once in shadow epochs', async () => {
    const adjustedCorpus = corpus();
    const adjustments = [0.8, 0.6] as const;
    for (const [index, adjustment] of adjustments.entries()) {
      const target = adjustedCorpus.items[index];
      target.publicationAdjustment = adjustment;
      target.embedUrl = 'https://example.com/shared-report';
      target.textLength = 20;
      target.publishedScore = scoreFromRawWeights(
        target.rawScores,
        adjustedCorpus.baseWeights,
        target.topicVector,
        adjustedCorpus.baseTopicIntent
      ).score * adjustment;
    }
    const service = new ShadowDemoService({
      projectDisplay: async (_corpus, items) => new Map(items.map((item) => [item.postUri, item.displayPost])),
      store: new MemoryDemoStore(),
      loadCorpus: async () => adjustedCorpus,
      now: () => NOW,
    });
    const created = await service.createSession({ communityId: 'community_gov', clientNonce: 'adjustment-chain' });
    const session = created.payload.session;
    const baselineReceipt = await service.getReceipt({
      sessionId: session.sessionId,
      epochId: session.currentEpochId,
      postUri: adjustedCorpus.items[0].postUri,
    });
    expect(baselineReceipt.payload.receipt.publicationAdjustment).toBeCloseTo(adjustments[0], 12);
    expect(baselineReceipt.payload.receipt.score).toBeCloseTo(
      baselineReceipt.payload.receipt.componentScore * adjustments[0],
      12
    );

    await service.castVote({
      sessionId: session.sessionId,
      baseEpochId: session.currentEpochId,
      weights: adjustedCorpus.baseWeights,
      topicIntent: adjustedCorpus.baseTopicIntent,
      idempotencyKey: 'adjustment-vote',
    });
    await service.runSyntheticVoters({
      sessionId: session.sessionId,
      baseEpochId: session.currentEpochId,
      idempotencyKey: 'adjustment-voters',
    });
    const advanced = await service.advanceEpoch({
      sessionId: session.sessionId,
      fromEpochId: session.currentEpochId,
      idempotencyKey: 'adjustment-advance',
    });
    const shadowEpochId = advanced.payload.session.currentEpochId;
    const shadowReceipts = await Promise.all(adjustedCorpus.items.slice(0, 2).map((target) => service.getReceipt({
      sessionId: session.sessionId,
      epochId: shadowEpochId,
      postUri: target.postUri,
    })));
    const ordered = shadowReceipts
      .map((result) => result.payload.receipt)
      .sort((left, right) => left.visibleRank - right.visibleRank);
    expect(ordered[0].publicationAdjustment).toBeCloseTo(1, 12);
    expect(ordered[1].publicationAdjustment).toBeCloseTo(0.7, 12);
    for (const receipt of ordered) {
      expect(receipt.score).toBeCloseTo(
        receipt.componentScore * receipt.publicationAdjustment,
        12
      );
    }
  });

  it('applies the frozen production relevance floor to shadow epochs', async () => {
    const floorCorpus = corpus();
    floorCorpus.sourceSnapshot!.publicationPolicy.minimumRelevance = 0.9;
    for (const target of floorCorpus.items) {
      target.topicVector = { 'science-research': 0.1 };
    }
    const service = new ShadowDemoService({
      projectDisplay: async (_corpus, items) => new Map(items.map((item) => [item.postUri, item.displayPost])),
      store: new MemoryDemoStore(),
      loadCorpus: async () => floorCorpus,
      now: () => NOW,
    });
    const created = await service.createSession({
      communityId: 'community_gov',
      clientNonce: 'relevance-floor',
    });
    const session = created.payload.session;
    await service.castVote({
      sessionId: session.sessionId,
      baseEpochId: session.currentEpochId,
      weights: floorCorpus.baseWeights,
      topicIntent: floorCorpus.baseTopicIntent,
      idempotencyKey: 'floor-vote',
    });
    await service.runSyntheticVoters({
      sessionId: session.sessionId,
      baseEpochId: session.currentEpochId,
      idempotencyKey: 'floor-voters',
    });
    const advanced = await service.advanceEpoch({
      sessionId: session.sessionId,
      fromEpochId: session.currentEpochId,
      idempotencyKey: 'floor-advance',
    });
    const shadowFeed = await service.getFeed({
      sessionId: session.sessionId,
      epochId: advanced.payload.session.currentEpochId,
      limit: 12,
    });

    expect(shadowFeed.payload.posts).toEqual([]);
  });
});

describe('current display projection over a frozen demo cohort', () => {
  for (const contentRulesEnabled of [false, true]) {
    it(`projects only returned public URIs with content rules ${contentRulesEnabled ? 'enabled' : 'disabled'}`, async () => {
      const frozen = corpus();
      // Rank one is last in storage order, so unrelated earlier items must not consume hydration budget.
      frozen.items.reverse();
      const excluded = frozen.items.find((entry) => entry.postUri === postUri(2));
      if (!excluded || excluded.displayPost.kind !== 'public_post') throw new Error('Expected excluded public fixture');
      excluded.displayPost.text = 'boundedprojectionmarker';
      const store = new MemoryDemoStore();
      let deny = false;
      const projectDisplay = vi.fn(async (_corpus: ShadowDemoCorpus, items: readonly ShadowDemoCorpus['items'][number][]) => {
        const display = new Map(items.map((item) => [item.postUri, item.displayPost]));
        if (deny) {
          display.delete(postUri(1)); // Unknown current visibility must also fail closed.
          if (display.has(postUri(2))) display.set(postUri(2), { kind: 'hidden_post', reason: 'Current synthetic denial' });
        }
        return display;
      });
      const service = new ShadowDemoService({ store, loadCorpus: async () => frozen, now: () => NOW, contentRulesEnabled, projectDisplay });
      const created = await service.createSession({ communityId: 'community_gov', clientNonce: `bounded-projection-${contentRulesEnabled}` });
      const state = await store.readSession(created.sessionId);
      if (!state) throw new Error('Expected stored projection fixture');
      state.epochs[0].aggregate.contentRules = {
        enabled: true, threshold: 8, electorate: 25, adoptedExcludeKeywords: ['boundedprojectionmarker'],
        support: [{ keyword: 'boundedprojectionmarker', supportCount: 25, adopted: true }],
      };
      const storedBefore = JSON.stringify(state);
      projectDisplay.mockClear();
      const visible = await service.getFeed({ sessionId: created.sessionId, epochId: null, limit: 1 });
      const expectedUris = contentRulesEnabled ? [postUri(1), postUri(2)].sort() : [postUri(1)];
      expect(projectDisplay).toHaveBeenCalledOnce();
      expect(projectDisplay.mock.calls[0][1].map((item) => item.postUri).sort()).toEqual(expectedUris);
      expect(visible.payload.posts.map((row) => [row.rank, row.post.kind === 'public_post' ? row.post.uri : null])).toEqual([[1, postUri(1)]]);
      if (contentRulesEnabled) expect(visible.payload.withheldPosts?.map((row) => row.post.kind === 'public_post' ? row.post.uri : null)).toEqual([postUri(2)]);
      else expect(visible.payload.withheldPosts).toBeUndefined();
      deny = true;
      projectDisplay.mockClear();
      const hidden = await service.getFeed({ sessionId: created.sessionId, epochId: null, limit: 1 });
      expect(projectDisplay.mock.calls[0][1].map((item) => item.postUri).sort()).toEqual(expectedUris);
      expect(hidden.payload.posts[0]).toMatchObject({ rank: 1, score: null, rawScores: null, weightedComponents: null, post: { kind: 'hidden_post' } });
      expect(JSON.stringify(hidden.payload.posts)).not.toContain(postUri(1));
      if (contentRulesEnabled) {
        expect(hidden.payload.withheldPosts?.[0].post.kind).toBe('hidden_post');
        expect(JSON.stringify(hidden.payload.withheldPosts)).not.toContain(postUri(2));
      }
      expect(hidden.payload.corpusProvenance).toEqual(visible.payload.corpusProvenance);
      expect(JSON.stringify(await store.readSession(created.sessionId))).toBe(storedBefore);
    });
  }

  for (const change of ['missing', 'hidden', 'cid', 'local-denial', 'local-failure', 'legacy-metadata'] as const) {
    it(`withholds ${change} after creation and shared-cache reuse without changing ranking inputs`, async () => {
      const frozen = corpus();
      frozen.items = frozen.items.map((entry, index) => ({
        ...entry,
        reviewedCid: entry.displayPost.kind === 'public_post' ? entry.displayPost.cid : null,
        displayPost: entry.displayPost.kind === 'public_post' ? {
          ...entry.displayPost,
          text: index < 2 ? 'calibrationmarker specific content' : entry.displayPost.text,
        } : entry.displayPost,
      }));
      let changed = false;
      const deniedUri = frozen.items[0].postUri;
      const query = vi.fn().mockImplementation(async (config: { values: [string[], (string | null)[]]; query_timeout: number }) => {
        expect(config.query_timeout).toBe(1000);
        if (changed && change === 'local-failure') throw new Error('synthetic local lookup failure');
        return { rows: config.values[0].map((uri) => ({ uri, denied: changed && change === 'local-denial' && uri === deniedUri })) };
      });
      const projectDisplay = createDisplayProjector({
        dbPool: { query } as unknown as Pick<Pool, 'query'>,
        fetchFn: async (url, init) => {
          expect(init.credentials).toBe('omit');
          expect(init.redirect).toBe('manual');
          expect(init.cache).toBe('no-store');
          const uris = new URL(url).searchParams.getAll('uris');
          expect(uris.length).toBeLessThanOrEqual(25);
          const posts = uris.flatMap((uri) => {
            const entry = frozen.items.find((candidate) => candidate.postUri === uri);
            if (!entry || entry.displayPost.kind !== 'public_post') throw new Error('Unexpected fixture URI');
            const post = entry.displayPost;
            if (changed && change === 'missing' && uri === deniedUri) return [];
            return [{ uri, cid: changed && change === 'cid' && uri === deniedUri ? 'changed-cid' : post.cid,
              author: { did: post.authorDid, handle: post.authorHandle, displayName: post.authorDisplayName },
              record: { text: post.text, createdAt: post.createdAt }, indexedAt: post.indexedAt,
              labels: changed && change === 'hidden' && uri === deniedUri ? [{ val: '!hide' }] : [],
            }];
          });
          return { ok: true, status: 200, text: async () => JSON.stringify({ posts }) };
        },
      });
      const store = new MemoryDemoStore();
      const loadCorpus = vi.fn(async () => frozen);
      const service = new ShadowDemoService({ store, loadCorpus, now: () => NOW, contentRulesEnabled: true, projectDisplay });
      const created = await service.createSession({ communityId: 'community_gov', clientNonce: `display-${change}` });
      const sessionId = created.payload.session.sessionId;
      const before = await service.getFeed({ sessionId, epochId: null, limit: 40 });
      expect(before.payload.posts[0].post.kind).toBe('public_post');
      expect(created.payload.session.suggestedExcludeKeywords).toContainEqual({ keyword: 'calibrationmarker', matchCount: 2 });
      if (change === 'legacy-metadata') {
        const state = await store.readSession(sessionId);
        if (!state) throw new Error('Expected fixture session');
        delete state.corpus.items[0].reviewedCid;
        delete frozen.items[0].reviewedCid;
        await store.writeSharedCorpus('community_gov', frozen, 3600);
      }
      const stateBefore = JSON.stringify(await store.readSession(sessionId));
      changed = true;
      const after = await service.getFeed({ sessionId, epochId: null, limit: 40 });
      expect(after.payload.posts[0]).toEqual({ rank: before.payload.posts[0].rank, previousRank: null, movement: null,
        score: null, rawScores: null, weightedComponents: null, componentScore: null, publicationAdjustment: null,
        post: { kind: 'hidden_post', reason: expect.any(String) } });
      expect(after.payload.posts.map(({ rank, previousRank, movement }) => ({ rank, previousRank, movement })))
        .toEqual(before.payload.posts.map(({ rank, previousRank, movement }) => ({ rank, previousRank, movement })));
      expect(after.payload.corpusProvenance).toEqual(before.payload.corpusProvenance);
      expect(JSON.stringify(await store.readSession(sessionId))).toBe(stateBefore);
      await expect(service.getReceipt({ sessionId, epochId: null, postUri: deniedUri })).rejects.toThrow('Receipt is unavailable');
      const current = await service.getSession(sessionId);
      expect(current.payload.session.suggestedExcludeKeywords?.some((entry) => entry.keyword === 'calibrationmarker')).toBe(false);
      const reused = await service.createSession({ communityId: 'community_gov', clientNonce: `reused-${change}` });
      const reusedFeed = await service.getFeed({ sessionId: reused.payload.session.sessionId, epochId: null, limit: 40 });
      expect(reusedFeed.payload.posts[0].post.kind).toBe('hidden_post');
      expect(loadCorpus).toHaveBeenCalledTimes(1);
      if (change !== 'legacy-metadata') {
        changed = false;
        expect((await service.getFeed({ sessionId, epochId: null, limit: 40 })).payload.posts[0].post.kind).toBe('public_post');
      }
    });
  }

  it('projects suggestions after release for both committed and replayed mutations without rewriting ballots', async () => {
    class LockObservedStore extends MemoryDemoStore {
      held = false;
      commits = 0;
      override async acquireSessionLock(sessionId: string, token: string, ttl: number): Promise<boolean> {
        const acquired = await super.acquireSessionLock(sessionId, token, ttl); this.held = acquired; return acquired;
      }
      override async releaseSessionLock(sessionId: string, token: string): Promise<void> {
        await super.releaseSessionLock(sessionId, token); this.held = false;
      }
      override async commitSessionMutation<T>(mutation: DemoSessionMutation<T>): Promise<boolean> {
        this.commits += 1; return super.commitSessionMutation<T>(mutation);
      }
    }
    const store = new LockObservedStore();
    const frozen = corpus();
    frozen.items = frozen.items.map((entry, i) => ({ ...entry, displayPost: entry.displayPost.kind === 'public_post'
      ? { ...entry.displayPost, text: i < 2 ? 'calibrationmarker' : entry.displayPost.text } : entry.displayPost }));
    let hidden = false;
    const service = new ShadowDemoService({ store, loadCorpus: async () => frozen, now: () => NOW, contentRulesEnabled: true,
      projectDisplay: async (_corpus, items) => {
        expect(store.held).toBe(false);
        return new Map(items.map((entry) => [entry.postUri, hidden ? { kind: 'hidden_post' as const, reason: 'synthetic current denial' } : entry.displayPost]));
      },
    });
    const session = (await service.createSession({ communityId: 'community_gov', clientNonce: 'projection-release' })).payload.session;
    const request = { sessionId: session.sessionId, baseEpochId: session.currentEpochId, weights: frozen.baseWeights,
      topicIntent: frozen.baseTopicIntent, excludeKeywords: ['calibrationmarker'], idempotencyKey: 'fixed-vote' };
    const first = await service.castVote(request);
    expect(first.payload.session.suggestedExcludeKeywords?.length).toBeGreaterThan(0);
    hidden = true;
    const replay = await service.castVote(request);
    expect(replay.payload.session.suggestedExcludeKeywords).toEqual([]);
    expect(replay.payload.session.votes).toEqual(first.payload.session.votes);
    expect(store.commits).toBe(1);
  });

  it('returns committed mutation with an explicit empty-suggestions warning when advisory projection fails', async () => {
    class CommitCountingStore extends MemoryDemoStore {
      commits = 0;
      override async commitSessionMutation<T>(mutation: DemoSessionMutation<T>): Promise<boolean> {
        this.commits += 1;
        return super.commitSessionMutation(mutation);
      }
    }
    const store = new CommitCountingStore();
    const frozen = corpus();
    let failProjection = false;
    const service = new ShadowDemoService({
      store,
      loadCorpus: async () => frozen,
      now: () => NOW,
      contentRulesEnabled: true,
      projectDisplay: async (_corpus, items) => {
        if (failProjection) throw new Error('synthetic projection failure');
        return new Map(items.map((item) => [item.postUri, item.displayPost]));
      },
    });
    const session = (await service.createSession({ communityId: 'community_gov', clientNonce: 'projection-failure' }))
      .payload.session;
    const request = {
      sessionId: session.sessionId,
      baseEpochId: session.currentEpochId,
      weights: frozen.baseWeights,
      topicIntent: frozen.baseTopicIntent,
      idempotencyKey: 'projection-failure-vote',
    };
    failProjection = true;

    const committed = await service.castVote(request);
    expect(committed.payload.session.votes).toHaveLength(1);
    expect(committed.payload.session.suggestedExcludeKeywords).toEqual([]);
    expect(committed.warnings).toContainEqual({
      code: 'content_rule_suggestions_unavailable',
      message: 'Content-rule suggestions are temporarily unavailable; the session change was saved.',
      severity: 'warning',
    });
    const replay = await service.castVote(request);
    expect(replay.payload.session.votes).toEqual(committed.payload.session.votes);
    expect(replay.payload.session.suggestedExcludeKeywords).toEqual([]);
    expect(store.commits).toBe(1);
  });
});

function votePayload(baseEpochId: string, topicWeights: Record<string, number>): object {
  return {
    baseEpochId,
    idempotencyKey: `vote-${Object.keys(topicWeights).length}`,
    weights: { recency: 0.2, engagement: 0.2, bridging: 0.2, source_diversity: 0.2, relevance: 0.2 },
    topicIntent: { topicWeights },
  };
}

function corpus(): ShadowDemoCorpus {
  const items = Array.from({ length: 40 }, (_unused, index) => item(index + 1));
  return {
    corpusId: 'approved-community-gov-corpus',
    communityId: 'community_gov',
    baseProductionEpochId: 2,
    baseWeights: { recency: 0.05, engagement: 0.65, bridging: 0.05, source_diversity: 0.05, relevance: 0.2 },
    baseTopicIntent: { topicWeights: Object.fromEntries(TOPICS.map((topic) => [topic.slug, topic.baselineWeight])) },
    createdAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 90 * 60_000).toISOString(),
    items,
    health: {
      status: 'live', source: 'production_feed_snapshot', candidatePosts72h: 100, publicScoredPosts: 40,
      uniqueAuthors72h: 40, bridgePostShare: 0.33, topAuthorConcentration: 0.025, sampledAt: NOW.toISOString(),
      sourcePostCount: 100, eligiblePostCount: 40, englishTaggedShare: 1, richMediaShare: 0.2,
    },
    warnings: [],
    topicCatalog: [...TOPICS],
    sourceFeedUri: 'at://did:plc:amzyknmm4auxijvykyfgznw2/app.bsky.feed.generator/community-gov',
    sourceSnapshot: {
      feedName: 'Corgi Commons', digest: 'a'.repeat(64), runId: 'run-1', updatedAt: NOW.toISOString(), capturedAt: NOW.toISOString(), reviewedAt: NOW.toISOString(),
      sourcePostCount: 100, selectionPolicyVersion: 'community-gov-reviewer-safe-v1', baselineOrderDigest: 'a'.repeat(64),
      publicationPolicy: { urlDedupEnabled: true, minimumOriginalTextLength: 200, minimumRelevance: 0, decay: [1, 0.7, 0.5, 0.3] },
    },
  };
}

function postUri(index: number): string {
  return `at://did:plc:demo${index}/app.bsky.feed.post/post${index}`;
}

function item(index: number): ShadowDemoCorpus['items'][number] {
  const uri = postUri(index);
  return {
    postUri: uri, authorDid: `did:plc:demo${index}`, createdAt: NOW.toISOString(),
    topicVector: { 'science-research': 0.8 },
    rawScores: { recency: (index % 10) / 10, engagement: 1 - (index % 10) / 10, bridging: (index % 5) / 5, source_diversity: 0.2, relevance: 0.8 },
    productionScore: 101 - index, productionEpochId: 2, scoredAt: NOW.toISOString(), componentDetails: null,
    inclusionReasons: { matchedTopics: [], matchedTerms: [], sourceRank: index, reason: 'published_feed_snapshot' },
    publishedRank: index, publishedScore: 101 - index, publicationAdjustment: 1,
    displayPost: {
      kind: 'public_post', uri, cid: `cid-${index}`, authorDid: `did:plc:demo${index}`,
      authorHandle: `user${index}.bsky.social`, authorDisplayName: `User ${index}`, authorAvatar: null,
      text: `Published feed post ${index}`, likeCount: index, repostCount: index, replyCount: index, quoteCount: 0,
      indexedAt: NOW.toISOString(), createdAt: NOW.toISOString(), bskyUrl: `https://bsky.app/profile/did:plc:demo${index}/post/post${index}`,
      languages: ['en'], media: null,
    },
  };
}
