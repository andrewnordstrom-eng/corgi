import { z } from "zod"
import { publicPostVisibilityReason } from "../../src/shared/public-post-visibility"
import {
  BLUESKY_APPVIEW_MAX_POST_URIS,
  bskyPostUrlFromAtUri,
  buildPostHydrationUrl,
} from "@/lib/bluesky-public"
import { SIGNAL_KEYS, SIGNAL_LABELS } from "@/lib/signals"
import type { SignalKey } from "@/lib/signals"

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? ""

export const PUBLIC_FEED_LIMIT = 50
export const APPVIEW_BATCH_SIZE = BLUESKY_APPVIEW_MAX_POST_URIS
export const PUBLIC_FEED_POLL_INTERVAL_MS = 5 * 60 * 1_000
export const PUBLIC_FEED_MAX_REQUESTS_PER_REFRESH = 3
export const PUBLIC_FEED_SNAPSHOT_TIMEOUT_MS = 12_000
export const PUBLIC_FEED_APPVIEW_TIMEOUT_MS = 12_000

const scoreComponentSchema = z.object({
  raw_score: z.number().finite(),
  weight: z.number().finite(),
  weighted: z.number().finite(),
}).strict()

const scoreComponentsSchema = z.object({
  recency: scoreComponentSchema,
  engagement: scoreComponentSchema,
  bridging: scoreComponentSchema,
  source_diversity: scoreComponentSchema,
  relevance: scoreComponentSchema,
}).strict()

const rankedItemSchema = z.object({
  position: z.number().int().positive(),
  epoch_id: z.number().int().positive(),
  ranked_position: z.number().int().positive(),
  placement: z.literal("ranked"),
  post_uri: z.string().min(1),
  base_score: z.number().finite(),
  publication_adjustment: z.number().finite(),
  final_score: z.number().finite(),
  components: scoreComponentsSchema,
  source_score_run_id: z.string().min(1),
  scored_at: z.string().datetime(),
  classification_method: z.enum(["keyword", "embedding"]),
  engagement_only_position: z.number().int().positive(),
}).strict()

const pinnedItemSchema = z.object({
  position: z.number().int().positive(),
  epoch_id: z.null(),
  ranked_position: z.null(),
  placement: z.literal("pinned_announcement"),
  post_uri: z.string().min(1),
  base_score: z.null(),
  publication_adjustment: z.null(),
  final_score: z.null(),
  components: z.null(),
  source_score_run_id: z.null(),
  scored_at: z.null(),
  classification_method: z.null(),
  engagement_only_position: z.null(),
}).strict()

const scoredPinnedItemSchema = rankedItemSchema.extend({
  placement: z.literal("pinned_announcement"),
}).strict()

const withheldItemSchema = z.object({
  position: z.number().int().positive(),
  placement: z.literal("withheld"),
  reason: z.literal("Post withheld from the public view"),
}).strict()

export const publicFeedSnapshotSchema = z.object({
  schema_version: z.literal(1),
  feed_uri: z.string().min(1),
  presentation_snapshot_id: z.string().min(1),
  publication_run_id: z.string().min(1),
  epoch_id: z.number().int().positive(),
  published_at: z.string().datetime(),
  status: z.enum(["current", "last_known_good"]),
  total_published_items: z.number().int().nonnegative(),
  expected_refresh_seconds: z.number().int().positive(),
  active_weights: z.object({
    recency: z.number().finite(),
    engagement: z.number().finite(),
    bridging: z.number().finite(),
    source_diversity: z.number().finite(),
    relevance: z.number().finite(),
  }).strict(),
  items: z.array(z.union([rankedItemSchema, pinnedItemSchema, scoredPinnedItemSchema, withheldItemSchema])).max(PUBLIC_FEED_LIMIT),
}).strict()

export type PublicFeedSnapshot = z.infer<typeof publicFeedSnapshotSchema>
export type PublicFeedItem = PublicFeedSnapshot["items"][number]
export type PublicFeedWithheldItem = z.infer<typeof withheldItemSchema>
export type PublicFeedVisibleItem = Exclude<PublicFeedItem, PublicFeedWithheldItem>
export type PublicFeedRankedItem = Extract<PublicFeedVisibleItem, { readonly placement: "ranked" }>
export type PublicFeedScoredItem = Extract<PublicFeedItem, { readonly final_score: number }>
export type PublicFeedScoreComponent = z.infer<typeof scoreComponentSchema>

const appViewLabelSchema = z.object({ val: z.string().min(1) }).passthrough()
const POLICY_WITHHOLD_REASONS = new Set([
  "Post hidden by Bluesky public-view policy",
  "Post contains an unavailable embedded record",
])
const appViewPostSchema = z.object({
  uri: z.string().min(1),
  author: z.object({
    did: z.string().min(1),
    handle: z.string().min(1),
    displayName: z.string().optional(),
    avatar: z.string().url().optional(),
    labels: z.array(appViewLabelSchema).optional(),
  }).passthrough(),
  record: z.object({
    text: z.string(),
    langs: z.array(z.string().min(1)).optional(),
  }).passthrough(),
  labels: z.array(appViewLabelSchema).optional(),
  indexedAt: z.string().optional(),
  likeCount: z.number().int().nonnegative().optional(),
  repostCount: z.number().int().nonnegative().optional(),
  replyCount: z.number().int().nonnegative().optional(),
}).passthrough()

function validateAppViewVisibilityShape(value: unknown): void {
  const pending: unknown[] = [value]
  let visited = 0
  while (pending.length > 0) {
    const current = pending.pop()
    visited += 1
    if (visited > 512) throw new PublicFeedDataError("unavailable", "Current public post visibility could not be verified")
    if (Array.isArray(current)) {
      pending.push(...current)
    } else if (typeof current === "object" && current !== null) {
      const node = current as Record<string, unknown>
      if ("labels" in node) {
        const labels = Array.isArray(node.labels)
          ? node.labels
          : typeof node.labels === "object" && node.labels !== null && !Array.isArray(node.labels) && Array.isArray((node.labels as { values?: unknown }).values)
            ? (node.labels as { values: unknown[] }).values
            : null
        if (labels === null || labels.some((label) => typeof label !== "object" || label === null || typeof (label as { val?: unknown }).val !== "string")) {
          throw new PublicFeedDataError("contract", "Bluesky AppView hydration returned malformed visibility labels")
        }
      }
      pending.push(...Object.values(node).filter((nested) => typeof nested === "object" && nested !== null))
    }
  }
}

const appViewResponseSchema = z.object({
  posts: z.array(z.unknown()),
}).passthrough()

export interface PublicHydratedPost {
  readonly visibility: "public"
  readonly uri: string
  readonly bskyUrl: string
  readonly authorHandle: string
  readonly authorDisplayName: string
  readonly authorAvatar: string | null
  readonly text: string
  readonly indexedAt: string | null
  readonly likeCount: number | null
  readonly repostCount: number | null
  readonly replyCount: number | null
  readonly languages: readonly string[]
}

export interface UnavailableHydratedPost {
  readonly visibility: "unavailable"
  readonly uri: string
  readonly reason: string
}

export type HydratedPost = PublicHydratedPost | UnavailableHydratedPost

export type PublicFeedRow =
  | { readonly item: PublicFeedWithheldItem; readonly post: null }
  | { readonly item: PublicFeedVisibleItem; readonly post: PublicHydratedPost }

export function isPublicFeedRow(row: PublicFeedRow): row is Extract<PublicFeedRow, { readonly post: PublicHydratedPost }> {
  return row.item.placement !== "withheld"
}

export interface LoadedPublicFeed {
  readonly snapshot: PublicFeedSnapshot
  readonly rows: readonly PublicFeedRow[]
  readonly etag: string
  readonly hydrationErrors: readonly string[]
  readonly requestCount: number
}

export interface PublicFeedLoadResult {
  readonly kind: "not_modified" | "loaded" | "pending"
  readonly pendingSnapshotId: string | null
  readonly data: LoadedPublicFeed
  readonly displayedData: LoadedPublicFeed | null
}

export class PublicFeedDataError extends Error {
  readonly kind: "unavailable" | "request" | "contract"

  constructor(kind: "unavailable" | "request" | "contract", message: string) {
    super(message)
    this.kind = kind
    this.name = "PublicFeedDataError"
  }
}

function buildCorgiUrl(path: string): string {
  if (API_BASE_URL.length === 0) {
    return path
  }
  return new URL(path, API_BASE_URL).toString()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function unavailablePost(uri: string, reason: string): UnavailableHydratedPost {
  return { visibility: "unavailable", uri, reason }
}

function normalizeAppViewPost(value: unknown, requestedUris: ReadonlySet<string>): HydratedPost | null {
  const parsed = appViewPostSchema.safeParse(value)
  if (!parsed.success) {
    throw new PublicFeedDataError("contract", "Bluesky AppView hydration returned a malformed post")
  }
  if (!requestedUris.has(parsed.data.uri)) {
    throw new PublicFeedDataError("contract", "Bluesky AppView hydration returned an unrequested URI")
  }

  const post = parsed.data
  const authority = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\//.exec(post.uri)?.[1]
  if (authority !== post.author.did) {
    throw new PublicFeedDataError("unavailable", "Current public post visibility could not be verified")
  }
  validateAppViewVisibilityShape(value)
  const hiddenReason = publicPostVisibilityReason(value)
  if (hiddenReason !== null) {
    if (!POLICY_WITHHOLD_REASONS.has(hiddenReason)) {
      throw new PublicFeedDataError("unavailable", "Current public post visibility could not be verified")
    }
    return unavailablePost(post.uri, hiddenReason)
  }

  try {
    return {
      visibility: "public",
      uri: post.uri,
      bskyUrl: bskyPostUrlFromAtUri(post.uri),
      authorHandle: post.author.handle,
      authorDisplayName: post.author.displayName?.trim() || post.author.handle,
      authorAvatar: post.author.avatar ?? null,
      text: post.record.text,
      indexedAt: post.indexedAt ?? null,
      likeCount: post.likeCount ?? null,
      repostCount: post.repostCount ?? null,
      replyCount: post.replyCount ?? null,
      languages: post.record.langs ?? [],
    }
  } catch (error) {
    return unavailablePost(post.uri, `Post metadata is invalid: ${errorMessage(error)}`)
  }
}

export function splitPostUris(postUris: readonly string[]): readonly (readonly string[])[] {
  if (postUris.length > PUBLIC_FEED_LIMIT) {
    throw new PublicFeedDataError(
      "contract",
      `Feed snapshot requested ${postUris.length} hydrations; the public limit is ${PUBLIC_FEED_LIMIT}`,
    )
  }

  const batches: string[][] = []
  for (let index = 0; index < postUris.length; index += APPVIEW_BATCH_SIZE) {
    batches.push(postUris.slice(index, index + APPVIEW_BATCH_SIZE))
  }
  return batches
}

function readResponseJson(body: string, context: string): unknown {
  try {
    return JSON.parse(body) as unknown
  } catch (error) {
    throw new PublicFeedDataError("contract", `${context} returned invalid JSON: ${errorMessage(error)}`)
  }
}

interface TimedFetchResult {
  readonly response: Response
  readonly body: string
}

async function fetchWithTimeout(
  url: string,
  init: Omit<RequestInit, "signal">,
  callerSignal: AbortSignal,
  timeoutMs: number,
  context: string,
  fetcher: typeof fetch,
): Promise<TimedFetchResult> {
  if (callerSignal.aborted) {
    throw callerSignal.reason instanceof Error
      ? callerSignal.reason
      : new DOMException(`${context} was cancelled by the caller`, "AbortError")
  }

  const controller = new AbortController()
  let timedOut = false
  const abortFromCaller = (): void => {
    controller.abort(callerSignal.reason)
  }
  callerSignal.addEventListener("abort", abortFromCaller, { once: true })
  const timeoutId = globalThis.setTimeout(() => {
    timedOut = true
    controller.abort(new PublicFeedDataError("request", `${context} timed out after ${timeoutMs}ms`))
  }, timeoutMs)

  try {
    const response = await fetcher(url, { ...init, signal: controller.signal })
    const body = await response.text()
    return { response, body }
  } catch (error) {
    if (callerSignal.aborted) {
      throw callerSignal.reason instanceof Error
        ? callerSignal.reason
        : new DOMException(`${context} was cancelled by the caller`, "AbortError")
    }
    if (timedOut) {
      throw new PublicFeedDataError("request", `${context} timed out after ${timeoutMs}ms`)
    }
    if (error instanceof PublicFeedDataError) {
      throw error
    }
    throw new PublicFeedDataError("request", `${context} request failed: ${errorMessage(error)}`)
  } finally {
    globalThis.clearTimeout(timeoutId)
    callerSignal.removeEventListener("abort", abortFromCaller)
  }
}

async function hydrateBatch(
  postUris: readonly string[],
  signal: AbortSignal,
  fetcher: typeof fetch,
): Promise<ReadonlyMap<string, HydratedPost>> {
  const { response, body } = await fetchWithTimeout(buildPostHydrationUrl(postUris), {
    method: "GET",
    headers: { Accept: "application/json" },
    credentials: "omit",
    cache: "no-store",
  }, signal, PUBLIC_FEED_APPVIEW_TIMEOUT_MS, "Bluesky AppView hydration", fetcher)
  if (!response.ok) {
    throw new PublicFeedDataError(
      "request",
      `Bluesky AppView hydration failed with HTTP ${response.status}: ${body.slice(0, 240)}`,
    )
  }

  const payload = appViewResponseSchema.safeParse(readResponseJson(body, "Bluesky AppView hydration"))
  if (!payload.success) {
    throw new PublicFeedDataError(
      "contract",
      `Bluesky AppView hydration violated its response contract: ${payload.error.issues[0]?.message ?? "unknown validation error"}`,
    )
  }

  const requestedUriSet = new Set(postUris)
  const posts = new Map<string, HydratedPost>()
  for (const value of payload.data.posts) {
    const post = normalizeAppViewPost(value, requestedUriSet)
    if (post === null || posts.has(post.uri)) {
      throw new PublicFeedDataError("unavailable", "Current public post visibility could not be verified")
    }
    posts.set(post.uri, post)
  }
  return posts
}

export async function loadPublicFeed(
  signal: AbortSignal,
  cached: LoadedPublicFeed | null,
  fetcher: typeof fetch,
  displayed: LoadedPublicFeed | null,
): Promise<PublicFeedLoadResult> {
  const headers = new Headers({ Accept: "application/json" })
  if (cached !== null && cached.etag.length > 0) {
    headers.set("If-None-Match", cached.etag)
  }

  const snapshotEndpoint = buildCorgiUrl("/api/transparency/feed-snapshot")
  const snapshotUrl = `${snapshotEndpoint}${snapshotEndpoint.includes("?") ? "&" : "?"}limit=${PUBLIC_FEED_LIMIT}`
  const { response, body } = await fetchWithTimeout(snapshotUrl, {
    method: "GET",
    headers,
    credentials: "omit",
    cache: "no-store",
  }, signal, PUBLIC_FEED_SNAPSHOT_TIMEOUT_MS, "Public feed snapshot", fetcher)

  if (response.status === 304 && cached === null) {
    throw new PublicFeedDataError("contract", "Public feed returned 304 without a cached snapshot")
  }
  if (response.status !== 304 && !response.ok) {
    const kind = response.status === 503 ? "unavailable" : "request"
    throw new PublicFeedDataError(
      kind,
      `Public feed snapshot failed with HTTP ${response.status}: ${body.slice(0, 240)}`,
    )
  }

  const parsed = publicFeedSnapshotSchema.safeParse(
    response.status === 304 ? cached?.snapshot : readResponseJson(body, "Public feed snapshot"),
  )
  if (!parsed.success) {
    throw new PublicFeedDataError(
      "contract",
      `Public feed snapshot violated its response contract: ${parsed.error.issues[0]?.path.join(".") || "response"} ${parsed.error.issues[0]?.message ?? "is invalid"}`,
    )
  }

  const snapshot = parsed.data
  if (displayed !== null && displayed.snapshot.presentation_snapshot_id !== snapshot.presentation_snapshot_id) {
    const rows: readonly PublicFeedRow[] = displayed.rows.map((row) => ({
      item: { position: row.item.position, placement: "withheld", reason: "Post withheld from the public view" },
      post: null,
    }))
    const safeData: LoadedPublicFeed = {
      ...displayed,
      snapshot: { ...displayed.snapshot, items: rows.map((row) => row.item) },
      rows,
      etag: "",
      hydrationErrors: [],
      requestCount: 0,
    }
    return { kind: "pending", pendingSnapshotId: snapshot.presentation_snapshot_id, data: safeData, displayedData: null }
  }
  // Visibility belongs to the displayed posts, independently of ranking ETags.
  // Pending-only posts hydrate when accepted, keeping each refresh at two batches.
  const hydrationSnapshot = snapshot
  const postUris = hydrationSnapshot.items.flatMap((item) => item.placement === "withheld" ? [] : [item.post_uri])
  const batches = splitPostUris(postUris)
  const requestCount = 1 + batches.length
  if (requestCount > PUBLIC_FEED_MAX_REQUESTS_PER_REFRESH) {
    throw new PublicFeedDataError(
      "contract",
      `Public feed refresh would use ${requestCount} requests; limit is ${PUBLIC_FEED_MAX_REQUESTS_PER_REFRESH}`,
    )
  }
  const hydrationResults = await Promise.all(
    batches.map((batch) => hydrateBatch(batch, signal, fetcher)),
  )
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new DOMException("Request aborted", "AbortError")
  }

  const hydratedByUri = new Map<string, HydratedPost>()
  for (const result of hydrationResults) {
    for (const [uri, post] of result) hydratedByUri.set(uri, post)
  }
  const hydrationErrors: string[] = []

  const rowsForSnapshot = (source: PublicFeedSnapshot): readonly PublicFeedRow[] => source.items.map((item) => {
    if (item.placement === "withheld") {
      return { item, post: null }
    }
    const post = hydratedByUri.get(item.post_uri)
    if (post === undefined || post.visibility !== "public") {
      const withheld: PublicFeedWithheldItem = { position: item.position, placement: "withheld", reason: "Post withheld from the public view" }
      return { item: withheld, post: null }
    }
    return { item, post }
  })
  const hydratedRows = rowsForSnapshot(hydrationSnapshot)
  const displayedData = displayed === null ? null : {
    ...displayed,
    snapshot: { ...hydrationSnapshot, items: hydratedRows.map((row) => row.item) },
    rows: hydratedRows,
    hydrationErrors,
    requestCount,
  }
  const locallyWithheld = hydrationSnapshot.items.some((item, index) => (
    item.placement !== "withheld" && hydratedRows[index]?.item.placement === "withheld"
  ))

  return {
    kind: response.status === 304 ? "not_modified" : "loaded",
    pendingSnapshotId: null,
    data: {
      snapshot: { ...snapshot, items: hydratedRows.map((row) => row.item) },
      rows: hydratedRows,
      etag: locallyWithheld
        ? ""
        : response.status === 304 && cached !== null
        ? cached.etag
        : response.headers.get("ETag") ?? `"${snapshot.presentation_snapshot_id}-${PUBLIC_FEED_LIMIT}"`,
      hydrationErrors,
      requestCount,
    },
    displayedData,
  }
}

export interface StrongestContribution {
  readonly key: SignalKey
  readonly label: string
  readonly component: PublicFeedScoreComponent
}

export function strongestContribution(item: PublicFeedScoredItem): StrongestContribution {
  const key = SIGNAL_KEYS.reduce((strongest, candidate) => (
    Math.abs(item.components[candidate].weighted) > Math.abs(item.components[strongest].weighted)
      ? candidate
      : strongest
  ))
  return { key, label: SIGNAL_LABELS[key], component: item.components[key] }
}

export function retainSelectedUri(
  selectedUri: string | null,
  rows: readonly PublicFeedRow[],
): string | null {
  if (selectedUri !== null && rows.some((row) => isPublicFeedRow(row) && row.item.post_uri === selectedUri)) {
    return selectedUri
  }
  return rows.find(isPublicFeedRow)?.item.post_uri ?? null
}

export function isSnapshotStale(snapshot: PublicFeedSnapshot, nowMs: number): boolean {
  if (snapshot.status === "last_known_good") {
    return true
  }
  const publishedAtMs = Date.parse(snapshot.published_at)
  if (!Number.isFinite(publishedAtMs)) {
    return true
  }
  return nowMs - publishedAtMs > snapshot.expected_refresh_seconds * 2 * 1_000
}
