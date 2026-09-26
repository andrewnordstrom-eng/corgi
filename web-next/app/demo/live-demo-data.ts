import {
  BLUESKY_APPVIEW_BASE_URL,
  BlueskyPublicDataError,
  bskyPostUrlFromAtUri as buildBlueskyPostUrl,
  buildPostHydrationUrl as buildBlueskyHydrationUrl,
} from "@/lib/bluesky-public"
import { publicPostVisibilityReason } from "../../../src/shared/public-post-visibility"

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? ""
const LIVE_FEED_LIMIT = 12
const REQUEST_TIMEOUT_MS = 12_000
const RECEIPT_REQUEST_TIMEOUT_MS = 5_000

export const CORGI_COMMUNITY_FEED_URI =
  "at://did:plc:amzyknmm4auxijvykyfgznw2/app.bsky.feed.generator/community-gov"
export const CORGI_BSKY_FEED_URL = "https://bsky.app/profile/corgi-network.bsky.social/feed/community-gov"

export interface LiveDemoWeights {
  readonly epochId: number
  readonly status: string
  readonly voteCount: number
  readonly createdAt: string
  readonly weights: {
    readonly recency: number
    readonly engagement: number
    readonly bridging: number
    readonly source_diversity: number
    readonly relevance: number
  }
}

export interface LiveDemoStats {
  readonly epochId: number
  readonly totalPostsScored: number
  readonly uniqueAuthors: number
  readonly avgBridging: number
  readonly avgEngagement: number
  readonly medianBridging: number
  readonly medianTotal: number
  readonly votesThisEpoch: number
}

export interface PublicLiveDemoFeedPost {
  readonly visibility: "public"
  readonly rank: number
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
  readonly quoteCount: number | null
  readonly score: number | null
  readonly labels: readonly string[]
}

export interface HiddenLiveDemoFeedPost {
  readonly visibility: "hidden"
  readonly rank: number
  readonly uri: string | null
  readonly bskyUrl: null
  readonly authorHandle: null
  readonly authorDisplayName: null
  readonly authorAvatar: null
  readonly text: null
  readonly indexedAt: null
  readonly likeCount: null
  readonly repostCount: null
  readonly replyCount: null
  readonly quoteCount: null
  readonly score: null
  readonly labels: readonly string[]
  readonly hiddenReason: string
}

export type LiveDemoFeedPost = PublicLiveDemoFeedPost | HiddenLiveDemoFeedPost

export interface LiveDemoScoreComponent {
  readonly key: string
  readonly label: string
  readonly raw_score: number
  readonly weight: number
  readonly weighted: number
}

export interface LiveDemoTopicBreakdown {
  readonly slug: string
  readonly name: string
  readonly postScore: number
  readonly communityWeight: number
  readonly contribution: number
}

export interface LiveDemoExplanation {
  readonly postUri: string
  readonly epochId: number
  readonly totalScore: number
  readonly rank: number
  readonly components: readonly LiveDemoScoreComponent[]
  readonly counterfactual: {
    readonly pureEngagementRank: number
    readonly communityGovernedRank: number
    readonly difference: number
  }
  readonly scoredAt: string
  readonly topicBreakdown: readonly LiveDemoTopicBreakdown[]
}

export interface LiveDemoData {
  readonly fetchedAt: string
  readonly feedCursor: string | null
  readonly posts: readonly LiveDemoFeedPost[]
  readonly weights: LiveDemoWeights | null
  readonly stats: LiveDemoStats | null
  readonly explanation: LiveDemoExplanation | null
  readonly receiptPost: PublicLiveDemoFeedPost | null
  readonly errors: readonly string[]
}

export class LiveDemoDataError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LiveDemoDataError"
  }
}

export function buildPostHydrationUrl(postUris: readonly string[]): string {
  try {
    return buildBlueskyHydrationUrl(postUris)
  } catch (error) {
    if (error instanceof BlueskyPublicDataError) {
      throw new LiveDemoDataError(error.message)
    }
    throw error
  }
}

export function bskyPostUrlFromAtUri(postUri: string): string {
  try {
    return buildBlueskyPostUrl(postUri)
  } catch (error) {
    if (error instanceof BlueskyPublicDataError) {
      throw new LiveDemoDataError(error.message)
    }
    throw error
  }
}

interface AppViewLabel {
  readonly val?: unknown
}

interface AppViewAuthor {
  readonly did?: unknown
  readonly handle?: unknown
  readonly displayName?: unknown
  readonly avatar?: unknown
  readonly labels?: readonly AppViewLabel[]
}

interface AppViewPostApi {
  readonly uri?: unknown
  readonly author?: AppViewAuthor
  readonly record?: {
    readonly text?: unknown
    readonly createdAt?: unknown
  }
  readonly labels?: readonly AppViewLabel[]
  readonly indexedAt?: unknown
  readonly likeCount?: unknown
  readonly repostCount?: unknown
  readonly replyCount?: unknown
  readonly quoteCount?: unknown
}

interface AppViewFeedItem {
  readonly post?: AppViewPostApi
}

export interface AppViewFeedResponse {
  readonly feed?: readonly AppViewFeedItem[]
  readonly cursor?: unknown
}

interface GovernanceWeightsResponse {
  readonly epoch_id?: unknown
  readonly status?: unknown
  readonly vote_count?: unknown
  readonly created_at?: unknown
  readonly weights?: {
    readonly recency?: unknown
    readonly engagement?: unknown
    readonly bridging?: unknown
    readonly sourceDiversity?: unknown
    readonly source_diversity?: unknown
    readonly relevance?: unknown
  }
}

interface FeedStatsResponse {
  readonly epoch?: {
    readonly id?: unknown
  }
  readonly feed_stats?: {
    readonly total_posts_scored?: unknown
    readonly unique_authors?: unknown
    readonly avg_bridging_score?: unknown
    readonly avg_engagement_score?: unknown
    readonly median_bridging_score?: unknown
    readonly median_total_score?: unknown
  }
  readonly governance?: {
    readonly votes_this_epoch?: unknown
  }
}

interface ScoreComponentApi {
  readonly raw_score?: unknown
  readonly weight?: unknown
  readonly weighted?: unknown
}

interface RelevanceScoreComponentApi extends ScoreComponentApi {
  readonly topicBreakdown?: Record<string, TopicBreakdownApi>
}

interface TopicBreakdownApi {
  readonly postScore?: unknown
  readonly communityWeight?: unknown
  readonly contribution?: unknown
}

interface PostExplanationResponse {
  readonly post_uri?: unknown
  readonly epoch_id?: unknown
  readonly total_score?: unknown
  readonly rank?: unknown
  readonly components?: {
    readonly recency?: ScoreComponentApi
    readonly engagement?: ScoreComponentApi
    readonly bridging?: ScoreComponentApi
    readonly source_diversity?: ScoreComponentApi
    readonly relevance?: RelevanceScoreComponentApi
  }
  readonly counterfactual?: {
    readonly pure_engagement_rank?: unknown
    readonly community_governed_rank?: unknown
    readonly difference?: unknown
  }
  readonly scored_at?: unknown
}

const SCORE_COMPONENTS = [
  { key: "recency", label: "Recency" },
  { key: "engagement", label: "Engagement" },
  { key: "bridging", label: "Bridging" },
  { key: "source_diversity", label: "Source diversity" },
  { key: "relevance", label: "Relevance" },
] as const

function buildCorgiUrl(path: string): string {
  if (API_BASE_URL.length > 0) {
    return new URL(path, API_BASE_URL).toString()
  }

  return path
}

export function buildAppViewFeedUrl(feedUri: string, limit: number): string {
  const url = new URL("/xrpc/app.bsky.feed.getFeed", BLUESKY_APPVIEW_BASE_URL)
  url.searchParams.set("feed", feedUri)
  url.searchParams.set("limit", String(limit))
  return url.toString()
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asString(value: unknown, field: string): string {
  if (typeof value === "string" && value.length > 0) {
    return value
  }

  throw new LiveDemoDataError(`Expected ${field} to be a non-empty string`)
}

function asOptionalString(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) {
    return value
  }

  return null
}

function asNumber(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }

  throw new LiveDemoDataError(`Expected ${field} to be a finite number`)
}

function asOptionalNumber(value: unknown, field: string): number | null {
  if (value === null || value === undefined) {
    return null
  }

  return asNumber(value, field)
}

function humanizeSlug(slug: string): string {
  return slug
    .split("-")
    .filter((part) => part.length > 0)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ")
}

function createTimedSignal(
  parentSignal: AbortSignal,
  timeoutMs: number,
  context: string,
): { readonly signal: AbortSignal; readonly dispose: () => void } {
  const controller = new AbortController()
  const timeoutId: ReturnType<typeof globalThis.setTimeout> = globalThis.setTimeout(() => {
    controller.abort(new LiveDemoDataError(`${context} timed out after ${timeoutMs}ms`))
  }, timeoutMs)
  const abortFromParent = (): void => {
    controller.abort(parentSignal.reason)
  }

  if (parentSignal.aborted) {
    abortFromParent()
  } else {
    parentSignal.addEventListener("abort", abortFromParent, { once: true })
  }

  return {
    signal: controller.signal,
    dispose: () => {
      globalThis.clearTimeout(timeoutId)
      parentSignal.removeEventListener("abort", abortFromParent)
    },
  }
}

async function fetchJson<TResponse>(
  url: string,
  signal: AbortSignal,
  context: string,
  timeoutMs: number,
): Promise<TResponse> {
  const timedSignal = createTimedSignal(signal, timeoutMs, context)

  try {
    const response = await fetch(url, {
      signal: timedSignal.signal,
      headers: {
        Accept: "application/json",
      },
    })
    const body = await response.text()

    if (!response.ok) {
      throw new LiveDemoDataError(
        `${context} failed with HTTP ${response.status} ${response.statusText}`,
      )
    }

    try {
      return JSON.parse(body) as TResponse
    } catch (error) {
      throw new LiveDemoDataError(`${context} returned invalid JSON: ${errorMessage(error)}`)
    }
  } finally {
    timedSignal.dispose()
  }
}

function labelValuesFromLabels(labels: readonly AppViewLabel[] | undefined): readonly string[] {
  if (!Array.isArray(labels)) {
    return []
  }

  return labels
    .filter(isRecord)
    .map((label) => label.val)
    .filter((value): value is string => typeof value === "string" && value.length > 0)
}

function labelValuesForPost(post: AppViewPostApi | undefined): readonly string[] {
  return [
    ...labelValuesFromLabels(post?.labels),
    ...labelValuesFromLabels(post?.author?.labels),
  ]
}

function hiddenPost(rank: number, post: AppViewPostApi | undefined, labels: readonly string[], reason: string): HiddenLiveDemoFeedPost {
  return {
    visibility: "hidden",
    rank,
    uri: null,
    bskyUrl: null,
    authorHandle: null,
    authorDisplayName: null,
    authorAvatar: null,
    text: null,
    indexedAt: null,
    likeCount: null,
    repostCount: null,
    replyCount: null,
    quoteCount: null,
    score: null,
    labels,
    hiddenReason: reason,
  }
}

function normalizeAppViewPost(post: AppViewPostApi | undefined, rank: number): LiveDemoFeedPost {
  const labels = labelValuesForPost(post)
  if (post === undefined) {
    return hiddenPost(rank, post, labels, "Post unavailable from Bluesky public view")
  }
  const visibilityReason = publicPostVisibilityReason(post)

  if (visibilityReason !== null) {
    return hiddenPost(rank, post, labels, visibilityReason)
  }

  const text = asOptionalString(post.record?.text)
  const uri = asString(post.uri, `feed[${rank}].post.uri`)
  const authorHandle = asString(post.author?.handle, `feed[${rank}].post.author.handle`)
  const authorDisplayName = asOptionalString(post.author?.displayName) ?? authorHandle

  if (text === null) {
    return hiddenPost(rank, post, labels, "Post unavailable from Bluesky public view")
  }

  return {
    visibility: "public",
    rank,
    uri,
    bskyUrl: bskyPostUrlFromAtUri(uri),
    authorHandle,
    authorDisplayName,
    authorAvatar: asOptionalString(post.author?.avatar),
    text,
    indexedAt: asOptionalString(post.indexedAt),
    likeCount: asOptionalNumber(post.likeCount, `feed[${rank}].post.likeCount`),
    repostCount: asOptionalNumber(post.repostCount, `feed[${rank}].post.repostCount`),
    replyCount: asOptionalNumber(post.replyCount, `feed[${rank}].post.replyCount`),
    quoteCount: asOptionalNumber(post.quoteCount, `feed[${rank}].post.quoteCount`),
    score: null,
    labels,
  }
}

export function normalizeAppViewFeed(response: AppViewFeedResponse): {
  readonly posts: readonly LiveDemoFeedPost[]
  readonly cursor: string | null
} {
  if (!isRecord(response) || !Array.isArray(response.feed)) {
    throw new LiveDemoDataError("Expected AppView feed response to include a feed array")
  }

  return {
    posts: response.feed.map((item, index) => {
      if (!isRecord(item)) {
        throw new LiveDemoDataError(`Expected AppView feed item ${index + 1} to contain a post object`)
      }
      const post = isRecord(item.post) ? item.post as AppViewPostApi : undefined
      return normalizeAppViewPost(post, index + 1)
    }),
    cursor: asOptionalString(response.cursor),
  }
}

export function selectReceiptPost(posts: readonly LiveDemoFeedPost[]): PublicLiveDemoFeedPost | null {
  return posts.find((post): post is PublicLiveDemoFeedPost => post.visibility === "public") ?? null
}

export function scoreComponentsFromExplanation(explanation: PostExplanationResponse): readonly LiveDemoScoreComponent[] {
  const components = explanation.components

  if (components === undefined) {
    throw new LiveDemoDataError("Post explanation is missing components")
  }

  return SCORE_COMPONENTS.map((component) => {
    const apiComponent = components[component.key]

    if (apiComponent === undefined) {
      throw new LiveDemoDataError(`Post explanation is missing ${component.key} component`)
    }

    return {
      key: component.key,
      label: component.label,
      raw_score: asNumber(apiComponent.raw_score, `${component.key}.raw_score`),
      weight: asNumber(apiComponent.weight, `${component.key}.weight`),
      weighted: asNumber(apiComponent.weighted, `${component.key}.weighted`),
    }
  })
}

export function topicBreakdownFromExplanation(explanation: PostExplanationResponse): readonly LiveDemoTopicBreakdown[] {
  const topicBreakdown = explanation.components?.relevance?.topicBreakdown

  if (topicBreakdown === undefined) {
    return []
  }

  return Object.entries(topicBreakdown).map(([slug, breakdown]) => ({
    slug,
    name: humanizeSlug(slug),
    postScore: asNumber(breakdown.postScore, `${slug}.postScore`),
    communityWeight: asNumber(breakdown.communityWeight, `${slug}.communityWeight`),
    contribution: asNumber(breakdown.contribution, `${slug}.contribution`),
  }))
}

function normalizeWeights(response: GovernanceWeightsResponse): LiveDemoWeights {
  if (!isRecord(response)) {
    throw new LiveDemoDataError("Expected governance weights response to be an object")
  }
  const weights = response.weights

  if (!isRecord(weights)) {
    throw new LiveDemoDataError("Governance weights response is missing weights")
  }

  return {
    epochId: asNumber(response.epoch_id, "epoch_id"),
    status: asString(response.status, "status"),
    voteCount: asNumber(response.vote_count, "vote_count"),
    createdAt: asString(response.created_at, "created_at"),
    weights: {
      recency: asNumber(weights.recency, "weights.recency"),
      engagement: asNumber(weights.engagement, "weights.engagement"),
      bridging: asNumber(weights.bridging, "weights.bridging"),
      source_diversity: asNumber(weights.source_diversity ?? weights.sourceDiversity, "weights.source_diversity"),
      relevance: asNumber(weights.relevance, "weights.relevance"),
    },
  }
}

function normalizeStats(response: FeedStatsResponse): LiveDemoStats {
  if (!isRecord(response)) {
    throw new LiveDemoDataError("Expected transparency stats response to be an object")
  }
  const typedResponse = response as FeedStatsResponse
  return {
    epochId: asNumber(typedResponse.epoch?.id, "epoch.id"),
    totalPostsScored: asNumber(typedResponse.feed_stats?.total_posts_scored, "feed_stats.total_posts_scored"),
    uniqueAuthors: asNumber(typedResponse.feed_stats?.unique_authors, "feed_stats.unique_authors"),
    avgBridging: asNumber(typedResponse.feed_stats?.avg_bridging_score, "feed_stats.avg_bridging_score"),
    avgEngagement: asNumber(typedResponse.feed_stats?.avg_engagement_score, "feed_stats.avg_engagement_score"),
    medianBridging: asNumber(typedResponse.feed_stats?.median_bridging_score, "feed_stats.median_bridging_score"),
    medianTotal: asNumber(typedResponse.feed_stats?.median_total_score, "feed_stats.median_total_score"),
    votesThisEpoch: asNumber(typedResponse.governance?.votes_this_epoch, "governance.votes_this_epoch"),
  }
}

function normalizeExplanation(response: PostExplanationResponse): LiveDemoExplanation {
  if (!isRecord(response)) {
    throw new LiveDemoDataError("Expected post explanation response to be an object")
  }
  const typedResponse = response as PostExplanationResponse
  return {
    postUri: asString(typedResponse.post_uri, "post_uri"),
    epochId: asNumber(typedResponse.epoch_id, "epoch_id"),
    totalScore: asNumber(typedResponse.total_score, "total_score"),
    rank: asNumber(typedResponse.rank, "rank"),
    components: scoreComponentsFromExplanation(typedResponse),
    counterfactual: {
      pureEngagementRank: asNumber(typedResponse.counterfactual?.pure_engagement_rank, "counterfactual.pure_engagement_rank"),
      communityGovernedRank: asNumber(
        typedResponse.counterfactual?.community_governed_rank,
        "counterfactual.community_governed_rank",
      ),
      difference: asNumber(typedResponse.counterfactual?.difference, "counterfactual.difference"),
    },
    scoredAt: asString(typedResponse.scored_at, "scored_at"),
    topicBreakdown: topicBreakdownFromExplanation(typedResponse),
  }
}

async function fetchAppViewFeed(signal: AbortSignal): Promise<{
  readonly posts: readonly LiveDemoFeedPost[]
  readonly cursor: string | null
}> {
  return normalizeAppViewFeed(
    await fetchJson<AppViewFeedResponse>(
      buildAppViewFeedUrl(CORGI_COMMUNITY_FEED_URI, LIVE_FEED_LIMIT),
      signal,
      "Bluesky AppView feed",
      REQUEST_TIMEOUT_MS,
    ),
  )
}

async function fetchWeights(signal: AbortSignal): Promise<LiveDemoWeights> {
  return normalizeWeights(
    await fetchJson<GovernanceWeightsResponse>(
      buildCorgiUrl("/api/governance/weights"),
      signal,
      "governance weights",
      REQUEST_TIMEOUT_MS,
    ),
  )
}

async function fetchStats(signal: AbortSignal): Promise<LiveDemoStats> {
  return normalizeStats(
    await fetchJson<FeedStatsResponse>(
      buildCorgiUrl("/api/transparency/stats"),
      signal,
      "transparency stats",
      REQUEST_TIMEOUT_MS,
    ),
  )
}

export async function fetchLiveDemoReceipt(postUri: string, signal: AbortSignal): Promise<LiveDemoExplanation> {
  return normalizeExplanation(
    await fetchJson<PostExplanationResponse>(
      buildCorgiUrl(`/api/transparency/post/${encodeURIComponent(postUri)}`),
      signal,
      "post transparency receipt",
      RECEIPT_REQUEST_TIMEOUT_MS,
    ),
  )
}

export async function fetchLiveDemoData(signal: AbortSignal): Promise<LiveDemoData> {
  const errors: string[] = []
  const [feedResult, weightsResult, statsResult] = await Promise.allSettled([
    fetchAppViewFeed(signal),
    fetchWeights(signal),
    fetchStats(signal),
  ])

  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new LiveDemoDataError("Live demo request was aborted")
  }

  const feed = feedResult.status === "fulfilled" ? feedResult.value : { posts: [], cursor: null }

  if (feedResult.status === "rejected") {
    errors.push(errorMessage(feedResult.reason))
  }

  if (weightsResult.status === "rejected") {
    errors.push(errorMessage(weightsResult.reason))
  }

  if (statsResult.status === "rejected") {
    errors.push(errorMessage(statsResult.reason))
  }

  return {
    fetchedAt: new Date().toISOString(),
    feedCursor: feed.cursor,
    posts: feed.posts,
    weights: weightsResult.status === "fulfilled" ? weightsResult.value : null,
    stats: statsResult.status === "fulfilled" ? statsResult.value : null,
    explanation: null,
    receiptPost: selectReceiptPost(feed.posts),
    errors,
  }
}
