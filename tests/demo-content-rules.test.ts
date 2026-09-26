import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import {
  aggregateShadowContentRules,
  applyShadowContentRules,
  contentRuleThreshold,
  suggestedExcludeKeywords,
  syntheticExcludeKeywords,
  validateShadowExcludeKeywords,
} from '../src/demo/content-rules.js';
import { ShadowDemoService } from '../src/demo/service.js';
import { DemoStoreCorruptionError, MemoryDemoStore, RedisDemoStore } from '../src/demo/store.js';
import {
  SHADOW_DEMO_MAX_EXCLUDE_KEYWORDS,
  SHADOW_DEMO_TOTAL_DEMO_VOTERS,
  type ShadowDemoCorpus,
  type ShadowDemoSessionState,
  type ShadowDemoVote,
} from '../src/demo/types.js';

// Support entries per epoch never exceed reviewer + prior-adopted keywords, but
// the persisted schema tolerates the full electorate's worth; keep the test
// bound derived so it tracks the store schema instead of a hardcoded literal.
const STORED_SUPPORT_MAX = SHADOW_DEMO_MAX_EXCLUDE_KEYWORDS * SHADOW_DEMO_TOTAL_DEMO_VOTERS;

const NOW = new Date('2026-07-12T22:30:00.000Z');
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

// Seeds verified against the deterministic FNV echo hash for epoch
// shadow-epoch-1 / community_gov / keyword "atproto":
// ADOPTING_SEED yields 9 synthetic echoes (10/25 with the reviewer, threshold 8);
// REJECTING_SEED yields 5 synthetic echoes (6/25, below threshold).
const ADOPTING_SEED = 'seed-0';
const REJECTING_SEED = 'seed-3';

describe('shadow demo content-rule primitives', () => {
  it('normalizes exclude keywords with production semantics', () => {
    expect(validateShadowExcludeKeywords(undefined)).toEqual([]);
    expect(validateShadowExcludeKeywords(null)).toEqual([]);
    expect(validateShadowExcludeKeywords([' ATProto ', 'atproto', 'Spam'])).toEqual(['atproto', 'spam']);
    expect(() => validateShadowExcludeKeywords('atproto')).toThrow(/array/);
    expect(() => validateShadowExcludeKeywords([42])).toThrow(/strings/);
    expect(() => validateShadowExcludeKeywords(['  '])).toThrow(/empty/);
    expect(() => validateShadowExcludeKeywords(['x'.repeat(51)])).toThrow(/50/);
    expect(() => validateShadowExcludeKeywords(Array.from({ length: 11 }, (_u, i) => `k${i}`)))
      .toThrow(/at most 10/);

    // Inclusive limits: exactly 10 keywords, each exactly 10 characters, are accepted.
    const tenKeywords = Array.from({ length: 10 }, (_u, i) => `k${i}`.padEnd(10, 'x'));
    expect(validateShadowExcludeKeywords(tenKeywords)).toEqual(tenKeywords);

    // Inclusive limit: a single exactly-50-character keyword is accepted unchanged.
    const fiftyCharKeyword = 'y'.repeat(50);
    expect(validateShadowExcludeKeywords([fiftyCharKeyword])).toEqual([fiftyCharKeyword]);
  });

  it('adopts keywords at the production 30% share over the full electorate', () => {
    expect(contentRuleThreshold(25)).toBe(8);
    const votesAt = (count: number): Array<Pick<ShadowDemoVote, 'excludeKeywords'>> => [
      ...Array.from({ length: count }, () => ({ excludeKeywords: ['atproto'] })),
      ...Array.from({ length: 25 - count }, () => ({})),
    ];
    const adopted = aggregateShadowContentRules(votesAt(8), 25);
    expect(adopted.threshold).toBe(8);
    expect(adopted.electorate).toBe(25);
    expect(adopted.adoptedExcludeKeywords).toEqual(['atproto']);
    expect(adopted.support).toEqual([{ keyword: 'atproto', supportCount: 8, adopted: true }]);

    const rejected = aggregateShadowContentRules(votesAt(7), 25);
    expect(rejected.adoptedExcludeKeywords).toEqual([]);
    expect(rejected.support).toEqual([{ keyword: 'atproto', supportCount: 7, adopted: false }]);
  });

  it('caps the adopted exclude-rule set at the per-ballot keyword limit', () => {
    // Inertia across epochs can push more than MAX keywords over threshold;
    // the persisted policy keeps only the highest-support MAX.
    const overCap = SHADOW_DEMO_MAX_EXCLUDE_KEYWORDS + 5;
    const votes = Array.from({ length: 25 }, () => ({
      excludeKeywords: Array.from({ length: overCap }, (_unused, i) => `rule-${i}`),
    }));
    const summary = aggregateShadowContentRules(votes, 25);
    expect(summary.support.filter((entry) => entry.adopted).length).toBe(overCap);
    expect(summary.adoptedExcludeKeywords).toHaveLength(SHADOW_DEMO_MAX_EXCLUDE_KEYWORDS);
  });

  it('splits the corpus with the production matcher and passes text-less posts', () => {
    const corpusFixture = corpus();
    corpusFixture.items[0].displayPost = { kind: 'hidden_post', reason: 'blocked' };
    const application = applyShadowContentRules(corpusFixture.items, ['atproto']);
    const withheldUris = application.withheld.map((entry) => entry.item.postUri);
    expect(withheldUris).toEqual([postUri(2), postUri(3)]);
    expect(application.withheld.every((entry) => entry.keyword === 'atproto')).toBe(true);
    expect(application.eligible.length + application.withheld.length).toBe(corpusFixture.items.length);
    expect(applyShadowContentRules(corpusFixture.items, []).withheld).toEqual([]);
  });

  it('suggests deterministic corpus-grounded keywords within effect bounds', () => {
    const corpusFixture = corpus();
    const suggestions = suggestedExcludeKeywords(corpusFixture.items, 6);
    expect(suggestions).toEqual(suggestedExcludeKeywords(corpusFixture.items, 6));
    expect(suggestions.length).toBeGreaterThan(0);
    for (const suggestion of suggestions) {
      expect(suggestion.matchCount).toBeGreaterThanOrEqual(2);
      expect(suggestion.matchCount).toBeLessThanOrEqual(Math.floor(40 * 0.3));
      expect(suggestion.keyword.length).toBeGreaterThanOrEqual(4);
    }
    // "atproto" appears in exactly two fixture posts.
    expect(suggestions.map((entry) => entry.keyword)).toContain('atproto');
  });

  it('replays synthetic keyword ballots exactly and never invents keywords', () => {
    const options = {
      seed: ADOPTING_SEED,
      communityId: 'community_gov',
      epochId: 'shadow-epoch-1',
      actorId: 'synthetic-freshness_watcher-1',
      blocId: 'freshness_watcher' as const,
      policyInertia: 0.3,
      reviewerExcludeKeywords: ['atproto'],
      priorAdoptedExcludeKeywords: ['legacy-rule'],
    };
    const first = syntheticExcludeKeywords(options);
    expect(syntheticExcludeKeywords(options)).toEqual(first);
    for (const keyword of first) {
      expect(['atproto', 'legacy-rule']).toContain(keyword);
    }
    expect(
      syntheticExcludeKeywords({
        ...options,
        reviewerExcludeKeywords: [],
        priorAdoptedExcludeKeywords: [],
      })
    ).toEqual([]);
  });
});

describe('shadow demo content rules disabled (v4 parity)', () => {
  it('rejects or redacts feature-enabled idempotency replays after the flag flips off', async () => {
    const store = new MemoryDemoStore();
    const enabled = buildService({ contentRulesEnabled: true, seed: ADOPTING_SEED }, store);
    const withRulesCreated = await enabled.createSession({
      communityId: 'community_gov',
      clientNonce: 'idempotency-rules-on',
    });
    const withRulesRequest = {
      sessionId: withRulesCreated.payload.session.sessionId,
      baseEpochId: withRulesCreated.payload.session.currentEpochId,
      weights: equalWeights(),
      topicIntent: fullTopicIntent(),
      excludeKeywords: ['atproto'],
      idempotencyKey: 'idempotency-rules-on-vote',
    };
    await enabled.castVote(withRulesRequest);

    const disabled = buildService({ contentRulesEnabled: false, seed: ADOPTING_SEED }, store);
    await expect(disabled.castVote(withRulesRequest)).rejects.toThrow(/not enabled/);

    const withoutRulesCreated = await enabled.createSession({
      communityId: 'community_gov',
      clientNonce: 'idempotency-no-rules',
    });
    const withoutRulesRequest = {
      sessionId: withoutRulesCreated.payload.session.sessionId,
      baseEpochId: withoutRulesCreated.payload.session.currentEpochId,
      weights: equalWeights(),
      topicIntent: fullTopicIntent(),
      idempotencyKey: 'idempotency-no-rules-vote',
    };
    const enabledResponse = await enabled.castVote(withoutRulesRequest);
    expect(enabledResponse.payload.session.contentRulesEnabled).toBe(true);

    const replay = await disabled.castVote(withoutRulesRequest);
    expect('contentRulesEnabled' in replay.payload.session).toBe(false);
    expect('suggestedExcludeKeywords' in replay.payload.session).toBe(false);
    expect(replay.payload.session.epochs.some((epoch) => 'contentRules' in epoch.aggregate)).toBe(false);
    expect(replay.payload.session.votes.some((vote) => 'excludeKeywords' in vote)).toBe(false);
  });

  it('keeps payloads contract-identical and rejects keyword ballots', async () => {
    const service = buildService({ contentRulesEnabled: false, seed: ADOPTING_SEED });
    const created = await service.createSession({ communityId: 'community_gov', clientNonce: 'rules-off' });
    const session = created.payload.session;
    expect('contentRulesEnabled' in session).toBe(false);
    expect('suggestedExcludeKeywords' in session).toBe(false);
    expect('contentRules' in session.epochs[0].aggregate).toBe(false);

    await expect(
      service.castVote({
        sessionId: session.sessionId,
        baseEpochId: session.currentEpochId,
        weights: equalWeights(),
        topicIntent: fullTopicIntent(),
        excludeKeywords: ['atproto'],
        idempotencyKey: 'rules-off-vote',
      })
    ).rejects.toThrow(/not enabled/);

    // An explicitly supplied null (not an omitted field) is also rejected.
    await expect(
      service.castVote({
        sessionId: session.sessionId,
        baseEpochId: session.currentEpochId,
        weights: equalWeights(),
        topicIntent: fullTopicIntent(),
        excludeKeywords: null,
        idempotencyKey: 'rules-off-null',
      })
    ).rejects.toThrow(/not enabled/);

    const advanced = await runFullEpoch(service, session.sessionId, session.currentEpochId, undefined, 'off');
    const epoch = advanced.payload.session.epochs.find(
      (candidate) => candidate.id === advanced.payload.session.currentEpochId
    );
    expect(epoch && 'contentRules' in epoch.aggregate).toBe(false);

    const feed = await service.getFeed({
      sessionId: session.sessionId,
      epochId: advanced.payload.session.currentEpochId,
      limit: 12,
    });
    expect('withheldPosts' in feed.payload).toBe(false);
  });

  it('ignores rules persisted while the flag was on once the flag flips off', async () => {
    // Build an adopted-rule session with the flag ON, then read the same stored
    // session through a flag-OFF service: withholding must not leak.
    const store = new MemoryDemoStore();
    const enabled = buildService({ contentRulesEnabled: true, seed: ADOPTING_SEED }, store);
    const created = await enabled.createSession({ communityId: 'community_gov', clientNonce: 'flip-off' });
    const session = created.payload.session;
    const advanced = await runFullEpoch(enabled, session.sessionId, session.currentEpochId, ['ATProto'], 'flip');
    const shadowEpochId = advanced.payload.session.currentEpochId;
    const enabledEpoch = advanced.payload.session.epochs.find((candidate) => candidate.id === shadowEpochId);
    expect(enabledEpoch?.aggregate.contentRules?.adoptedExcludeKeywords).toEqual(['atproto']);

    const disabled = buildService({ contentRulesEnabled: false, seed: ADOPTING_SEED }, store);
    const feed = await disabled.getFeed({ sessionId: session.sessionId, epochId: shadowEpochId, limit: 12 });
    expect('withheldPosts' in feed.payload).toBe(false);
    // Persisted content-rule metadata must not leak into flag-off payloads.
    expect('contentRules' in feed.payload.aggregate).toBe(false);
    const disabledSession = await disabled.getSession(session.sessionId);
    expect(disabledSession.payload.session.epochs.some((e) => 'contentRules' in e.aggregate)).toBe(false);
    // Per-ballot rule metadata must not leak through the votes array either.
    expect(disabledSession.payload.session.votes.some((vote) => 'excludeKeywords' in vote)).toBe(false);
    // getReceipt ranks the full corpus and throws for a withheld post; resolving
    // for the atproto-matching post proves the persisted rule is not applied.
    const receipt = await disabled.getReceipt({ sessionId: session.sessionId, epochId: shadowEpochId, postUri: postUri(2) });
    expect(receipt.payload.receipt.visibleRank).toBeGreaterThan(0);
    expect('contentRules' in receipt.payload.receipt).toBe(false);
    expect('contentRules' in receipt.payload.receipt.aggregate).toBe(false);

    // Byte-identical parity: a session built entirely flag-off yields the same
    // feed ordering/ranks and receipt fields as the flipped-off adopted session.
    const baselineStore = new MemoryDemoStore();
    const baselineService = buildService({ contentRulesEnabled: false, seed: ADOPTING_SEED }, baselineStore);
    const baselineCreated = await baselineService.createSession({ communityId: 'community_gov', clientNonce: 'baseline-off' });
    const baselineSession = baselineCreated.payload.session;
    const baselineAdvanced = await runFullEpoch(baselineService, baselineSession.sessionId, baselineSession.currentEpochId, undefined, 'baseline');
    const baselineEpochId = baselineAdvanced.payload.session.currentEpochId;
    const baselineFeed = await baselineService.getFeed({ sessionId: baselineSession.sessionId, epochId: baselineEpochId, limit: 12 });
    const rankPairs = (payloadFeed: typeof feed.payload): Array<[number, string]> => payloadFeed.posts
      .filter((post) => post.post.kind === 'public_post')
      .map((post) => [post.rank, post.post.kind === 'public_post' ? post.post.uri : ''] as [number, string]);
    expect(rankPairs(feed.payload)).toEqual(rankPairs(baselineFeed.payload));
  });
});

describe('shadow demo content rules enabled', () => {
  it('adopts a supported reviewer keyword, withholds matching posts, and explains it', async () => {
    const service = buildService({ contentRulesEnabled: true, seed: ADOPTING_SEED });
    const created = await service.createSession({ communityId: 'community_gov', clientNonce: 'rules-adopt' });
    const session = created.payload.session;
    expect(session.contentRulesEnabled).toBe(true);
    expect(session.suggestedExcludeKeywords?.length).toBeGreaterThan(0);
    expect(session.epochs[0].aggregate.contentRules).toMatchObject({
      threshold: 8,
      electorate: 25,
      adoptedExcludeKeywords: [],
    });

    const advanced = await runFullEpoch(service, session.sessionId, session.currentEpochId, ['ATProto'], 'adopt');
    const shadowEpochId = advanced.payload.session.currentEpochId;
    const epoch = advanced.payload.session.epochs.find((candidate) => candidate.id === shadowEpochId);
    expect(epoch?.aggregate.contentRules).toMatchObject({
      threshold: 8,
      electorate: 25,
      adoptedExcludeKeywords: ['atproto'],
    });
    expect(epoch?.aggregate.contentRules?.support).toEqual([
      { keyword: 'atproto', supportCount: 10, adopted: true },
    ]);

    const feed = await service.getFeed({ sessionId: session.sessionId, epochId: shadowEpochId, limit: 12 });
    expect(feed.payload.withheldPosts?.map((entry) => [
      entry.keyword,
      entry.post.kind === 'public_post' ? entry.post.uri : null,
      entry.supportCount,
    ])).toEqual([
      ['atproto', postUri(2), 10],
      ['atproto', postUri(3), 10],
    ]);
    const rankedUris = feed.payload.posts
      .filter((post) => post.post.kind === 'public_post')
      .map((post) => (post.post.kind === 'public_post' ? post.post.uri : ''));
    expect(rankedUris).not.toContain(postUri(2));
    expect(rankedUris).not.toContain(postUri(3));

    await expect(
      service.getReceipt({ sessionId: session.sessionId, epochId: shadowEpochId, postUri: postUri(2) })
    ).rejects.toThrow(/withheld by adopted community rule "-atproto" \(10\/25 support, threshold 8\)/);

    const visibleReceipt = await service.getReceipt({
      sessionId: session.sessionId,
      epochId: shadowEpochId,
      postUri: postUri(5),
    });
    expect(visibleReceipt.payload.receipt.contentRules).toEqual({
      adoptedExcludeKeywords: ['atproto'],
      threshold: 8,
      electorate: 25,
      matchedKeyword: null,
    });
  });

  it('visibly rejects a keyword that falls short of the threshold', async () => {
    const service = buildService({ contentRulesEnabled: true, seed: REJECTING_SEED });
    const created = await service.createSession({ communityId: 'community_gov', clientNonce: 'rules-reject' });
    const session = created.payload.session;
    const advanced = await runFullEpoch(service, session.sessionId, session.currentEpochId, ['atproto'], 'reject');
    const shadowEpochId = advanced.payload.session.currentEpochId;
    const epoch = advanced.payload.session.epochs.find((candidate) => candidate.id === shadowEpochId);
    expect(epoch?.aggregate.contentRules).toMatchObject({ adoptedExcludeKeywords: [] });
    expect(epoch?.aggregate.contentRules?.support).toEqual([
      { keyword: 'atproto', supportCount: 6, adopted: false },
    ]);

    const feed = await service.getFeed({ sessionId: session.sessionId, epochId: shadowEpochId, limit: 12 });
    expect(feed.payload.withheldPosts).toEqual([]);
    // The rejected keyword must not withhold the matching post: its receipt
    // resolves normally instead of the withheld-rule error.
    const receipt = await service.getReceipt({
      sessionId: session.sessionId,
      epochId: shadowEpochId,
      postUri: postUri(2),
    });
    expect(receipt.payload.receipt.contentRules).toMatchObject({ adoptedExcludeKeywords: [] });
  });

  it('replays an identical session byte-for-byte with keyword ballots present', async () => {
    const runs = await Promise.all(['left', 'right'].map(async (nonce) => {
      const service = buildService({ contentRulesEnabled: true, seed: ADOPTING_SEED });
      const created = await service.createSession({ communityId: 'community_gov', clientNonce: nonce });
      const session = created.payload.session;
      const advanced = await runFullEpoch(service, session.sessionId, session.currentEpochId, ['atproto'], nonce);
      const feed = await service.getFeed({
        sessionId: session.sessionId,
        epochId: advanced.payload.session.currentEpochId,
        limit: 12,
      });
      const epochs = advanced.payload.session.epochs.map((epoch) => epoch.aggregate);
      return JSON.stringify({ epochs, posts: feed.payload.posts, withheld: feed.payload.withheldPosts });
    }));
    expect(runs[0]).toEqual(runs[1]);
  });
});

describe('shadow demo stored content-rules schema round trip', () => {
  it('round-trips an adopted content-rules summary and a reviewer excludeKeywords ballot through the Redis store schema', async () => {
    const session = storedSessionWithContentRules();
    const { corpus: storedCorpus, ...header } = session;
    const get = vi.fn()
      .mockResolvedValueOnce(JSON.stringify(header))
      .mockResolvedValueOnce(JSON.stringify(storedCorpus));
    const store = new RedisDemoStore({ get } as unknown as Redis);

    const restored = await store.readSession(session.sessionId);

    expect(restored?.epochs[0]?.aggregate.contentRules).toEqual({
      enabled: true,
      threshold: 8,
      electorate: 25,
      adoptedExcludeKeywords: ['atproto'],
      support: [{ keyword: 'atproto', supportCount: 10, adopted: true }],
    });
    expect(restored?.votes[0]?.excludeKeywords).toEqual(['atproto']);
  });

  it('accepts a stored session whose content-rules arrays sit exactly at the schema maximums', async () => {
    const atMax = storedSessionWithContentRules();
    atMax.epochs[0].aggregate.contentRules!.adoptedExcludeKeywords =
      Array.from({ length: SHADOW_DEMO_MAX_EXCLUDE_KEYWORDS }, (_unused, i) => `keyword-${i}`);
    atMax.epochs[0].aggregate.contentRules!.support =
      Array.from({ length: STORED_SUPPORT_MAX }, (_unused, i) => ({
        keyword: `keyword-${i}`,
        supportCount: 1,
        adopted: i < SHADOW_DEMO_MAX_EXCLUDE_KEYWORDS,
      }));
    const { corpus: atMaxCorpus, ...atMaxHeader } = atMax;
    const get = vi.fn()
      .mockResolvedValueOnce(JSON.stringify(atMaxHeader))
      .mockResolvedValueOnce(JSON.stringify(atMaxCorpus));
    const restored = await new RedisDemoStore({ get } as unknown as Redis).readSession(atMax.sessionId);
    expect(restored?.epochs[0].aggregate.contentRules?.adoptedExcludeKeywords).toHaveLength(
      SHADOW_DEMO_MAX_EXCLUDE_KEYWORDS
    );
    expect(restored?.epochs[0].aggregate.contentRules?.support).toHaveLength(STORED_SUPPORT_MAX);
  });

  it('rejects a stored session whose content-rules arrays exceed the schema bounds', async () => {
    const tooManyAdopted = storedSessionWithContentRules();
    tooManyAdopted.epochs[0].aggregate.contentRules!.adoptedExcludeKeywords =
      Array.from({ length: SHADOW_DEMO_MAX_EXCLUDE_KEYWORDS + 1 }, (_unused, i) => `keyword-${i}`);
    const { corpus: adoptedCorpus, ...adoptedHeader } = tooManyAdopted;
    const getAdopted = vi.fn()
      .mockResolvedValueOnce(JSON.stringify(adoptedHeader))
      .mockResolvedValueOnce(JSON.stringify(adoptedCorpus));
    await expect(
      new RedisDemoStore({ get: getAdopted } as unknown as Redis).readSession(tooManyAdopted.sessionId)
    ).rejects.toBeInstanceOf(DemoStoreCorruptionError);

    const tooMuchSupport = storedSessionWithContentRules();
    tooMuchSupport.epochs[0].aggregate.contentRules!.support = Array.from({ length: STORED_SUPPORT_MAX + 1 }, (_unused, i) => ({
      keyword: `keyword-${i}`,
      supportCount: 1,
      adopted: false,
    }));
    const { corpus: supportCorpus, ...supportHeader } = tooMuchSupport;
    const getSupport = vi.fn()
      .mockResolvedValueOnce(JSON.stringify(supportHeader))
      .mockResolvedValueOnce(JSON.stringify(supportCorpus));
    await expect(
      new RedisDemoStore({ get: getSupport } as unknown as Redis).readSession(tooMuchSupport.sessionId)
    ).rejects.toBeInstanceOf(DemoStoreCorruptionError);
  });
});

/** A minimal advanced-epoch session carrying an adopted content-rules summary
 * and a reviewer excludeKeywords ballot, for exercising the stored zod schema. */
function storedSessionWithContentRules(): ShadowDemoSessionState {
  const weights = { recency: 0.2, engagement: 0.2, bridging: 0.2, source_diversity: 0.2, relevance: 0.2 };
  const topicIntent = { topicWeights: { 'science-research': 0.8 } };
  return {
    sessionId: 'content-rules-store-session',
    communityId: 'community_gov',
    seed: 'seed-0',
    phase: 'epoch_advanced',
    createdAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 90 * 60_000).toISOString(),
    corpusId: 'content-rules-store-corpus',
    currentEpochId: 'epoch-1',
    epochs: [{
      id: 'epoch-1',
      sequence: 1,
      label: 'Epoch 1',
      status: 'open',
      createdAt: NOW.toISOString(),
      advancedAt: null,
      decidedByEpochId: null,
      aggregate: {
        aggregateMethod: 'trimmed_mean_no_trim_under_10',
        voteCount: 1,
        trimCount: 0,
        weights,
        topicIntent,
        contentRules: {
          enabled: true,
          threshold: 8,
          electorate: 25,
          adoptedExcludeKeywords: ['atproto'],
          support: [{ keyword: 'atproto', supportCount: 10, adopted: true }],
        },
      },
    }],
    votes: [{
      id: 'vote-1',
      epochId: 'epoch-1',
      label: 'Reviewer ballot',
      weights,
      topicIntent,
      excludeKeywords: ['atproto'],
      createdAt: NOW.toISOString(),
      actorType: 'reviewer',
      actorId: 'reviewer',
    }],
    corpus: {
      corpusId: 'content-rules-store-corpus',
      communityId: 'community_gov',
      baseProductionEpochId: 2,
      baseWeights: weights,
      baseTopicIntent: topicIntent,
      createdAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 90 * 60_000).toISOString(),
      items: [],
      health: {
        status: 'live',
        source: 'production_feed_snapshot',
        candidatePosts72h: 100,
        publicScoredPosts: 40,
        uniqueAuthors72h: 40,
        bridgePostShare: 0.33,
        topAuthorConcentration: 0.025,
        sampledAt: NOW.toISOString(),
      },
      warnings: [],
    },
    warnings: [],
  };
}

/** A service over an in-memory store with a fixed session seed, so synthetic
 * keyword echoes are deterministic and adoption outcomes are pinned. Pass a
 * shared store to model a config flip against sessions built by another service. */
function buildService(
  options: { contentRulesEnabled: boolean; seed: string },
  store: MemoryDemoStore = new MemoryDemoStore()
): ShadowDemoService {
  return new ShadowDemoService({
      projectDisplay: async (_corpus, items) => new Map(items.map((item) => [item.postUri, item.displayPost])),
    store,
    loadCorpus: async () => corpus(),
    now: () => NOW,
    contentRulesEnabled: options.contentRulesEnabled,
    seed: () => options.seed,
  });
}

/** Drive one epoch end to end: reviewer vote (optionally with keywords), the 24
 * synthetic ballots, then advance — returning the advanced-session result. */
async function runFullEpoch(
  service: ShadowDemoService,
  sessionId: string,
  baseEpochId: string,
  excludeKeywords: string[] | undefined,
  keyPrefix: string
): Promise<Awaited<ReturnType<ShadowDemoService['advanceEpoch']>>> {
  await service.castVote({
    sessionId,
    baseEpochId,
    weights: equalWeights(),
    topicIntent: fullTopicIntent(),
    ...(excludeKeywords ? { excludeKeywords } : {}),
    idempotencyKey: `${keyPrefix}-vote`,
  });
  await service.runSyntheticVoters({
    sessionId,
    baseEpochId,
    idempotencyKey: `${keyPrefix}-voters`,
  });
  return service.advanceEpoch({
    sessionId,
    fromEpochId: baseEpochId,
    idempotencyKey: `${keyPrefix}-advance`,
  });
}

function equalWeights(): Record<string, number> {
  return { recency: 0.2, engagement: 0.2, bridging: 0.2, source_diversity: 0.2, relevance: 0.2 };
}

function fullTopicIntent(): { topicWeights: Record<string, number> } {
  return { topicWeights: Object.fromEntries(TOPICS.map((topic) => [topic.slug, topic.baselineWeight])) };
}

function postUri(index: number): string {
  return `at://did:plc:demo${index}/app.bsky.feed.post/post${index}`;
}

/** A 40-post frozen community_gov corpus (baseProductionEpochId 2) with two
 * atproto-bearing posts, so an adopted "-atproto" rule has a visible effect. */
function corpus(): ShadowDemoCorpus {
  const items = Array.from({ length: 40 }, (_unused, index) => item(index + 1));
  return {
    corpusId: 'approved-community-gov-corpus',
    communityId: 'community_gov',
    baseProductionEpochId: 2,
    baseWeights: { recency: 0.25, engagement: 0.2, bridging: 0.1, source_diversity: 0.1, relevance: 0.35 },
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

/** One frozen corpus post; posts 2-3 mention atproto and 4/7 mention headscale
 * so keyword rules and suggestion floors have deterministic matches. */
function item(index: number): ShadowDemoCorpus['items'][number] {
  const uri = postUri(index);
  // Posts 2 and 3 mention "atproto" so an adopted "-atproto" rule has a
  // deterministic visible effect; posts 4 and 7 mention "headscale" so the
  // suggestion floor of two matches is exercised by a second term.
  const text = index === 2 || index === 3
    ? `Deep dive ${index}: why ATProto relays matter for federation health`
    : index === 4 || index === 7
      ? `Self-hosting notes ${index}: headscale, reverse proxies, and identity`
      : `Published feed post ${index} about community governance mechanics`;
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
      text, likeCount: index, repostCount: index, replyCount: index, quoteCount: 0,
      indexedAt: NOW.toISOString(), createdAt: NOW.toISOString(), bskyUrl: `https://bsky.app/profile/did:plc:demo${index}/post/post${index}`,
      languages: ['en'], media: null,
    },
  };
}
