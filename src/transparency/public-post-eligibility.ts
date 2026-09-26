import { z } from 'zod';
import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { publicPostVisibilityReason } from '../shared/public-post-visibility.js';

const PUBLIC_APPVIEW_ORIGIN = 'https://public.api.bsky.app';
const MAX_POSTS = 50;
const APPVIEW_BATCH_SIZE = 25;
const APPVIEW_TIMEOUT_MS = 1500;
const APPVIEW_MAX_RESPONSE_BYTES = 1024 * 1024;
const LOCAL_QUERY_TIMEOUT_MS = 1000;
const POST_URI_PATTERN = /^at:\/\/did:[a-z0-9]+:[A-Za-z0-9._:-]+\/app\.bsky\.feed\.post\/[A-Za-z0-9._~:@!$&'()*+,;=-]+$/;

export function isValidPublicPostUri(postUri: string): boolean {
  return POST_URI_PATTERN.test(postUri);
}

export interface PublicPostEligibilityTarget {
  readonly postUri: string;
  readonly requiresLocalPost: boolean;
}

export class PublicPostEligibilityError extends Error {
  constructor(message: string, options: ErrorOptions) {
    super(message, options);
    this.name = 'PublicPostEligibilityError';
  }
}

class TransientAppViewError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null, options: ErrorOptions) {
    super(message, options);
    this.name = 'TransientAppViewError';
    this.status = status;
  }
}

const LocalEligibilitySchema = z.object({
  uri: z.string(),
  has_live_post: z.boolean(),
  denied: z.boolean(),
}).strict();

async function readBoundedAppViewBody(response: Response): Promise<unknown> {
  if (response.body === null) {
    throw new PublicPostEligibilityError('AppView visibility response has no body', {});
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const chunks: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read().catch((error: unknown) => {
        throw new TransientAppViewError('AppView response transport failed', null, { cause: error });
      });
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > APPVIEW_MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new PublicPostEligibilityError('AppView visibility response exceeds byte limit', {});
      }
      chunks.push(decoder.decode(chunk.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return JSON.parse(chunks.join('')) as unknown;
  } finally {
    reader.releaseLock();
  }
}

async function readAppViewBatch(
  postUris: readonly string[],
  signal: AbortSignal
): Promise<Map<string, string>> {
  const url = new URL('/xrpc/app.bsky.feed.getPosts', PUBLIC_APPVIEW_ORIGIN);
  for (const postUri of postUris) url.searchParams.append('uris', postUri);
  const response = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'manual',
    signal,
  }).catch((error: unknown) => {
    throw new TransientAppViewError('AppView request transport failed', null, { cause: error });
  });
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 429 || (response.status >= 500 && response.status <= 599)) {
      throw new TransientAppViewError(`AppView visibility lookup failed with HTTP ${response.status}`, response.status, {});
    }
    throw new PublicPostEligibilityError(`AppView visibility lookup failed with HTTP ${response.status}`, {});
  }
  const parsed = z.object({ posts: z.array(z.unknown()).max(APPVIEW_BATCH_SIZE) })
    .passthrough().safeParse(await readBoundedAppViewBody(response));
  if (!parsed.success) {
    throw new PublicPostEligibilityError('AppView visibility response is malformed', {});
  }
  const expected = new Set(postUris);
  const seen = new Map<string, string>();
  for (const value of parsed.data.posts) {
    const post = z.object({ uri: z.string(), cid: z.string().trim().min(1) }).passthrough().safeParse(value);
    if (!post.success || !expected.has(post.data.uri) || seen.has(post.data.uri) ||
        publicPostVisibilityReason(value) !== null) {
      throw new PublicPostEligibilityError('AppView did not establish public visibility for the complete requested batch', {});
    }
    seen.set(post.data.uri, post.data.cid);
  }
  if (seen.size !== expected.size) {
    throw new PublicPostEligibilityError('AppView omitted a requested post from public view', {});
  }
  return seen;
}

async function assertAppViewBatchPublic(postUris: readonly string[]): Promise<Map<string, string>> {
  const controller = new AbortController();
  // Both physical attempts share one deadline; retry never doubles the time budget.
  const timeout = setTimeout(() => controller.abort(), APPVIEW_TIMEOUT_MS);
  try {
    try {
      return await readAppViewBatch(postUris, controller.signal);
    } catch (error) {
      if (!(error instanceof TransientAppViewError) || controller.signal.aborted) throw error;
      logger.warn(
        { attempt: 1, nextAttempt: 2, status: error.status, postCount: postUris.length },
        'Retrying transient public AppView visibility lookup failure'
      );
      return await readAppViewBatch(postUris, controller.signal);
    }
  } catch (error) {
    if (error instanceof PublicPostEligibilityError) throw error;
    throw new PublicPostEligibilityError('AppView public visibility could not be established', { cause: error });
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

/** Revalidate public disclosure; never reconstruct or change published ranking math. */
export async function assertPublicPostEligibility(
  targets: readonly PublicPostEligibilityTarget[]
): Promise<void> {
  if (targets.length === 0 || targets.length > MAX_POSTS ||
      targets.some((target) => !isValidPublicPostUri(target.postUri)) ||
      new Set(targets.map((target) => target.postUri)).size !== targets.length) {
    throw new PublicPostEligibilityError('Public eligibility requires one to fifty distinct valid post URIs', {});
  }
  const postUris = targets.map((target) => target.postUri);
  const batches: Promise<Map<string, string>>[] = [];
  for (let index = 0; index < postUris.length; index += APPVIEW_BATCH_SIZE) {
    batches.push(assertAppViewBatchPublic(postUris.slice(index, index + APPVIEW_BATCH_SIZE)));
  }
  // Settle both bounded requests before returning; no background visibility work survives denial.
  const batchResults = await Promise.allSettled(batches);
  const observedCids = new Map<string, string>();
  for (const result of batchResults) {
    if (result.status === 'rejected') throw result.reason;
    for (const [uri, cid] of result.value) observedCids.set(uri, cid);
  }
  const currentCids = postUris.map((uri) => {
    const cid = observedCids.get(uri);
    if (cid === undefined) throw new PublicPostEligibilityError('AppView omitted a requested CID', {});
    return cid;
  });

  try {
    // Observe retained local deletion and exact current AppView CID after remote validation.
    // Legacy ingestion ignores updates: a stale retained version must not establish disclosure.
    // This is a request-time visibility check, not historical score/version reconstruction.
    // query_timeout also causes pg-pool to discard an errored client; the existing pool
    // connection timeout bounds acquisition. No session setting is changed here.
    const query = {
      text: `WITH requested AS (
          SELECT * FROM unnest($1::TEXT[], $2::TEXT[]) AS target(uri, cid)
        ), local_counts AS (
          SELECT requested.uri, COUNT(*) AS row_count,
            COUNT(*) FILTER (WHERE p.deleted = FALSE AND p.cid = requested.cid)
              AS matching_live_count
          FROM requested
          JOIN posts p ON p.uri = requested.uri
          GROUP BY requested.uri, requested.cid
        ), current_state AS (
          SELECT requested.uri,
            (COALESCE(local.row_count, 0) > 0) AS has_local_state,
            (COALESCE(local.row_count, 0) = 1 AND
             COALESCE(local.matching_live_count, 0) = 1) AS eligible
          FROM requested
          LEFT JOIN local_counts local ON local.uri = requested.uri
        )
        SELECT uri, eligible AS has_live_post,
          (has_local_state AND NOT eligible) AS denied
        FROM current_state`,
      values: [postUris, currentCids],
      query_timeout: LOCAL_QUERY_TIMEOUT_MS,
    };
    const result = await db.query(query);
    const rows = z.array(LocalEligibilitySchema).max(MAX_POSTS).parse(result.rows);
    const byUri = new Map(rows.map((row) => [row.uri, row]));
    if (rows.length !== targets.length || byUri.size !== targets.length || targets.some((target) => {
      const state = byUri.get(target.postUri);
      return state === undefined || state.denied || (target.requiresLocalPost && !state.has_live_post);
    })) {
      throw new PublicPostEligibilityError('Current local post eligibility could not be established', {});
    }
  } catch (error) {
    if (error instanceof PublicPostEligibilityError) throw error;
    throw new PublicPostEligibilityError('Current local post eligibility lookup failed', { cause: error });
  }
}
