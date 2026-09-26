import { describe, expect, it, vi } from 'vitest';
import { buildAppViewGetPostsUrl, hydrateCorpusItemsWithAppView } from '../src/demo/appview.js';
import {
  bskyPostUrlFromAtUri,
  hiddenReasonForPublicView,
  publicPostFromAppView,
  type AppViewPost,
} from '../src/demo/public-view.js';

const PUBLIC_POST: AppViewPost = {
  uri: 'at://did:plc:author/app.bsky.feed.post/abc123',
  cid: 'bafyabc123',
  author: {
    did: 'did:plc:author',
    handle: 'maya-keene.bsky.social',
    displayName: 'Maya Keene',
    avatar: 'https://cdn.example/avatar.jpg',
  },
  record: {
    text: 'A public birding post',
    createdAt: '2026-07-09T12:00:00.000Z',
  },
  indexedAt: '2026-07-09T12:00:01.000Z',
  likeCount: 3,
  repostCount: 2,
  replyCount: 1,
  quoteCount: 0,
  labels: [],
};

describe('shadow demo public-view filtering', () => {
  it('builds official AppView getPosts URLs with repeated uri params', () => {
    const url = new URL(
      buildAppViewGetPostsUrl([
        'at://did:plc:one/app.bsky.feed.post/a',
        'at://did:plc:two/app.bsky.feed.post/b',
      ])
    );

    expect(url.origin).toBe('https://public.api.bsky.app');
    expect(url.pathname).toBe('/xrpc/app.bsky.feed.getPosts');
    expect(url.searchParams.getAll('uris')).toEqual([
      'at://did:plc:one/app.bsky.feed.post/a',
      'at://did:plc:two/app.bsky.feed.post/b',
    ]);
  });

  it('renders public AppView records as Bluesky display posts', () => {
    expect(publicPostFromAppView(PUBLIC_POST)).toMatchObject({
      kind: 'public_post',
      uri: PUBLIC_POST.uri,
      authorHandle: 'maya-keene.bsky.social',
      text: 'A public birding post',
      likeCount: 3,
    });
  });

  it('sanitizes image, link, quote, record-with-media, and video views', () => {
    const image = publicPostFromAppView({
      ...PUBLIC_POST,
      record: { ...PUBLIC_POST.record, langs: ['es'] },
      embed: {
        $type: 'app.bsky.embed.recordWithMedia#view',
        media: {
          $type: 'app.bsky.embed.images#view',
          images: [{
            thumb: 'https://cdn.bsky.app/img/feed_thumbnail/plain/did:plc:test/image@jpeg',
            fullsize: 'https://cdn.bsky.app/img/feed_fullsize/plain/did:plc:test/image@jpeg',
            alt: 'A field notebook',
            aspectRatio: { width: 1200, height: 800 },
          }],
        },
        record: {
          record: {
            uri: 'at://did:plc:quoted/app.bsky.feed.post/quote',
            author: { handle: 'quoted.bsky.social', displayName: 'Quoted Author' },
            value: { text: 'Quoted public context' },
            labels: [],
          },
        },
      },
    });
    expect(image).toMatchObject({
      kind: 'public_post',
      languages: ['es'],
      media: {
        images: [{ alt: 'A field notebook', width: 1200, height: 800 }],
        quote: { authorHandle: 'quoted.bsky.social', text: 'Quoted public context' },
      },
    });

    const link = publicPostFromAppView({
      ...PUBLIC_POST,
      embed: {
        $type: 'app.bsky.embed.external#view',
        external: { uri: 'https://example.com/report', title: 'A report', description: 'Summary', thumb: 'https://cdn.bsky.app/img/feed_thumbnail/plain/test' },
      },
    });
    expect(link).toMatchObject({ kind: 'public_post', media: { external: { uri: 'https://example.com/report' } } });

    const video = publicPostFromAppView({
      ...PUBLIC_POST,
      embed: { $type: 'app.bsky.embed.video#view', thumbnail: 'https://cdn.bsky.app/img/feed_thumbnail/plain/video', aspectRatio: { width: 16, height: 9 } },
    });
    expect(video).toMatchObject({ kind: 'public_post', media: { video: { width: 16, height: 9 } } });
  });

  it('does not expose nested quoted content when the quote carries a hidden label', () => {
    const display = publicPostFromAppView({
      ...PUBLIC_POST,
      embed: {
        $type: 'app.bsky.embed.record#view',
        record: {
          uri: 'at://did:plc:quoted/app.bsky.feed.post/quote',
          author: { handle: 'hidden.bsky.social', displayName: 'Hidden Author' },
          value: { text: 'Nested secret text' },
          labels: [{ val: '!hide' }],
        },
      },
    });
    expect(display).toEqual({
      kind: 'hidden_post',
      reason: 'Hidden by Bluesky public-view label !hide',
    });
    expect(JSON.stringify(display)).not.toContain('Nested secret text');
  });

  it('withholds quoted records when the fallback author handle is reviewer-unsafe', () => {
    const display = publicPostFromAppView({
      ...PUBLIC_POST,
      embed: {
        $type: 'app.bsky.embed.record#view',
        record: {
          uri: 'at://did:plc:quoted/app.bsky.feed.post/quote',
          author: { handle: 'nsfw-porn.bsky.social' },
          value: { text: 'Otherwise safe quoted context' },
          labels: [],
        },
      },
    });
    expect(display).toMatchObject({ kind: 'public_post', media: null });
  });

  it('withholds quoted records when a clean display name has a reviewer-unsafe handle', () => {
    const display = publicPostFromAppView({
      ...PUBLIC_POST,
      embed: {
        $type: 'app.bsky.embed.record#view',
        record: {
          uri: 'at://did:plc:quoted/app.bsky.feed.post/quote',
          author: { handle: 'fuckyou.bsky.social', displayName: 'Jane' },
          value: { text: 'Otherwise safe quoted context' },
          labels: [],
        },
      },
    });
    expect(display).toMatchObject({ kind: 'public_post', media: null });
  });

  it('drops quoted records with empty text before storage validation', () => {
    const display = publicPostFromAppView({
      ...PUBLIC_POST,
      embed: {
        $type: 'app.bsky.embed.record#view',
        record: {
          uri: 'at://did:plc:quoted/app.bsky.feed.post/quote',
          author: { handle: 'quoted.bsky.social', displayName: 'Quoted Author' },
          value: { text: '   ' },
          labels: [],
        },
      },
    });
    expect(display).toMatchObject({ kind: 'public_post', media: null });
  });

  it('drops schema-invalid quotes and preserves the blank display-name fallback', () => {
    const quoteEmbed = (uri: string, handle: string, displayName: string) => ({
      $type: 'app.bsky.embed.record#view',
      record: {
        uri,
        author: { handle, displayName },
        value: { text: 'Valid quoted context' },
        labels: [],
      },
    });
    for (const embed of [
      quoteEmbed('https://bsky.app/not-an-at-uri', 'quoted.bsky.social', 'Quoted'),
      quoteEmbed('at://did:plc:quoted/app.bsky.feed.post/quote', '   ', 'Quoted'),
    ]) {
      expect(publicPostFromAppView({ ...PUBLIC_POST, embed })).toMatchObject({ kind: 'public_post', media: null });
    }
    expect(publicPostFromAppView({
      ...PUBLIC_POST,
      embed: quoteEmbed('at://did:plc:quoted/app.bsky.feed.post/quote', 'quoted.bsky.social', '   '),
    })).toMatchObject({
      kind: 'public_post',
      media: { quote: { authorDisplayName: 'quoted.bsky.social', authorHandle: 'quoted.bsky.social' } },
    });
  });

  it('drops non-HTTPS avatar and media navigation targets', () => {
    const display = publicPostFromAppView({
      ...PUBLIC_POST,
      author: { ...PUBLIC_POST.author, avatar: 'javascript:alert(1)' },
      embed: {
        $type: 'app.bsky.embed.external#view',
        external: { uri: 'javascript:alert(2)', title: 'Unsafe', description: 'Unsafe', thumb: 'http://example.com/thumb.jpg' },
      },
    });
    expect(display).toMatchObject({ kind: 'public_post', authorAvatar: null, media: null });
  });

  it('sanitizes reviewer-unsafe image alt text and external preview copy', () => {
    const image = publicPostFromAppView({
      ...PUBLIC_POST,
      embed: {
        $type: 'app.bsky.embed.images#view',
        images: [{
          thumb: 'https://cdn.bsky.app/img/feed_thumbnail/plain/safe',
          fullsize: 'https://cdn.bsky.app/img/feed_fullsize/plain/safe',
          alt: 'NSFW pornography preview',
        }],
      },
    });
    expect(image).toMatchObject({ kind: 'public_post', media: { images: [{ alt: '' }] } });

    for (const external of [
      { uri: 'https://example.com/report', title: 'A fucking report', description: 'Summary' },
      { uri: 'https://example.com/report', title: 'A report', description: 'NSFW pornography summary' },
    ]) {
      expect(publicPostFromAppView({
        ...PUBLIC_POST,
        embed: { $type: 'app.bsky.embed.external#view', external },
      })).toMatchObject({ kind: 'public_post', media: null });
    }
  });

  it('hides no-unauthenticated, hide, and adult-only labeled records', () => {
    expect(
      hiddenReasonForPublicView({
        ...PUBLIC_POST,
        labels: [{ val: '!no-unauthenticated' }],
      })
    ).toContain('!no-unauthenticated');
    expect(
      hiddenReasonForPublicView({
        ...PUBLIC_POST,
        labels: [{ val: '!hide' }],
      })
    ).toContain('!hide');
    expect(
      hiddenReasonForPublicView({
        ...PUBLIC_POST,
        labels: [{ val: 'porn' }],
      })
    ).toContain('porn');
  });

  it('applies the versioned reviewer-safety language and display-name gate', () => {
    for (const unsafe of [
      { ...PUBLIC_POST, record: { ...PUBLIC_POST.record, text: 'This is fucking broken.' } },
      { ...PUBLIC_POST, record: { ...PUBLIC_POST.record, text: 'A discussion of CSAM distribution.' } },
      { ...PUBLIC_POST, record: { ...PUBLIC_POST.record, text: 'NSFW pornography thread.' } },
      { ...PUBLIC_POST, author: { ...PUBLIC_POST.author, displayName: 'An asshole' } },
      { ...PUBLIC_POST, author: { ...PUBLIC_POST.author, displayName: 'Adult account 🔞' } },
      { ...PUBLIC_POST, author: { ...PUBLIC_POST.author, displayName: 'A tightpussy account' } },
      { ...PUBLIC_POST, record: { ...PUBLIC_POST.record, text: 'A MechaHitler comparison' } },
      { ...PUBLIC_POST, author: { ...PUBLIC_POST.author, displayName: 'Jane', handle: 'fuckyou.bsky.social' } },
    ]) {
      expect(publicPostFromAppView(unsafe)).toEqual({
        kind: 'hidden_post',
        reason: 'Withheld by reviewer-safety language gate',
      });
    }
  });

  it.each([
    'app.bsky.embed.record#viewBlocked',
    'app.bsky.embed.record#viewDetached',
    'app.bsky.embed.record#viewNotFound',
  ])('withholds unavailable quoted record discriminator %s even when stale fields exist', ($type) => {
    const display = publicPostFromAppView({
      ...PUBLIC_POST,
      embed: {
        record: {
          $type,
          uri: 'at://did:plc:quoted/app.bsky.feed.post/stale',
          author: { handle: 'quoted.bsky.social', displayName: 'Quoted Author' },
          value: { text: 'Stale quoted text must not be rendered' },
        },
      },
    });

    expect(display).toMatchObject({ kind: 'public_post', media: null });
  });

  it('labels absent Bluesky language metadata as undetermined', () => {
    expect(publicPostFromAppView(PUBLIC_POST)).toMatchObject({
      kind: 'public_post',
      languages: ['und'],
    });
  });

  it('hidden rows do not expose text, handle, avatar, or URL fields', () => {
    const display = publicPostFromAppView({
      ...PUBLIC_POST,
      labels: [{ val: '!hide' }],
    });

    expect(display).toEqual({
      kind: 'hidden_post',
      reason: 'Hidden by Bluesky public-view label !hide',
    });
    expect(JSON.stringify(display)).not.toContain('maya-keene');
    expect(JSON.stringify(display)).not.toContain('A public birding post');
    expect(JSON.stringify(display)).not.toContain('avatar');
    expect(JSON.stringify(display)).not.toContain('bsky.app');
  });

  it('builds Bluesky source URLs from AT Protocol post URIs', () => {
    expect(bskyPostUrlFromAtUri('at://did:plc:author/app.bsky.feed.post/abc123')).toBe(
      'https://bsky.app/profile/did:plc:author/post/abc123'
    );
    expect(bskyPostUrlFromAtUri('at://did:web:example.com:user/app.bsky.feed.post/abc:123')).toBe(
      'https://bsky.app/profile/did:web:example.com:user/post/abc%3A123'
    );
  });

  it('rejects reserved or control characters in Bluesky post AT-URIs', () => {
    for (const uri of [
      'at://did:plc:author/app.bsky.feed.post/abc?next=1',
      'at://did:plc:author/app.bsky.feed.post/abc#fragment',
      'at://did:plc:author/app.bsky.feed.post/abc 123',
      'at://did:plc:author%2Fattacker/app.bsky.feed.post/abc123',
    ]) {
      expect(() => bskyPostUrlFromAtUri(uri)).toThrow(/non-post AT-URI/);
    }
  });

  it('fails closed for malformed post and author label arrays', () => {
    for (const malformed of [
      { ...PUBLIC_POST, labels: 'not-an-array' },
      { ...PUBLIC_POST, author: { ...PUBLIC_POST.author, labels: 'not-an-array' } },
    ]) {
      expect(publicPostFromAppView(malformed)).toEqual({
        kind: 'hidden_post',
        reason: 'Post metadata unavailable from Bluesky public AppView',
      });
    }
  });

  it('normalizes invalid engagement counters to zero', () => {
    const display = publicPostFromAppView({
      ...PUBLIC_POST,
      likeCount: -1,
      repostCount: 1.5,
      replyCount: Number.NaN,
      quoteCount: Number.POSITIVE_INFINITY,
    });

    expect(display).toMatchObject({
      kind: 'public_post',
      likeCount: 0,
      repostCount: 0,
      replyCount: 0,
      quoteCount: 0,
    });
  });

  it('turns missing public metadata into an identity-free hidden row', () => {
    for (const malformed of [
      { ...PUBLIC_POST, cid: undefined },
      { ...PUBLIC_POST, indexedAt: undefined },
      { ...PUBLIC_POST, author: { ...PUBLIC_POST.author, did: undefined } },
      { ...PUBLIC_POST, author: { ...PUBLIC_POST.author, handle: '   ' } },
      { ...PUBLIC_POST, record: { ...PUBLIC_POST.record, createdAt: undefined } },
      { ...PUBLIC_POST, record: { ...PUBLIC_POST.record, text: '   ' } },
    ]) {
      const display = publicPostFromAppView(malformed);
      expect(display.kind).toBe('hidden_post');
      expect(JSON.stringify(display)).not.toContain('maya-keene');
      expect(JSON.stringify(display)).not.toContain('A public birding post');
    }
  });

  it('isolates malformed AppView posts while hydrating valid neighbors', async () => {
    const items = [
      corpusItem('at://did:plc:author/app.bsky.feed.post/abc123'),
      corpusItem('at://did:plc:other/app.bsky.feed.post/broken'),
    ];
    const hydrated = await hydrateCorpusItemsWithAppView({
      items,
      timeoutMs: 1_000,
      fetchFn: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          posts: [
            PUBLIC_POST,
            {
              ...PUBLIC_POST,
              uri: 'at://did:plc:other/app.bsky.feed.post/broken',
              cid: 42,
            },
          ],
        }),
      }),
    });

    expect(hydrated[0].displayPost.kind).toBe('public_post');
    expect(hydrated[1].displayPost).toEqual({
      kind: 'hidden_post',
      reason: 'Post unavailable from Bluesky public AppView',
    });
  });

  it('rejects author identity mismatch, duplicate and unrequested records without exposing neighbors', async () => {
    expect(publicPostFromAppView({ ...PUBLIC_POST, author: { ...PUBLIC_POST.author, did: 'did:plc:other' } }).kind).toBe('hidden_post');
    for (const posts of [[PUBLIC_POST, PUBLIC_POST], [{ ...PUBLIC_POST, uri: 'at://did:plc:other/app.bsky.feed.post/unrequested' }]]) {
      const result = await hydrateCorpusItemsWithAppView({ items: [corpusItem(PUBLIC_POST.uri as string)], timeoutMs: 1000,
        fetchFn: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ posts }) }),
      });
      expect(result[0].displayPost.kind).toBe('hidden_post');
    }
  });

  it('withholds oversized bodies and preserves a construction-time CID for unreviewed live inputs', async () => {
    const items = [corpusItem(PUBLIC_POST.uri as string)];
    const oversized = await hydrateCorpusItemsWithAppView({ items, timeoutMs: 1000,
      fetchFn: async () => ({ ok: true, status: 200, text: async () => 'x'.repeat(1024 * 1024 + 1) }),
    });
    expect(oversized[0].displayPost.kind).toBe('hidden_post');
    const valid = await hydrateCorpusItemsWithAppView({ items, timeoutMs: 1000,
      fetchFn: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ posts: [PUBLIC_POST] }) }),
    });
    expect(valid[0].reviewedCid).toBe(PUBLIC_POST.cid);
  });

  it('cancels an oversized streamed body and aborts its completed request scope', async () => {
    let canceled = false;
    let signal: AbortSignal | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); },
      cancel() { canceled = true; },
    });
    const result = await hydrateCorpusItemsWithAppView({ items: [corpusItem(PUBLIC_POST.uri as string)], timeoutMs: 1000,
      fetchFn: async (_url, init) => {
        signal = init.signal;
        return { ok: true, status: 200, body, text: async () => { throw new Error('Streaming transport must not buffer text'); } };
      },
    });
    expect(result[0].displayPost.kind).toBe('hidden_post');
    expect(canceled).toBe(true);
    expect(signal?.aborted).toBe(true);
  });

  it('shares one monotonic deadline across batches instead of multiplying the timeout', async () => {
    let elapsed = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const fetchFn = vi.fn(async (url: string) => {
      elapsed = 100;
      const posts = new URL(url).searchParams.getAll('uris').map((uri) => ({ ...PUBLIC_POST, uri }));
      return { ok: true, status: 200, text: async () => JSON.stringify({ posts }) };
    });
    try {
      const result = await hydrateCorpusItemsWithAppView({
        items: Array.from({ length: 26 }, (_, i) => corpusItem(`at://did:plc:author/app.bsky.feed.post/${i}`)),
        timeoutMs: 50, fetchFn,
      });
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(result[25].displayPost.kind).toBe('hidden_post');
    } finally { clock.mockRestore(); }
  });

  it('binds reviewed snapshot posts to their immutable record CIDs', async () => {
    const approved = { ...corpusItem(PUBLIC_POST.uri), reviewedCid: PUBLIC_POST.cid };
    const changedUri = 'at://did:plc:other/app.bsky.feed.post/changed';
    const changed = { ...corpusItem(changedUri), reviewedCid: 'bafy-reviewed-cid' };
    const withheldUri = 'at://did:plc:other/app.bsky.feed.post/withheld';
    const withheld = { ...corpusItem(withheldUri), reviewedCid: null };
    const hydrated = await hydrateCorpusItemsWithAppView({
      items: [approved, changed, withheld],
      timeoutMs: 1_000,
      fetchFn: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          posts: [
            PUBLIC_POST,
            { ...PUBLIC_POST, uri: changedUri, cid: 'bafy-edited-cid' },
            { ...PUBLIC_POST, uri: withheldUri, cid: 'bafy-current-cid' },
          ],
        }),
      }),
    });

    expect(hydrated[0].displayPost.kind).toBe('public_post');
    expect(hydrated[1].displayPost).toEqual({
      kind: 'hidden_post',
      reason: 'Post changed after the approved reviewer snapshot',
    });
    expect(hydrated[2].displayPost).toEqual({
      kind: 'hidden_post',
      reason: 'Post was withheld from the approved reviewer snapshot',
    });
    expect(JSON.stringify(hydrated.slice(1))).not.toContain('A public birding post');
    expect(JSON.stringify(hydrated.slice(1))).not.toContain('maya-keene');
  });

  it('withholds a failed AppView batch while preserving successful batches', async () => {
    const items = Array.from({ length: 26 }, (_, index) =>
      corpusItem(`at://did:plc:author/app.bsky.feed.post/post-${index}`)
    );
    let requestCount = 0;

    const hydrated = await hydrateCorpusItemsWithAppView({
      items,
      timeoutMs: 1_000,
      fetchFn: async (input) => {
        requestCount += 1;
        if (requestCount === 1) {
          return {
            ok: false,
            status: 503,
            text: async () => 'temporarily unavailable',
          };
        }
        const uri = new URL(input).searchParams.get('uris');
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            posts: [{ ...PUBLIC_POST, uri }],
          }),
        };
      },
    });

    expect(requestCount).toBe(2);
    expect(hydrated.slice(0, 25).every((item) => item.displayPost.kind === 'hidden_post')).toBe(true);
    expect(hydrated[25].displayPost.kind).toBe('public_post');
  });
});

function corpusItem(postUri: string) {
  return {
    postUri,
    authorDid: null,
    createdAt: '2026-07-09T12:00:00.000Z',
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
    scoredAt: '2026-07-09T12:00:00.000Z',
    componentDetails: null,
    inclusionReasons: {
      matchedTopics: [{ topic: 'science-research', score: 0.9 }],
      matchedTerms: ['research'],
    },
    displayPost: { kind: 'hidden_post' as const, reason: 'Not hydrated' },
  };
}
