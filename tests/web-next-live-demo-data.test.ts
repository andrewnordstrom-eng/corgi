import { describe, expect, it, vi } from 'vitest';
import {
  bskyPostUrlFromAtUri,
  buildAppViewFeedUrl,
  buildPostHydrationUrl,
  CORGI_COMMUNITY_FEED_URI,
  fetchLiveDemoData,
  normalizeAppViewFeed,
  scoreComponentsFromExplanation,
  selectReceiptPost,
  topicBreakdownFromExplanation,
  LiveDemoDataError,
} from '../web-next/app/demo/live-demo-data';

type ExplanationFixture = Parameters<typeof scoreComponentsFromExplanation>[0];

const EXPLANATION_FIXTURE = {
  post_uri: 'at://did:plc:example123/app.bsky.feed.post/3abc',
  epoch_id: 2,
  total_score: 0.83,
  rank: 1,
  components: {
    recency: { raw_score: 0.8, weight: 0.25, weighted: 0.2 },
    engagement: { raw_score: 0.7, weight: 0.2, weighted: 0.14 },
    bridging: { raw_score: 0.6, weight: 0.1, weighted: 0.06 },
    source_diversity: { raw_score: 1, weight: 0.1, weighted: 0.1 },
    relevance: {
      raw_score: 0.8,
      weight: 0.35,
      weighted: 0.28,
      topicBreakdown: {
        'software-development': {
          postScore: 1,
          communityWeight: 0.8,
          contribution: 0.8,
        },
      },
    },
  },
  counterfactual: {
    pure_engagement_rank: 3,
    community_governed_rank: 1,
    difference: 2,
  },
  scored_at: '2026-07-07T07:44:21.844Z',
} satisfies ExplanationFixture;

describe('web-next live demo data helpers', () => {
  it('builds the public AppView getFeed URL for the Corgi feed', () => {
    const url = new URL(buildAppViewFeedUrl(CORGI_COMMUNITY_FEED_URI, 12));

    expect(url.origin).toBe('https://public.api.bsky.app');
    expect(url.pathname).toBe('/xrpc/app.bsky.feed.getFeed');
    expect(url.searchParams.get('feed')).toBe(CORGI_COMMUNITY_FEED_URI);
    expect(url.searchParams.get('limit')).toBe('12');
  });

  it('builds Bluesky source URLs from AT Protocol post URIs', () => {
    expect(bskyPostUrlFromAtUri('at://did:plc:example123/app.bsky.feed.post/3abc')).toBe(
      'https://bsky.app/profile/did:plc:example123/post/3abc',
    );
  });

  it('rejects non-post AT Protocol URIs', () => {
    expect(() => bskyPostUrlFromAtUri('at://did:plc:example123/app.bsky.feed.generator/demo')).toThrow(
      LiveDemoDataError,
    );
  });

  it('rejects malformed AT Protocol post URI input', () => {
    expect(() => bskyPostUrlFromAtUri('not-an-at-uri')).toThrow(LiveDemoDataError);
    expect(() => bskyPostUrlFromAtUri('')).toThrow(LiveDemoDataError);
  });

  it('hydrates multiple feed skeleton URIs with repeated AppView params', () => {
    const url = new URL(
      buildPostHydrationUrl([
        'at://did:plc:first/app.bsky.feed.post/3one',
        'at://did:plc:second/app.bsky.feed.post/3two',
      ]),
    );

    expect(url.origin).toBe('https://public.api.bsky.app');
    expect(url.pathname).toBe('/xrpc/app.bsky.feed.getPosts');
    expect(url.searchParams.getAll('uris')).toEqual([
      'at://did:plc:first/app.bsky.feed.post/3one',
      'at://did:plc:second/app.bsky.feed.post/3two',
    ]);
  });

  it('builds an AppView hydration URL with no URI params for an empty feed', () => {
    const url = new URL(buildPostHydrationUrl([]));

    expect(url.origin).toBe('https://public.api.bsky.app');
    expect(url.pathname).toBe('/xrpc/app.bsky.feed.getPosts');
    expect(url.searchParams.getAll('uris')).toEqual([]);
  });

  it('normalizes AppView feed items without exposing hidden post text or identity', () => {
    const normalized = normalizeAppViewFeed({
      cursor: 'cursor-1',
      feed: [
        {
          post: {
            uri: 'at://did:plc:public/app.bsky.feed.post/3one',
            author: {
              did: 'did:plc:public',
              handle: 'public-user.bsky.social',
              displayName: 'Public User',
              avatar: 'https://cdn.example/avatar.jpg',
            },
            record: { text: 'Visible public post.' },
            indexedAt: '2026-07-09T12:00:00.000Z',
            likeCount: 10,
            repostCount: 3,
            replyCount: 2,
            quoteCount: 1,
          },
        },
        {
          post: {
            uri: 'at://did:plc:hidden/app.bsky.feed.post/3two',
            author: {
              did: 'did:plc:hidden',
              handle: 'hidden-user.bsky.social',
              displayName: 'Hidden User',
              labels: [{ val: '  !HiDe  ' }],
            },
            record: { text: 'This text must not render.' },
          },
        },
        {
          post: {
            uri: 'at://did:plc:adult/app.bsky.feed.post/3three',
            author: {
              did: 'did:plc:adult',
              handle: 'adult-user.bsky.social',
              displayName: 'Adult User',
            },
            labels: [{ val: 'porn' }],
            record: { text: 'This adult-labeled text must not render.' },
          },
        },
      ],
    });

    expect(normalized.cursor).toBe('cursor-1');
    expect(normalized.posts[0]).toMatchObject({
      visibility: 'public',
      rank: 1,
      authorHandle: 'public-user.bsky.social',
      text: 'Visible public post.',
      likeCount: 10,
    });
    expect(normalized.posts[1]).toMatchObject({
      visibility: 'hidden',
      rank: 2,
      uri: null,
      authorHandle: null,
      text: null,
      hiddenReason: 'Post hidden by Bluesky public-view policy',
    });
    expect(normalized.posts[2]).toMatchObject({
      visibility: 'hidden',
      rank: 3,
      uri: null,
      authorHandle: null,
      text: null,
      hiddenReason: 'Post hidden by Bluesky public-view policy',
    });
  });

  it('keeps unavailable or invalid AppView posts as hidden placeholders', () => {
    const normalized = normalizeAppViewFeed({
      feed: [
        { post: null },
        {
          post: {
            uri: 'at://did:plc:missing-text/app.bsky.feed.post/3four',
            author: { did: 'did:plc:missing-text', handle: 'missing-text.example' },
            record: {},
          },
        },
        {
          post: {
            uri: 'at://did:plc:bad-label/app.bsky.feed.post/3five',
            author: { did: 'did:plc:bad-label', handle: 'bad-label.example' },
            record: { text: 'Must remain hidden.' },
            labels: [{ val: 5 }],
          },
        },
        {
          post: {
            uri: 'at://did:plc:empty-label/app.bsky.feed.post/3six',
            author: { did: 'did:plc:empty-label', handle: 'empty-label.example' },
            record: { text: 'An empty label does not hide valid text.' },
            labels: [{ val: '' }],
          },
        },
      ],
    } as never);

    expect(normalized.posts.slice(0, 3).map((post) => post.visibility)).toEqual([
      'hidden', 'hidden', 'hidden',
    ]);
    expect(normalized.posts[0]).toMatchObject({
      text: null,
      hiddenReason: 'Post unavailable from Bluesky public view',
    });
    expect(normalized.posts[1]).toMatchObject({
      text: null,
      hiddenReason: 'Post unavailable from Bluesky public view',
    });
    expect(normalized.posts[2]).toMatchObject({
      text: null,
      hiddenReason: 'Post visibility labels are invalid',
    });
    expect(normalized.posts[3]).toMatchObject({ visibility: 'public' });
  });

  it('rejects malformed feed item shapes and keeps invalid post values as placeholders', () => {
    expect(() => normalizeAppViewFeed(null as never)).toThrow(LiveDemoDataError);
    expect(() => normalizeAppViewFeed({ feed: [null] } as never)).toThrow(LiveDemoDataError);
    expect(normalizeAppViewFeed({ feed: [{ post: 'not-an-object' }] } as never).posts[0]).toMatchObject({
      visibility: 'hidden',
      text: null,
      hiddenReason: 'Post unavailable from Bluesky public view',
    });
  });

  it('selects no receipt post when every AppView row is hidden', () => {
    const normalized = normalizeAppViewFeed({
      feed: [{
        post: {
          uri: 'at://did:plc:hidden/app.bsky.feed.post/3zero',
          author: { did: 'did:plc:hidden', handle: 'hidden.bsky.social', labels: [{ val: '!no-unauthenticated' }] },
          record: { text: 'Withheld text.' },
        },
      }],
    });

    expect(selectReceiptPost(normalized.posts)).toBeNull();
  });

  it('does not expose upstream error bodies in public demo errors', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('token=super-secret-and-stack-trace', {
        status: 500,
        statusText: 'Internal Server Error',
      }),
    );

    try {
      const result = await fetchLiveDemoData(new AbortController().signal);

      expect(result.errors).toHaveLength(3);
      expect(result.errors.join(' ')).toContain('HTTP 500');
      expect(result.errors.join(' ')).not.toContain('super-secret');
      expect(result.errors.join(' ')).not.toContain('stack-trace');
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('selects a public receipt post by visible feed position after hidden rows', () => {
    const normalized = normalizeAppViewFeed({
      feed: [
        {
          post: {
            uri: 'at://did:plc:hidden/app.bsky.feed.post/3one',
            author: {
              did: 'did:plc:hidden',
              handle: 'hidden-user.bsky.social',
              labels: [{ val: '!no-unauthenticated' }],
            },
            record: { text: 'Hidden text.' },
          },
        },
        {
          post: {
            uri: 'at://did:plc:visible/app.bsky.feed.post/3two',
            author: {
              did: 'did:plc:visible',
              handle: 'visible-user.bsky.social',
              displayName: 'Visible User',
            },
            record: { text: 'Explain this public post.' },
          },
        },
      ],
    });

    const receiptPost = selectReceiptPost(normalized.posts);

    expect(receiptPost?.rank).toBe(2);
    expect(receiptPost?.uri).toBe('at://did:plc:visible/app.bsky.feed.post/3two');
  });

  it('normalizes live explanation components in display order', () => {
    const components = scoreComponentsFromExplanation(EXPLANATION_FIXTURE);

    expect(components.map((component) => component.key)).toEqual([
      'recency',
      'engagement',
      'bridging',
      'source_diversity',
      'relevance',
    ]);
    expect(components[4]?.weighted).toBe(0.28);
  });

  it('fails explicitly when a required live explanation component is missing', () => {
    const { relevance: _relevance, ...componentsWithoutRelevance } = EXPLANATION_FIXTURE.components;

    expect(() =>
      scoreComponentsFromExplanation({
        ...EXPLANATION_FIXTURE,
        components: componentsWithoutRelevance,
      }),
    ).toThrow(LiveDemoDataError);
  });

  it('fails explicitly when live explanation component fields are non-finite', () => {
    expect(() =>
      scoreComponentsFromExplanation({
        ...EXPLANATION_FIXTURE,
        components: {
          ...EXPLANATION_FIXTURE.components,
          recency: {
            ...EXPLANATION_FIXTURE.components.recency,
            raw_score: Number.NaN,
          },
        },
      }),
    ).toThrow(LiveDemoDataError);

    expect(() =>
      scoreComponentsFromExplanation({
        ...EXPLANATION_FIXTURE,
        components: {
          ...EXPLANATION_FIXTURE.components,
          relevance: {
            ...EXPLANATION_FIXTURE.components.relevance,
            weighted: Number.POSITIVE_INFINITY,
          },
        },
      }),
    ).toThrow(LiveDemoDataError);
  });

  it('normalizes live relevance topic breakdowns', () => {
    expect(topicBreakdownFromExplanation(EXPLANATION_FIXTURE)).toEqual([
      {
        slug: 'software-development',
        name: 'Software Development',
        postScore: 1,
        communityWeight: 0.8,
        contribution: 0.8,
      },
    ]);
  });

  it('returns an empty topic list when relevance topic breakdown is absent or empty', () => {
    expect(
      topicBreakdownFromExplanation({
        ...EXPLANATION_FIXTURE,
        components: {
          ...EXPLANATION_FIXTURE.components,
          relevance: {
            raw_score: 0.8,
            weight: 0.35,
            weighted: 0.28,
          },
        },
      }),
    ).toEqual([]);

    expect(
      topicBreakdownFromExplanation({
        ...EXPLANATION_FIXTURE,
        components: {
          ...EXPLANATION_FIXTURE.components,
          relevance: {
            raw_score: 0.8,
            weight: 0.35,
            weighted: 0.28,
            topicBreakdown: {},
          },
        },
      }),
    ).toEqual([]);
  });
});
