import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import {
  DEMO_MAX_SESSION_BYTES,
  DEMO_MAX_IDEMPOTENCY_BYTES,
  DemoStoreCapacityError,
  DemoStoreCorruptionError,
  DemoStoreUnavailableError,
  RedisDemoStore,
  MemoryDemoStore,
  demoSharedCorpusIdentity,
} from '../src/demo/store.js';
import type { ShadowDemoSessionState } from '../src/demo/types.js';

describe('Redis shadow demo store', () => {
  it('creates the frozen corpus and bounded session in one Redis script', async () => {
    const evalCommand = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(1);
    const setex = vi.fn().mockResolvedValue('OK');
    const redis = { eval: evalCommand, setex } as unknown as Redis;
    const store = new RedisDemoStore(redis);
    const session = storedSession();

    await expect(store.createSession(session, 120, 50, 'create-1')).resolves.toBe(true);

    expect(evalCommand).toHaveBeenCalledTimes(2);
    expect(evalCommand.mock.calls[0]).toEqual(expect.arrayContaining([
      1,
      'demo:sessions:active',
    ]));
    expect(evalCommand.mock.calls[1]).toEqual(expect.arrayContaining([
      6,
      'demo:session:demo-store-session',
      'demo:corpus:demo-store-corpus',
      'demo:sessions:active',
      'demo:session-nonce:create-1',
    ]));
    expect(setex).toHaveBeenCalledTimes(2);
  });

  it('commits session state and idempotency only while the lock token still owns the mutation', async () => {
    const evalCommand = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const setex = vi.fn().mockResolvedValue('OK');
    const del = vi.fn().mockResolvedValue(1);
    const redis = { eval: evalCommand, setex, del } as unknown as Redis;
    const store = new RedisDemoStore(redis);
    const mutation = {
      session: storedSession(),
      ttlSeconds: 120,
      lockToken: 'owner-token',
      idempotencyKey: 'vote-1',
      idempotencyRecord: {
        requestHash: 'hash',
        response: { ok: true },
        createdAt: '2026-07-10T00:00:00.000Z',
      },
    };

    await expect(store.commitSessionMutation(mutation)).resolves.toBe(true);
    await expect(store.commitSessionMutation(mutation)).resolves.toBe(false);

    expect(evalCommand.mock.calls[0]).toEqual(expect.arrayContaining([
      6,
      'demo:lock:demo-store-session',
      'demo:session:demo-store-session',
      'demo:corpus:demo-store-corpus',
      'demo:idempotency:demo-store-session:vote-1',
      'owner-token',
    ]));
    expect(setex).toHaveBeenCalledTimes(4);
  });

  it('returns null only for missing records and raises explicit corruption errors', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('{not-json')
      .mockResolvedValueOnce(JSON.stringify({ sessionId: 'partial' }));
    const store = new RedisDemoStore({ get } as unknown as Redis);

    await expect(store.readSession('missing')).resolves.toBeNull();
    await expect(store.readSession('malformed')).rejects.toBeInstanceOf(DemoStoreCorruptionError);
    await expect(store.readSession('partial')).rejects.toBeInstanceOf(DemoStoreCorruptionError);
  });

  it('round-trips the v4 publication policy from Redis', async () => {
    const session = storedSession();
    session.communityId = 'community_gov';
    session.corpus.communityId = 'community_gov';
    session.corpus.sourceSnapshot = {
      feedName: 'Community Governed Feed',
      digest: 'a'.repeat(64),
      runId: 'run-v4',
      updatedAt: '2026-07-10T00:00:00.000Z',
      capturedAt: '2026-07-10T00:01:00.000Z',
      reviewedAt: '2026-07-10T00:02:00.000Z',
      sourcePostCount: 100,
      selectionPolicyVersion: 'community-gov-reviewer-safe-v1',
      baselineOrderDigest: 'b'.repeat(64),
      publicationPolicy: {
        urlDedupEnabled: true,
        minimumOriginalTextLength: 200,
        minimumRelevance: 0.25,
        decay: [1, 0.7, 0.5, 0.3],
      },
    };
    const { corpus, ...header } = session;
    const get = vi.fn()
      .mockResolvedValueOnce(JSON.stringify(header))
      .mockResolvedValueOnce(JSON.stringify(corpus));
    const store = new RedisDemoStore({ get } as unknown as Redis);

    await expect(store.readSession(session.sessionId)).resolves.toMatchObject({
      corpus: {
        sourceSnapshot: {
          publicationPolicy: {
            minimumRelevance: 0.25,
          },
        },
      },
    });
  });

  it('reads retry-safe session creation nonce mappings from Redis', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce('demo-existing-session')
      .mockResolvedValueOnce(null);
    const store = new RedisDemoStore({ get } as unknown as Redis);

    await expect(store.readSessionIdByClientNonce('known-nonce')).resolves.toBe('demo-existing-session');
    await expect(store.readSessionIdByClientNonce('unknown-nonce')).resolves.toBeNull();
    expect(get).toHaveBeenNthCalledWith(1, 'demo:session-nonce:known-nonce');
    expect(get).toHaveBeenNthCalledWith(2, 'demo:session-nonce:unknown-nonce');
  });

  it('uses a versioned shared-corpus key so pre-v4 cache entries are bypassed', async () => {
    const get = vi.fn().mockResolvedValue(null);
    const store = new RedisDemoStore({ get } as unknown as Redis);

    await expect(store.readSharedCorpus('community_gov')).resolves.toBeNull();
    expect(get).toHaveBeenCalledWith(expect.stringMatching(/^demo:corpus:current:v4:community_gov:[a-f0-9]{64}$/));
  });

  it('binds corpus identity to manifest and visibility policy', () => {
    const identity = demoSharedCorpusIdentity('community_gov', 'manifest-a', 'policy-a');
    expect(demoSharedCorpusIdentity('community_gov', 'manifest-a', 'policy-a')).toBe(identity);
    expect(demoSharedCorpusIdentity('community_gov', 'manifest-b', 'policy-a')).not.toBe(identity);
    expect(demoSharedCorpusIdentity('community_gov', 'manifest-a', 'policy-b')).not.toBe(identity);
  });

  it('does not let a builder publish after losing corpus ownership', async () => {
    const store = new MemoryDemoStore();
    const corpus = storedSession().corpus;
    await store.acquireCorpusBuildLock(corpus.communityId, 'old-owner', 100);
    await store.releaseCorpusBuildLock(corpus.communityId, 'old-owner');
    await store.acquireCorpusBuildLock(corpus.communityId, 'new-owner', 100);
    await expect(store.commitSharedCorpus(corpus.communityId, 'old-owner', corpus, 60)).resolves.toBe(false);
    await expect(store.readSharedCorpus(corpus.communityId)).resolves.toBeNull();
    await expect(store.commitSharedCorpus(corpus.communityId, 'new-owner', corpus, 60)).resolves.toBe(true);
    await expect(store.readSharedCorpus(corpus.communityId)).resolves.toEqual(corpus);
  });

  it('connects a cold lazy client before issuing its first store command', async () => {
    let redisStatus = 'wait';
    const connect = vi.fn(async () => {
      redisStatus = 'ready';
    });
    const redisState = {
      get status(): string {
        return redisStatus;
      },
      get: vi.fn().mockResolvedValue(null),
      connect,
    };
    const store = new RedisDemoStore(redisState as unknown as Redis);

    await expect(store.readSession('cold-start')).resolves.toBeNull();
    expect(connect).toHaveBeenCalledOnce();
    expect(redisState.get).toHaveBeenCalledOnce();
  });

  it('surfaces Redis command failures as demo-only unavailability', async () => {
    const evalCommand = vi.fn().mockRejectedValue(new Error('OOM command not allowed'));
    const redis = { eval: evalCommand } as unknown as Redis;
    const store = new RedisDemoStore(redis);

    await expect(store.createSession(storedSession(), 120, 50, 'create-2')).rejects.toBeInstanceOf(
      DemoStoreUnavailableError
    );
  });

  it('does not run the authoritative publish script when noeviction rejects staging', async () => {
    const evalCommand = vi.fn().mockResolvedValue(1);
    const setex = vi.fn()
      .mockResolvedValueOnce('OK')
      .mockRejectedValueOnce(new Error('OOM command not allowed'));
    const del = vi.fn().mockResolvedValue(1);
    const zrem = vi.fn().mockResolvedValue(1);
    const store = new RedisDemoStore({ eval: evalCommand, setex, del, zrem } as unknown as Redis);

    await expect(store.createSession(storedSession(), 120, 50, 'create-3')).rejects.toBeInstanceOf(
      DemoStoreUnavailableError
    );
    expect(evalCommand).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith(expect.stringMatching(/^demo:staging:.*:session$/));
    expect(zrem).toHaveBeenCalledWith('demo:sessions:active', 'demo-store-session');
  });

  it('releases the active-session reservation when the first staging write fails', async () => {
    const evalCommand = vi.fn().mockResolvedValue(1);
    const setex = vi.fn().mockRejectedValueOnce(new Error('OOM command not allowed'));
    const del = vi.fn().mockResolvedValue(0);
    const zrem = vi.fn().mockResolvedValue(1);
    const store = new RedisDemoStore({ eval: evalCommand, setex, del, zrem } as unknown as Redis);

    await expect(store.createSession(storedSession(), 120, 50, 'create-4')).rejects.toBeInstanceOf(
      DemoStoreUnavailableError
    );
    expect(evalCommand).toHaveBeenCalledTimes(1);
    expect(setex).toHaveBeenCalledOnce();
    expect(zrem).toHaveBeenCalledWith('demo:sessions:active', 'demo-store-session');
  });

  it('cleans staged session records when the authoritative create script fails', async () => {
    const evalCommand = vi.fn()
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(new Error('connection dropped before eval'));
    const setex = vi.fn().mockResolvedValue('OK');
    const del = vi.fn().mockResolvedValue(2);
    const zrem = vi.fn().mockResolvedValue(1);
    const store = new RedisDemoStore({ eval: evalCommand, setex, del, zrem } as unknown as Redis);

    await expect(store.createSession(storedSession(), 120, 50, 'create-5')).rejects.toBeInstanceOf(
      DemoStoreUnavailableError
    );
    expect(del).toHaveBeenCalledWith(
      expect.stringMatching(/^demo:staging:.*:session$/),
      expect.stringMatching(/^demo:staging:.*:corpus$/)
    );
    expect(zrem).toHaveBeenCalledWith('demo:sessions:active', 'demo-store-session');
  });

  it('cleans staged mutation records when the authoritative commit script fails', async () => {
    const evalCommand = vi.fn().mockRejectedValue(new Error('connection dropped before eval'));
    const setex = vi.fn().mockResolvedValue('OK');
    const del = vi.fn().mockResolvedValue(2);
    const store = new RedisDemoStore({ eval: evalCommand, setex, del } as unknown as Redis);

    await expect(store.commitSessionMutation({
      session: storedSession(),
      ttlSeconds: 120,
      lockToken: 'owner-token',
      idempotencyKey: 'vote-1',
      idempotencyRecord: {
        requestHash: 'hash',
        response: { ok: true },
        createdAt: '2026-07-10T00:00:00.000Z',
      },
    })).rejects.toBeInstanceOf(DemoStoreUnavailableError);
    expect(del).toHaveBeenCalledWith(
      expect.stringMatching(/^demo:staging:.*:session$/),
      expect.stringMatching(/^demo:staging:.*:idempotency$/)
    );
  });

  it('does not stage a session when the active-session reservation is full', async () => {
    const evalCommand = vi.fn().mockResolvedValue(0);
    const setex = vi.fn();
    const store = new RedisDemoStore({ eval: evalCommand, setex } as unknown as Redis);

    await expect(store.createSession(storedSession(), 120, 50, 'create-6')).resolves.toBe(false);
    expect(setex).not.toHaveBeenCalled();
    expect(evalCommand).toHaveBeenCalledOnce();
  });

  it('rejects a duplicate creation nonce before publishing a second session', async () => {
    // The first eval reserves a slot; the second is the authoritative create script.
    const evalCommand = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    const setex = vi.fn().mockResolvedValue('OK');
    const del = vi.fn().mockResolvedValue(2);
    const zrem = vi.fn().mockResolvedValue(1);
    const store = new RedisDemoStore({ eval: evalCommand, setex, del, zrem } as unknown as Redis);

    await expect(store.createSession(storedSession(), 120, 50, 'duplicate-create')).resolves.toBe(false);
    expect(del).toHaveBeenCalledWith(
      expect.stringMatching(/^demo:staging:.*:session$/),
      expect.stringMatching(/^demo:staging:.*:corpus$/)
    );
    expect(zrem).toHaveBeenCalledWith('demo:sessions:active', 'demo-store-session');
  });

  it('cleans reservations when staged create records expire before publication', async () => {
    const evalCommand = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(-1);
    const setex = vi.fn().mockResolvedValue('OK');
    const del = vi.fn().mockResolvedValue(2);
    const zrem = vi.fn().mockResolvedValue(1);
    const store = new RedisDemoStore({ eval: evalCommand, setex, del, zrem } as unknown as Redis);

    await expect(store.createSession(storedSession(), 120, 50, 'create-7')).rejects.toBeInstanceOf(
      DemoStoreUnavailableError
    );
    expect(del).toHaveBeenCalled();
    expect(zrem).toHaveBeenCalledWith('demo:sessions:active', 'demo-store-session');
  });

  it('cleans staged mutation records that expire before publication', async () => {
    const evalCommand = vi.fn().mockResolvedValue(-1);
    const setex = vi.fn().mockResolvedValue('OK');
    const del = vi.fn().mockResolvedValue(1);
    const store = new RedisDemoStore({ eval: evalCommand, setex, del } as unknown as Redis);

    await expect(store.commitSessionMutation({
      session: storedSession(),
      ttlSeconds: 120,
      lockToken: 'owner-token',
      idempotencyKey: null,
      idempotencyRecord: null,
    })).rejects.toBeInstanceOf(DemoStoreUnavailableError);
    expect(del).toHaveBeenCalledWith(expect.stringMatching(/^demo:staging:.*:session$/));
  });

  it('rejects oversized session state before issuing a Redis command', async () => {
    const evalCommand = vi.fn();
    const store = new RedisDemoStore({ eval: evalCommand } as unknown as Redis);
    const session = storedSession();
    session.warnings = [{
      code: 'oversized',
      message: 'x'.repeat(DEMO_MAX_SESSION_BYTES + 1),
      severity: 'degraded',
    }];

    await expect(store.createSession(session, 120, 50, 'create-8')).rejects.toBeInstanceOf(
      DemoStoreCapacityError
    );
    expect(evalCommand).not.toHaveBeenCalled();
  });

  it('rejects oversized idempotency records before issuing a Redis command', async () => {
    const evalCommand = vi.fn();
    const store = new RedisDemoStore({ eval: evalCommand } as unknown as Redis);

    await expect(store.commitSessionMutation({
      session: storedSession(),
      ttlSeconds: 120,
      lockToken: 'owner-token',
      idempotencyKey: 'vote-1',
      idempotencyRecord: {
        requestHash: 'hash',
        response: { blob: 'x'.repeat(DEMO_MAX_IDEMPOTENCY_BYTES + 1) },
        createdAt: '2026-07-10T00:00:00.000Z',
      },
    })).rejects.toBeInstanceOf(DemoStoreCapacityError);
    expect(evalCommand).not.toHaveBeenCalled();
  });

  it('skips idempotency publication when a key has no record', async () => {
    const evalCommand = vi.fn().mockResolvedValue(1);
    const setex = vi.fn().mockResolvedValue('OK');
    const store = new RedisDemoStore({ eval: evalCommand, setex } as unknown as Redis);

    await expect(store.commitSessionMutation({
      session: storedSession(),
      ttlSeconds: 120,
      lockToken: 'owner-token',
      idempotencyKey: 'missing-record',
      idempotencyRecord: null,
    })).resolves.toBe(true);
    expect(setex).toHaveBeenCalledTimes(1);
    expect(evalCommand.mock.calls[0].at(-1)).toBe('0');
  });

  it('allows only the current lock owner to commit concurrent session state', async () => {
    const store = new MemoryDemoStore();
    const session = storedSession();
    await expect(store.createSession(session, 120, 50, 'create-9')).resolves.toBe(true);
    await expect(store.acquireSessionLock(session.sessionId, 'writer-a', 15_000)).resolves.toBe(true);
    await expect(store.acquireSessionLock(session.sessionId, 'writer-b', 15_000)).resolves.toBe(false);
    const nextState = { ...session, phase: 'reviewer_voted' as const };

    await expect(store.commitSessionMutation({
      session: nextState,
      ttlSeconds: 120,
      lockToken: 'writer-b',
      idempotencyKey: null,
      idempotencyRecord: null,
    })).resolves.toBe(false);
    await expect(store.readSession(session.sessionId)).resolves.toMatchObject({ phase: 'created' });

    await expect(store.commitSessionMutation({
      session: nextState,
      ttlSeconds: 120,
      lockToken: 'writer-a',
      idempotencyKey: null,
      idempotencyRecord: null,
    })).resolves.toBe(true);
    await expect(store.readSession(session.sessionId)).resolves.toMatchObject({ phase: 'reviewer_voted' });
  });

  it('maps one memory-store creation nonce to one session', async () => {
    const store = new MemoryDemoStore();
    const first = storedSession();
    const duplicate = storedSession();
    duplicate.sessionId = 'demo-store-duplicate';
    duplicate.corpusId = 'demo-store-duplicate-corpus';
    duplicate.corpus.corpusId = duplicate.corpusId;

    await expect(store.createSession(first, 120, 50, 'same-create')).resolves.toBe(true);
    await expect(store.createSession(duplicate, 120, 50, 'same-create')).resolves.toBe(false);
    await expect(store.readSessionIdByClientNonce('same-create')).resolves.toBe(first.sessionId);
    await expect(store.readSession(duplicate.sessionId)).resolves.toBeNull();
  });

  it('enforces memory-store capacity while evicting expired sessions', async () => {
    const store = new MemoryDemoStore();
    const first = storedSession();
    first.expiresAt = '2026-07-10T00:01:00.000Z';
    await expect(store.createSession(first, 120, 1, 'create-10')).resolves.toBe(true);

    const blocked = storedSession();
    blocked.sessionId = 'demo-store-blocked';
    blocked.corpusId = 'demo-store-blocked-corpus';
    blocked.corpus.corpusId = blocked.corpusId;
    blocked.createdAt = '2026-07-10T00:00:30.000Z';
    await expect(store.createSession(blocked, 120, 1, 'create-11')).resolves.toBe(false);

    const replacement = storedSession();
    replacement.sessionId = 'demo-store-replacement';
    replacement.corpusId = 'demo-store-replacement-corpus';
    replacement.corpus.corpusId = replacement.corpusId;
    replacement.createdAt = '2026-07-10T00:02:00.000Z';
    await expect(store.createSession(replacement, 120, 1, 'create-12')).resolves.toBe(true);
    await expect(store.readSession(first.sessionId)).resolves.toBeNull();
  });

  it('hydrates a stored session header from its frozen corpus record', async () => {
    const session = storedSession();
    const { corpus, ...sessionHeader } = session;
    const get = vi.fn()
      .mockResolvedValueOnce(JSON.stringify(sessionHeader))
      .mockResolvedValueOnce(JSON.stringify(corpus));
    const store = new RedisDemoStore({ get } as unknown as Redis);

    await expect(store.readSession(session.sessionId)).resolves.toEqual(session);
    expect(get).toHaveBeenNthCalledWith(1, 'demo:session:demo-store-session');
    expect(get).toHaveBeenNthCalledWith(2, 'demo:corpus:demo-store-corpus');
  });

  it('rejects stored corpus health ratios outside the unit interval', async () => {
    for (const field of ['bridgePostShare', 'topAuthorConcentration', 'englishTaggedShare', 'richMediaShare'] as const) {
      for (const invalidRatio of [-0.01, 1.01]) {
        const session = storedSession();
        const { corpus, ...sessionHeader } = session;
        const invalidCorpus = {
          ...corpus,
          health: { ...corpus.health, [field]: invalidRatio },
        };
        const get = vi.fn()
          .mockResolvedValueOnce(JSON.stringify(sessionHeader))
          .mockResolvedValueOnce(JSON.stringify(invalidCorpus));
        const store = new RedisDemoStore({ get } as unknown as Redis);

        await expect(store.readSession(session.sessionId)).rejects.toBeInstanceOf(DemoStoreCorruptionError);
      }
    }
  });

  it('raises explicit corruption when a session references a missing corpus', async () => {
    const session = storedSession();
    const { corpus: _corpus, ...sessionHeader } = session;
    const get = vi.fn()
      .mockResolvedValueOnce(JSON.stringify(sessionHeader))
      .mockResolvedValueOnce(null);
    const store = new RedisDemoStore({ get } as unknown as Redis);

    await expect(store.readSession(session.sessionId)).rejects.toThrow(
      /referenced corpus demo-store-corpus is missing/
    );
  });

  it('rejects malformed nested epochs, votes, and corpus items', async () => {
    const session = storedSession();
    const get = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ ...session, epochs: [{}] }))
      .mockResolvedValueOnce(JSON.stringify({ ...session, votes: [{}] }))
      .mockResolvedValueOnce(JSON.stringify({
        ...session,
        corpus: { ...session.corpus, items: [{}] },
      }));
    const store = new RedisDemoStore({ get } as unknown as Redis);

    await expect(store.readSession('invalid-epoch')).rejects.toBeInstanceOf(DemoStoreCorruptionError);
    await expect(store.readSession('invalid-vote')).rejects.toBeInstanceOf(DemoStoreCorruptionError);
    await expect(store.readSession('invalid-item')).rejects.toBeInstanceOf(DemoStoreCorruptionError);
  });

  it('rejects unsafe media and quote navigation targets in persisted corpus state', async () => {
    const session = storedSession();
    const { corpus, ...sessionHeader } = session;
    const validItem = storedPublicItem();
    const invalidItems = [
      {
        ...validItem,
        displayPost: {
          ...validItem.displayPost,
          media: {
            ...validItem.displayPost.media,
            images: [{ ...validItem.displayPost.media.images[0], fullsize: 'http://cdn.example/full.jpg' }],
          },
        },
      },
      {
        ...validItem,
        displayPost: {
          ...validItem.displayPost,
          media: {
            ...validItem.displayPost.media,
            quote: { ...validItem.displayPost.media.quote, uri: 'https://bsky.app/not-an-at-uri' },
          },
        },
      },
    ];

    for (const invalidItem of invalidItems) {
      const get = vi.fn()
        .mockResolvedValueOnce(JSON.stringify(sessionHeader))
        .mockResolvedValueOnce(JSON.stringify({ ...corpus, items: [invalidItem] }));
      const store = new RedisDemoStore({ get } as unknown as Redis);

      await expect(store.readSession(session.sessionId)).rejects.toBeInstanceOf(DemoStoreCorruptionError);
    }
  });
});

function storedPublicItem(): ShadowDemoSessionState['corpus']['items'][number] & {
  displayPost: Extract<ShadowDemoSessionState['corpus']['items'][number]['displayPost'], { kind: 'public_post' }> & {
    media: NonNullable<Extract<ShadowDemoSessionState['corpus']['items'][number]['displayPost'], { kind: 'public_post' }>['media']>;
  };
} {
  return {
    postUri: 'at://did:plc:author/app.bsky.feed.post/post',
    authorDid: 'did:plc:author',
    createdAt: '2026-07-10T00:00:00.000Z',
    topicVector: { 'science-research': 0.8 },
    rawScores: {
      recency: 0.5,
      engagement: 0.5,
      bridging: 0.5,
      source_diversity: 0.5,
      relevance: 0.5,
    },
    productionScore: 0.5,
    productionEpochId: 2,
    scoredAt: '2026-07-10T00:00:00.000Z',
    componentDetails: null,
    inclusionReasons: { matchedTopics: [{ topic: 'science-research', score: 0.8 }], matchedTerms: [] },
    displayPost: {
      kind: 'public_post',
      uri: 'at://did:plc:author/app.bsky.feed.post/post',
      cid: 'cid-post',
      authorDid: 'did:plc:author',
      authorHandle: 'author.bsky.social',
      authorDisplayName: 'Author',
      authorAvatar: 'https://cdn.example/avatar.jpg',
      text: 'A public post with a safe media card.',
      likeCount: 1,
      repostCount: 1,
      replyCount: 1,
      quoteCount: 0,
      indexedAt: '2026-07-10T00:00:00.000Z',
      createdAt: '2026-07-10T00:00:00.000Z',
      bskyUrl: 'https://bsky.app/profile/did:plc:author/post/post',
      media: {
        images: [{
          thumb: 'https://cdn.example/thumb.jpg',
          fullsize: 'https://cdn.example/full.jpg',
          alt: 'A chart',
          width: 800,
          height: 600,
        }],
        external: null,
        quote: {
          uri: 'at://did:plc:quoted/app.bsky.feed.post/quote',
          authorHandle: 'quoted.bsky.social',
          authorDisplayName: 'Quoted Author',
          text: 'Quoted context',
        },
        video: null,
      },
    },
  };
}

function storedSession(): ShadowDemoSessionState {
  return {
    sessionId: 'demo-store-session',
    communityId: 'open_science_builders',
    seed: 'seed',
    phase: 'created',
    createdAt: '2026-07-10T00:00:00.000Z',
    expiresAt: '2026-07-10T01:30:00.000Z',
    corpusId: 'demo-store-corpus',
    currentEpochId: 'epoch-1',
    epochs: [],
    votes: [],
    corpus: {
      corpusId: 'demo-store-corpus',
      communityId: 'open_science_builders',
      baseProductionEpochId: 2,
      baseWeights: {
        recency: 0.2,
        engagement: 0.2,
        bridging: 0.2,
        source_diversity: 0.2,
        relevance: 0.2,
      },
      baseTopicIntent: { topicWeights: { 'science-research': 0.8 } },
      createdAt: '2026-07-10T00:00:00.000Z',
      expiresAt: '2026-07-10T01:30:00.000Z',
      items: [],
      health: {
        status: 'live',
        source: 'production_scores_appview',
        candidatePosts72h: 100,
        publicScoredPosts: 12,
        uniqueAuthors72h: 50,
        bridgePostShare: 0.2,
        topAuthorConcentration: 0.05,
        sampledAt: '2026-07-10T00:00:00.000Z',
      },
      warnings: [],
    },
    warnings: [],
  };
}
