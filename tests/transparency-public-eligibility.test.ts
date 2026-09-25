import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { dbQueryMock, warningMock } = vi.hoisted(() => ({ dbQueryMock: vi.fn(), warningMock: vi.fn() }));
vi.mock('../src/lib/logger.js', () => ({ logger: { warn: warningMock } }));
vi.mock('../src/db/client.js', () => ({ db: { query: dbQueryMock } }));

import {
  assertPublicPostEligibility,
  PublicPostEligibilityError,
} from '../src/transparency/public-post-eligibility.js';
import { publicPostVisibilityReason } from '../src/shared/public-post-visibility.js';

function postUri(index: number): string {
  return `at://did:plc:eligibility/app.bsky.feed.post/${index}`;
}
function visiblePost(uri: string): Record<string, unknown> {
  return { uri, cid: 'synthetic-cid', author: { did: 'did:plc:eligibility', handle: 'synthetic.test' }, record: { text: 'Public synthetic fixture' } };
}
function visibleResponse(input: string | URL | Request): Response {
  const url = new URL(String(input));
  return Response.json({ posts: url.searchParams.getAll('uris').map(visiblePost) });
}
function localRows(uris: readonly string[]): Array<{ uri: string; has_live_post: boolean; denied: boolean }> {
  return uris.map((uri) => ({ uri, has_live_post: true, denied: false }));
}

describe('public disclosure eligibility', () => {
  beforeEach(() => {
    warningMock.mockReset();
    dbQueryMock.mockReset().mockImplementation((query: { values: string[][] }) =>
      Promise.resolve({ rows: localRows(query.values[0]) }));
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string | URL | Request) => Promise.resolve(visibleResponse(input))));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('uses at most two anonymous bounded batches and one final SQL query for50 URIs', async () => {
    const uris = Array.from({ length: 50 }, (_value, index) => postUri(index));
    const order: string[] = [];
    const fetchMock = vi.fn().mockImplementation((input: string | URL | Request) => {
      order.push('remote');
      return Promise.resolve(visibleResponse(input));
    });
    vi.stubGlobal('fetch', fetchMock);
    dbQueryMock.mockImplementation((query: { values: string[][] }) => {
      order.push('local');
      return Promise.resolve({ rows: localRows(query.values[0]).reverse() });
    });
    await assertPublicPostEligibility(uris.map((uri) => ({ postUri: uri, requiresLocalPost: true })));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [input, options] of fetchMock.mock.calls) {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://public.api.bsky.app');
      expect(url.pathname).toBe('/xrpc/app.bsky.feed.getPosts');
      expect(url.searchParams.getAll('uris')).toHaveLength(25);
      expect(options).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'manual', cache: 'no-store', headers: { Accept: 'application/json' } });
    }
    expect(dbQueryMock).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['remote', 'remote', 'local']);
    expect(dbQueryMock.mock.calls[0][0]).toMatchObject({ values: [uris, uris.map(() => 'synthetic-cid')], query_timeout: 1000 });
  });

  it.each(['missing', 'missing-cid', 'empty-cid', 'duplicate', 'unexpected', 'hidden-author', 'author-identity-mismatch', 'hidden-post', 'hidden-embed', 'malformed-record', 'malformed-json', 'failed-request', 'oversized'])('fails closed for%s remote result before SQL', async (kind) => {
    const uri = postUri(1);
    const post = visiblePost(uri);
    let response: Response;
    if (kind === 'missing') response = Response.json({ posts: [] });
    else if (kind === 'missing-cid') response = Response.json({ posts: [{ ...post, cid: undefined }] });
    else if (kind === 'empty-cid') response = Response.json({ posts: [{ ...post, cid: ' ' }] });
    else if (kind === 'duplicate') response = Response.json({ posts: [post, post] });
    else if (kind === 'unexpected') response = Response.json({ posts: [visiblePost(postUri(2))] });
    else if (kind === 'hidden-author') response = Response.json({ posts: [{ ...post, author: { did: 'did:plc:eligibility', handle: 'synthetic.test', labels: [{ val: '!no-unauthenticated' }] } }] });
    else if (kind === 'author-identity-mismatch') response = Response.json({ posts: [{ ...post, author: { did: 'did:plc:other', handle: 'other.test' } }] });
    else if (kind === 'hidden-post') response = Response.json({ posts: [{ ...post, labels: [{ val: '!hide' }] }] });
    else if (kind === 'hidden-embed') response = Response.json({ posts: [{ ...post, embed: { record: { labels: [{ val: '!takedown' }] } } }] });
    else if (kind === 'malformed-record') response = Response.json({ posts: [{ ...post, record: null }] });
    else if (kind === 'malformed-json') response = new Response('{bad');
    else if (kind === 'failed-request') response = new Response('unavailable', { status: 503 });
    else response = new Response('x'.repeat(1024 * 1024 + 1));
    const body = await response.text();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response(body, { status: response.status }))));
    await expect(assertPublicPostEligibility([{ postUri: uri, requiresLocalPost: true }])).rejects.toBeInstanceOf(PublicPostEligibilityError);
    expect(dbQueryMock).not.toHaveBeenCalled();
  });

  it('retries transient errors once within the same deadline and emits only redacted diagnostics', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('Synthetic network loss')).mockImplementation((input: string | URL | Request) => Promise.resolve(visibleResponse(input)));
    vi.stubGlobal('fetch', fetchMock);
    await assertPublicPostEligibility([{ postUri: postUri(1), requiresLocalPost: true }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].signal).toBe(fetchMock.mock.calls[1][1].signal);
    expect(warningMock).toHaveBeenCalledWith({ attempt: 1, nextAttempt: 2, status: null, postCount: 1 }, expect.any(String));
    expect(JSON.stringify(warningMock.mock.calls)).not.toContain(postUri(1));
  });

  it('never follows or retries redirects and never retries policy denial', async () => {
    for (const response of [new Response(null, { status: 302, headers: { Location: 'https://attacker.invalid' } }), Response.json({ posts: [] })]) {
      const fetchMock = vi.fn().mockResolvedValue(response);
      vi.stubGlobal('fetch', fetchMock);
      await expect(assertPublicPostEligibility([{ postUri: postUri(1), requiresLocalPost: true }])).rejects.toBeInstanceOf(PublicPostEligibilityError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
    expect(warningMock).not.toHaveBeenCalled();
  });

  it('aborts a stalled request and never treats timeout as permission', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_input: unknown, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new TypeError('Synthetic abort')));
    })));
    const pending = expect(assertPublicPostEligibility([{ postUri: postUri(1), requiresLocalPost: true }])).rejects.toBeInstanceOf(PublicPostEligibilityError);
    await vi.advanceTimersByTimeAsync(1500);
    await pending;
    expect(dbQueryMock).not.toHaveBeenCalled();
  });

  it.each(['denied', 'missing', 'duplicate', 'unknown', 'db-error'])('fails closed for%s local state', async (kind) => {
    const uri = postUri(1);
    if (kind === 'db-error') dbQueryMock.mockRejectedValue(new TypeError('Synthetic database unavailable'));
    else {
      const rows = kind === 'denied' ? [{ uri, has_live_post: true, denied: true }]
        : kind === 'missing' ? []
          : kind === 'duplicate' ? [...localRows([uri]), ...localRows([uri])]
            : [{ uri, has_live_post: false, denied: false }];
      dbQueryMock.mockResolvedValue({ rows });
    }
    await expect(assertPublicPostEligibility([{ postUri: uri, requiresLocalPost: true }])).rejects.toBeInstanceOf(PublicPostEligibilityError);
  });

  it('allows an externally visible unscored pin without local state but never a local tombstone', async () => {
    const uri = postUri(1);
    dbQueryMock.mockResolvedValue({ rows: [{ uri, has_live_post: false, denied: false }] });
    await expect(assertPublicPostEligibility([{ postUri: uri, requiresLocalPost: false }])).resolves.toBeUndefined();
    dbQueryMock.mockResolvedValue({ rows: [{ uri, has_live_post: false, denied: true }] });
    await expect(assertPublicPostEligibility([{ postUri: uri, requiresLocalPost: false }])).rejects.toBeInstanceOf(PublicPostEligibilityError);
  });

  it('rejects invalid and duplicate targets before either dependency', async () => {
    for (const targets of [[], [{ postUri: 'https://attacker.invalid', requiresLocalPost: true }], [{ postUri: postUri(1), requiresLocalPost: true }, { postUri: postUri(1), requiresLocalPost: false }]]) {
      await expect(assertPublicPostEligibility(targets)).rejects.toBeInstanceOf(PublicPostEligibilityError);
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(dbQueryMock).not.toHaveBeenCalled();
  });

  it('uses one shared public policy for normalized labels and nested blocked records', () => {
    expect(publicPostVisibilityReason(visiblePost(postUri(1)))).toBeNull();
    for (const label of ['!warn', '!no-unauthenticated', '!hide', '!takedown', 'porn', 'sexual', 'nudity', 'graphic-media', 'gore', 'self-harm', 'sexual-figurative']) {
      expect(publicPostVisibilityReason({ ...visiblePost(postUri(1)), labels: [{ val: ` ${label.toUpperCase()} ` }] })).not.toBeNull();
    }
    expect(publicPostVisibilityReason({ ...visiblePost(postUri(1)), embed: { record: { $type: 'app.bsky.embed.record#viewBlocked' } } })).not.toBeNull();
  });
});
