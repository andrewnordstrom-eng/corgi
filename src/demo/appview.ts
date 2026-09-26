import { z } from 'zod';
import { logger } from '../lib/logger.js';
import { AppViewPostSchema, publicPostFromAppView, type AppViewPost } from './public-view.js';
import type { ShadowDemoCorpusItem } from './types.js';

export const APPVIEW_GET_POSTS_MAX_URIS = 25;
const APPVIEW_PUBLIC_ORIGIN = 'https://public.api.bsky.app';
const APPVIEW_MAX_RESPONSE_BYTES = 1024 * 1024;
const APPVIEW_MAX_ITEMS = 100;
const APPVIEW_GET_POSTS_PATH = '/xrpc/app.bsky.feed.getPosts';

export interface FetchRequestInit {
  method: 'GET';
  signal: AbortSignal;
  credentials?: 'omit';
  cache?: 'no-store';
  redirect?: 'manual';
}

export type DemoFetchFunction = (input: string, init: FetchRequestInit) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  body?: ReadableStream<Uint8Array> | null;
}>;

class AppViewHttpError extends Error {
  constructor(readonly status: number) {
    super(`Bluesky AppView getPosts failed with HTTP ${status}`);
    this.name = 'AppViewHttpError';
  }
}

const AppViewGetPostsResponseSchema = z.object({
  posts: z.array(z.unknown()).optional(),
}).passthrough();

export function buildAppViewGetPostsUrl(uris: string[]): string {
  const url = new URL(APPVIEW_GET_POSTS_PATH, APPVIEW_PUBLIC_ORIGIN);
  for (const uri of uris) {
    url.searchParams.append('uris', uri);
  }
  return url.toString();
}

export async function hydrateCorpusItemsWithAppView(options: {
  items: ShadowDemoCorpusItem[];
  fetchFn: DemoFetchFunction;
  timeoutMs: number;
}): Promise<ShadowDemoCorpusItem[]> {
  if (options.items.length > APPVIEW_MAX_ITEMS || new Set(options.items.map((item) => item.postUri)).size !== options.items.length) {
    throw new Error('Demo AppView hydration requires at most 100 distinct post URIs');
  }
  const deadline = performance.now() + options.timeoutMs;
  const byUri = new Map<string, AppViewPost>();
  for (let index = 0; index < options.items.length; index += APPVIEW_GET_POSTS_MAX_URIS) {
    if (performance.now() >= deadline) break;
    const batch = options.items.slice(index, index + APPVIEW_GET_POSTS_MAX_URIS);
    let response: AppViewPost[];
    try {
      response = await fetchAppViewPosts({
        uris: batch.map((item) => item.postUri),
        fetchFn: options.fetchFn,
        timeoutMs: Math.max(1, deadline - performance.now()),
      });
    } catch (err) {
      logger.warn(
        { errorKind: err instanceof Error ? err.name : 'unknown', status: err instanceof AppViewHttpError ? err.status : null, batchStart: index, batchSize: batch.length },
        'Shadow demo AppView batch failed; withholding only that batch'
      );
      continue;
    }
    for (const post of response) {
      if (typeof post.uri === 'string') {
        byUri.set(post.uri, post);
      }
    }
  }

  return options.items.map((item) => {
    const post = byUri.get(item.postUri) ?? null;
    if (!post) {
      return {
        ...item,
        displayPost: {
          kind: 'hidden_post',
          reason: 'Post unavailable from Bluesky public AppView',
        },
      };
    }
    if (item.reviewedCid === null) {
      return {
        ...item,
        displayPost: {
          kind: 'hidden_post',
          reason: 'Post was withheld from the approved reviewer snapshot',
        },
      };
    }
    if (item.reviewedCid !== undefined && post.cid !== item.reviewedCid) {
      return {
        ...item,
        displayPost: {
          kind: 'hidden_post',
          reason: 'Post changed after the approved reviewer snapshot',
        },
      };
    }
    const displayPost = publicPostFromAppView(post);
    return {
      ...item,
      reviewedCid: item.reviewedCid === undefined && displayPost.kind === 'public_post' ? displayPost.cid : item.reviewedCid,
      displayPost,
    };
  });
}

async function fetchAppViewPosts(options: {
  uris: string[];
  fetchFn: DemoFetchFunction;
  timeoutMs: number;
}): Promise<AppViewPost[]> {
  if (options.uris.length > APPVIEW_GET_POSTS_MAX_URIS) {
    throw new Error(`app.bsky.feed.getPosts accepts at most ${APPVIEW_GET_POSTS_MAX_URIS} URIs`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await options.fetchFn(buildAppViewGetPostsUrl(options.uris), {
      method: 'GET',
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'manual',
    });
    const body = await readBoundedAppViewBody(response);
    if (!response.ok) {
      throw new AppViewHttpError(response.status);
    }
    let json: unknown;
    try {
      json = JSON.parse(body) as unknown;
    } catch {
      throw new Error('Bluesky AppView getPosts returned malformed JSON');
    }
    const parsed = AppViewGetPostsResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(
        `Bluesky AppView getPosts returned an invalid payload: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; ')}`
      );
    }
    const posts = parsed.data.posts ?? [];
    if (posts.length > APPVIEW_GET_POSTS_MAX_URIS) throw new Error('AppView returned too many posts');
    const requested = new Set(options.uris);
    const seen = new Set<string>();
    for (const candidate of posts) {
      const identity = z.object({ uri: z.string() }).passthrough().safeParse(candidate);
      if (!identity.success || !requested.has(identity.data.uri) || seen.has(identity.data.uri)) {
        throw new Error('AppView returned duplicate, unrequested or missing post identity');
      }
      seen.add(identity.data.uri);
    }
    return posts.flatMap((candidate) => {
      const post = AppViewPostSchema.safeParse(candidate);
      return post.success ? [post.data] : [];
    });
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

async function readBoundedAppViewBody(response: Awaited<ReturnType<DemoFetchFunction>>): Promise<string> {
  if (response.body === undefined) {
    // Injected fixture transports may provide text only; production fetch exposes a stream.
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > APPVIEW_MAX_RESPONSE_BYTES) throw new Error('AppView response exceeds byte limit');
    return text;
  }
  if (response.body === null) throw new Error('AppView response has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  const chunks: string[] = [];
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > APPVIEW_MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('AppView response exceeds byte limit');
      }
      chunks.push(decoder.decode(chunk.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } finally {
    reader.releaseLock();
  }
}
