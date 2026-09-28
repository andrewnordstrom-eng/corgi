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
const POLICY_WITHHOLD_REASONS = new Set([
  'Post hidden by Bluesky public-view policy',
  'Post contains an unavailable embedded record',
]);

function assertWellFormedPublicPost(value: unknown, uri: string): void {
  const envelope = z.object({
    uri: z.string(),
    cid: z.string().trim().min(1),
    author: z.object({ did: z.string().min(1), handle: z.string().min(1) }).passthrough(),
    record: z.object({ text: z.string().min(1) }).passthrough(),
  }).passthrough().safeParse(value);
  const authority = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\//.exec(uri)?.[1];
  if (!envelope.success || envelope.data.uri !== uri || authority !== envelope.data.author.did) {
    throw new PublicPostEligibilityError('AppView returned a malformed post for a requested URI', {});
  }
  const pending: unknown[] = [value];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    visited += 1;
    if (visited > 512) throw new PublicPostEligibilityError('AppView visibility metadata exceeds validation bounds', {});
    if (Array.isArray(current)) {
      pending.push(...current);
    } else if (typeof current === 'object' && current !== null) {
      const node = current as Record<string, unknown>;
      if ('labels' in node) {
        const labels = Array.isArray(node.labels)
          ? node.labels
          : typeof node.labels === 'object' && node.labels !== null && !Array.isArray(node.labels) && Array.isArray((node.labels as { values?: unknown }).values)
            ? (node.labels as { values: unknown[] }).values
            : null;
        if (labels === null || labels.some((label) => typeof label !== 'object' || label === null || typeof (label as { val?: unknown }).val !== 'string')) {
          throw new PublicPostEligibilityError('AppView visibility labels are malformed', {});
        }
      }
      pending.push(...Object.values(node).filter((nested) => typeof nested === 'object' && nested !== null));
    }
  }
}

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

export class PublicPostEligibilityDeniedError extends PublicPostEligibilityError {
  constructor() {
    super('Current public post eligibility was denied', {});
    this.name = 'PublicPostEligibilityDeniedError';
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
    const identity = z.object({ uri: z.string().min(1) }).passthrough().safeParse(value);
    if (!identity.success || !expected.has(identity.data.uri) || seen.has(identity.data.uri)) {
      throw new PublicPostEligibilityError('AppView did not establish public visibility for the complete requested batch', {});
    }
    seen.set(identity.data.uri, '');
    assertWellFormedPublicPost(value, identity.data.uri);
    const post = value as { uri: string; cid: string };
    const reason = publicPostVisibilityReason(value);
    if (reason !== null) {
      if (!POLICY_WITHHOLD_REASONS.has(reason)) {
        throw new PublicPostEligibilityError('AppView visibility could not be safely classified', {});
      }
      continue;
    }
    seen.set(post.uri, post.cid);
  }
  return new Map([...seen].filter(([, cid]) => cid.length > 0));
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

/** Return only per-post public eligibility; infrastructure uncertainty rejects the whole check. */
export async function readPublicPostEligibility(
  targets: readonly PublicPostEligibilityTarget[]
): Promise<ReadonlyMap<string, boolean>> {
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
  const localTargets = targets.filter((target) => observedCids.has(target.postUri));
  const decisions = new Map(targets.map((target) => [target.postUri, false]));
  if (localTargets.length === 0) return decisions;
  const localPostUris = localTargets.map((target) => target.postUri);
  const currentCids = localPostUris.map((uri) => {
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
      values: [localPostUris, currentCids],
      query_timeout: LOCAL_QUERY_TIMEOUT_MS,
    };
    const queryResult = await db.query(query);
    const rows = z.array(LocalEligibilitySchema).max(MAX_POSTS).parse(queryResult.rows);
    const byUri = new Map(rows.map((row) => [row.uri, row]));
    if (rows.length !== localTargets.length || byUri.size !== localTargets.length || localTargets.some((target) => !byUri.has(target.postUri))) {
      throw new PublicPostEligibilityError('Current local post eligibility could not be established', {});
    }
    for (const target of localTargets) {
      const state = byUri.get(target.postUri);
      if (state === undefined) throw new PublicPostEligibilityError('Current local post eligibility could not be established', {});
      decisions.set(target.postUri, !state.denied && (!target.requiresLocalPost || state.has_live_post));
    }
    return decisions;
  } catch (error) {
    if (error instanceof PublicPostEligibilityError) throw error;
    throw new PublicPostEligibilityError('Current local post eligibility lookup failed', { cause: error });
  }
}

/** Strict receipt callers must have confirmed eligibility for the requested post. */
export async function assertPublicPostEligibility(
  targets: readonly PublicPostEligibilityTarget[]
): Promise<void> {
  const decisions = await readPublicPostEligibility(targets);
  if (targets.some((target) => decisions.get(target.postUri) !== true)) {
    throw new PublicPostEligibilityDeniedError();
  }
}
