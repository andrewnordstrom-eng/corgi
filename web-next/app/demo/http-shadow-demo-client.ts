import { SIGNAL_LABELS } from "@/lib/signals"
import type { ZodType } from "zod"
import {
  SHADOW_DEMO_ENDPOINTS,
  SHADOW_DEMO_SIGNAL_KEYS,
} from "./shadow-demo-contract"
import {
  type AdvanceShadowDemoEpochRequest,
  type AdvanceShadowDemoEpochResponse,
  type CastShadowDemoVoteRequest,
  type CastShadowDemoVoteResponse,
  type CreateShadowDemoSessionRequest,
  type RunShadowDemoAgentsRequest,
  type RunShadowDemoAgentsResponse,
  type ShadowDemoAgent,
  type ShadowDemoAgentId,
  type ShadowDemoAggregate,
  type ShadowDemoClient,
  type ShadowDemoCommunity,
  type ShadowDemoCommunityId,
  type ShadowDemoCounterfactual,
  type ShadowDemoEnvelope,
  type ShadowDemoEpoch,
  type ShadowDemoFeed,
  type ShadowDemoFeedItem,
  type ShadowDemoFeedRequest,
  type ShadowDemoPhase,
  type ShadowDemoReceipt,
  type ShadowDemoReceiptRequest,
  type ShadowDemoReceiptResponse,
  type ShadowDemoSession,
  type ShadowDemoSessionResponse,
  type ShadowDemoSignalKey,
  type ShadowDemoTopicIntent,
  type ShadowDemoVote,
  type ShadowDemoWarning,
  type ShadowDemoWeights,
  type ShadowDemoWithheldFeedItem,
} from "./shadow-demo-view-model"
import {
  CONTRACT_VERSION,
  apiFeedEnvelopeSchema,
  apiReceiptEnvelopeSchema,
  apiSessionEnvelopeSchema,
  type ApiEnvelope,
  type ApiFeedPayload,
  type ApiReceiptPayload,
  type ApiSessionPayload,
} from "./shadow-demo-api-schemas"

type ApiSession = ApiSessionPayload["session"]
type ApiEpoch = ApiSession["epochs"][number]
type ApiVote = ApiSession["votes"][number]
type ApiVoteSummary = ApiEpoch["aggregate"]
type ApiVoterProfile = ApiSession["voterProfiles"][number]
type ApiCommunity = ApiSession["community"]
type ApiCorpusHealth = ApiSession["corpusHealth"]
type ApiRankedPost = ApiFeedPayload["posts"][number]
type ApiWarning = ApiEnvelope<unknown>["warnings"][number]

export class ShadowDemoHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = "ShadowDemoHttpError"
  }
}

const SHADOW_DEMO_REQUEST_TIMEOUT_MS = 10_000
const SHADOW_DEMO_CORPUS_REQUEST_TIMEOUT_MS = 30_000

export function createHttpShadowDemoClient(): ShadowDemoClient {
  return {
    async createSession(request, signal) {
      let sessionEnvelope: ApiEnvelope<ApiSessionPayload>
      try {
        sessionEnvelope = await requestApi<ApiSessionPayload>(
          SHADOW_DEMO_ENDPOINTS.createSession,
          {
            method: "POST",
            body: JSON.stringify({ communityId: request.communityId, clientNonce: request.clientNonce }),
          },
          signal,
          SHADOW_DEMO_CORPUS_REQUEST_TIMEOUT_MS,
          apiSessionEnvelopeSchema,
        )
      } catch (error) {
        if (!isLegacyClientNonceRejection(error)) throw error
        sessionEnvelope = await requestApi<ApiSessionPayload>(
          SHADOW_DEMO_ENDPOINTS.createSession,
          { method: "POST", body: JSON.stringify({ communityId: request.communityId }) },
          signal,
          SHADOW_DEMO_CORPUS_REQUEST_TIMEOUT_MS,
          apiSessionEnvelopeSchema,
        )
      }
      return sessionResponseEnvelope(sessionEnvelope, request.scenarioId, request.mode, signal)
    },

    async getSession(sessionId, signal) {
      const sessionEnvelope = await requestApi<ApiSessionPayload>(
        sessionPath(sessionId),
        { method: "GET" },
        signal,
        SHADOW_DEMO_REQUEST_TIMEOUT_MS,
        apiSessionEnvelopeSchema,
      )
      if (sessionEnvelope.payload.session.sessionId !== sessionId) {
        throw new Error("The shadow demo returned a different session during recovery.")
      }
      return sessionResponseEnvelope(sessionEnvelope, "guided_default", "guided", signal)
    },

    async castVote(sessionId, request, signal) {
      const envelope = await requestApi<ApiSessionPayload>(
        mutationPath(sessionId, "votes"),
        {
          method: "POST",
          body: JSON.stringify({
            idempotencyKey: request.idempotencyKey,
            baseEpochId: request.baseEpochId,
            weights: request.weights,
            topicIntent: { topicWeights: request.topicIntent.topicWeights },
            ...(request.excludeKeywords !== undefined && request.excludeKeywords.length > 0
              ? { excludeKeywords: [...request.excludeKeywords] }
              : {}),
          }),
        },
        signal,
        SHADOW_DEMO_REQUEST_TIMEOUT_MS,
        apiSessionEnvelopeSchema,
      )
      const apiSession = envelope.payload.session
      const reviewerVote = [...apiSession.votes]
        .reverse()
        .find((vote) => vote.epochId === request.baseEpochId && vote.actorType === "reviewer")
      if (reviewerVote === undefined) {
        throw new Error("The shadow demo accepted the vote but did not return the reviewer vote.")
      }
      return mapEnvelope(envelope, {
        session: mapSession(apiSession, "guided_default", "guided"),
        reviewerVote: mapVote(reviewerVote),
        currentEpoch: mapCurrentEpoch(apiSession),
        nextRecommendedAction: "run_agent_votes",
      } satisfies CastShadowDemoVoteResponse)
    },

    async runAgents(sessionId, request, signal) {
      const envelope = await requestApi<ApiSessionPayload>(
        mutationPath(sessionId, "agents/run"),
        {
          method: "POST",
          body: JSON.stringify({ idempotencyKey: request.idempotencyKey, baseEpochId: request.baseEpochId }),
        },
        signal,
        SHADOW_DEMO_REQUEST_TIMEOUT_MS,
        apiSessionEnvelopeSchema,
      )
      const apiSession = envelope.payload.session
      if (apiSession.pendingAggregate === null) {
        throw new Error("Synthetic voters ran without returning a pending aggregate policy.")
      }
      return mapEnvelope(envelope, {
        session: mapSession(apiSession, "guided_default", "guided"),
        agents: apiSession.voterProfiles.map(mapAgent),
        agentVotes: apiSession.votes
          .filter((vote) => vote.epochId === request.baseEpochId && vote.actorType === "synthetic_voter")
          .map(mapVote),
        currentEpoch: mapCurrentEpoch(apiSession),
        pendingAggregate: mapAggregate(apiSession.pendingAggregate),
        nextRecommendedAction: "advance_epoch",
      } satisfies RunShadowDemoAgentsResponse)
    },

    async advanceEpoch(sessionId, request, signal) {
      const feedBeforeEnvelope = await requestApi<ApiFeedPayload>(
        feedPath(sessionId, request.fromEpochId, 12),
        { method: "GET" },
        signal,
        SHADOW_DEMO_REQUEST_TIMEOUT_MS,
        apiFeedEnvelopeSchema,
      )
      const envelope = await requestApi<ApiSessionPayload>(
        mutationPath(sessionId, "epochs/advance"),
        {
          method: "POST",
          body: JSON.stringify({ idempotencyKey: request.idempotencyKey, fromEpochId: request.fromEpochId }),
        },
        signal,
        SHADOW_DEMO_REQUEST_TIMEOUT_MS,
        apiSessionEnvelopeSchema,
      )
      const apiSession = envelope.payload.session
      const feedAfterEnvelope = await requestApi<ApiFeedPayload>(
        feedPath(sessionId, apiSession.currentEpochId, 12),
        { method: "GET" },
        signal,
        SHADOW_DEMO_REQUEST_TIMEOUT_MS,
        apiFeedEnvelopeSchema,
      )
      return mapEnvelope(envelope, {
        session: mapSession(apiSession, "guided_default", "guided"),
        previousEpoch: mapEpoch(requiredEpoch(apiSession, request.fromEpochId)),
        currentEpoch: mapCurrentEpoch(apiSession),
        feedBefore: mapFeed(feedBeforeEnvelope.payload, feedBeforeEnvelope.generatedAt),
        feedAfter: mapFeed(feedAfterEnvelope.payload, feedAfterEnvelope.generatedAt),
        nextRecommendedAction: "select_post",
      } satisfies AdvanceShadowDemoEpochResponse)
    },

    async getFeed(sessionId, request, signal) {
      const envelope = await requestApi<ApiFeedPayload>(
        feedPath(sessionId, request.epochId, request.limit),
        { method: "GET" },
        signal,
        SHADOW_DEMO_REQUEST_TIMEOUT_MS,
        apiFeedEnvelopeSchema,
      )
      return mapEnvelope(envelope, mapFeed(envelope.payload, envelope.generatedAt))
    },

    async getReceipt(sessionId, request, signal) {
      const [receiptEnvelope, sessionEnvelope] = await Promise.all([
        requestApi<ApiReceiptPayload>(
          receiptPath(sessionId, request),
          { method: "GET" },
          signal,
          SHADOW_DEMO_REQUEST_TIMEOUT_MS,
          apiReceiptEnvelopeSchema,
        ),
        requestApi<ApiSessionPayload>(
          sessionPath(sessionId),
          { method: "GET" },
          signal,
          SHADOW_DEMO_REQUEST_TIMEOUT_MS,
          apiSessionEnvelopeSchema,
        ),
      ])
      return mapEnvelope(receiptEnvelope, {
        session: mapSession(sessionEnvelope.payload.session, "guided_default", "guided"),
        receipt: mapReceipt(receiptEnvelope.payload.receipt, receiptEnvelope.generatedAt),
      } satisfies ShadowDemoReceiptResponse)
    },
  }
}

function isLegacyClientNonceRejection(error: unknown): boolean {
  // Remove this message-specific bridge after the v3 nonce-required backend and
  // its static client have completed the PROJ-1285 production rollout.
  return error instanceof Error
    && /Unrecognized key\(s\).*clientNonce/i.test(error.message)
}

async function sessionResponseEnvelope(
  envelope: ApiEnvelope<ApiSessionPayload>,
  scenarioId: string,
  mode: "guided" | "free_play",
  signal: AbortSignal,
): Promise<ShadowDemoEnvelope<ShadowDemoSessionResponse>> {
  const apiSession = envelope.payload.session
  const feedEnvelope = await requestApi<ApiFeedPayload>(
    feedPath(apiSession.sessionId, apiSession.currentEpochId, 12),
    { method: "GET" },
    signal,
    SHADOW_DEMO_REQUEST_TIMEOUT_MS,
    apiFeedEnvelopeSchema,
  )
  const currentEpochIndex = apiSession.epochs.findIndex((epoch) => epoch.id === apiSession.currentEpochId)
  const previousEpoch = currentEpochIndex > 0 ? apiSession.epochs[currentEpochIndex - 1] : null
  const currentEpoch = requiredEpoch(apiSession, apiSession.currentEpochId)
  const reranked = apiSession.phase === "epoch_advanced"
  const decisionEpochId = reranked ? currentEpoch.decidedByEpochId : currentEpoch.id
  if (feedEnvelope.payload.epochId !== currentEpoch.id) {
    throw new Error("The recovered demo feed does not match its authoritative epoch.")
  }
  return mapEnvelope(envelope, {
    session: mapSession(apiSession, scenarioId, mode),
    community: mapCommunity(apiSession.community, apiSession.corpusHealth),
    currentEpoch: mapCurrentEpoch(apiSession),
    previousEpoch: previousEpoch === null ? null : mapEpoch(previousEpoch),
    feed: mapFeed(feedEnvelope.payload, feedEnvelope.generatedAt),
    agents: apiSession.voterProfiles.map(mapAgent),
    agentVotes: apiSession.votes
      .filter((vote) => vote.epochId === decisionEpochId && vote.actorType === "synthetic_voter")
      .map(mapVote),
    pendingAggregate: reranked ? mapAggregate(currentEpoch.aggregate)
      : apiSession.pendingAggregate === null ? null : mapAggregate(apiSession.pendingAggregate),
    nextRecommendedAction: apiSession.phase === "created" ? "cast_reviewer_vote"
      : apiSession.phase === "reviewer_voted" ? "run_agent_votes"
        : apiSession.phase === "synthetic_voters_ran" ? "advance_epoch" : "select_post",
  })
}

async function requestApi<TPayload>(
  path: string,
  init: RequestInit,
  signal: AbortSignal,
  timeoutMs: number,
  schema: ZodType<ApiEnvelope<TPayload>>,
): Promise<ApiEnvelope<TPayload>> {
  const controller = new AbortController()
  let timedOut = false
  const abortFromParent = (): void => controller.abort(signal.reason)
  if (signal.aborted) abortFromParent()
  else signal.addEventListener("abort", abortFromParent, { once: true })
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort(new Error(`Shadow demo request timed out after ${timeoutMs}ms`))
  }, timeoutMs)

  try {
    let response: Response
    try {
      response = await fetch(apiUrl(path), {
        ...init,
        signal: controller.signal,
        cache: "no-store",
        headers: { "content-type": "application/json", ...init.headers },
      })
    } catch {
      throw new Error("The shadow demo service is temporarily unavailable.")
    }
    const body = await response.json().catch(() => null) as unknown
    if (!response.ok) {
      const message = body !== null && typeof body === "object" && "message" in body
        ? String((body as { message: unknown }).message)
        : `Shadow demo request failed with HTTP ${response.status}`
      throw new ShadowDemoHttpError(message, response.status)
    }
    const parsed = schema.safeParse(body)
    if (!parsed.success) {
      throw new Error("Shadow demo API returned an invalid response envelope.")
    }
    return parsed.data
  } catch (error) {
    if (timedOut) {
      throw new Error(`Shadow demo request timed out after ${timeoutMs}ms`)
    }
    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("Shadow demo request was cancelled")
    }
    throw error
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener("abort", abortFromParent)
  }
}

function mapEnvelope<TApiPayload, TViewPayload>(
  envelope: ApiEnvelope<TApiPayload>,
  payload: TViewPayload,
): ShadowDemoEnvelope<TViewPayload> {
  return {
    contractVersion: CONTRACT_VERSION,
    requestId: envelope.requestId,
    generatedAt: envelope.generatedAt,
    sessionId: envelope.sessionId,
    payload,
    warnings: envelope.warnings.map(mapWarning),
  }
}

function mapWarning(warning: ApiWarning): ShadowDemoWarning {
  return {
    code: warning.code,
    message: warning.message,
    recoverable: warning.severity !== "degraded",
  }
}

function mapSession(
  api: ApiSession,
  scenarioId: string,
  mode: "guided" | "free_play",
): ShadowDemoSession {
  const firstEpoch = api.epochs[0]
  return {
    id: api.sessionId,
    phase: mapPhase(api.phase),
    communityId: api.community.id,
    scenarioId,
    mode,
    seed: "server-seeded-replayable-electorate",
    createdAt: firstEpoch?.createdAt ?? api.expiresAt,
    expiresAt: api.expiresAt,
    sequence: api.epochs.length,
    guidedEpochs: api.guidedEpochs,
    maxEpochs: api.maxEpochs,
    isolation: {
      writesProductionGovernance: false,
      writesGovernanceVotes: false,
      writesGovernanceEpochs: false,
      writesResearchExports: false,
      writesProductionFeedCache: false,
      storageNamespace: "demo",
    },
    capabilities: {
      canCastReviewerVote: api.phase === "created" || api.phase === "reviewer_voted" || api.phase === "epoch_advanced",
      canRunAgents: api.phase === "reviewer_voted",
      canAdvanceEpoch: api.phase === "synthetic_voters_ran" && api.epochs.length < api.maxEpochs,
      canOpenNativeBlueskyFeed: api.sourceFeedUri !== undefined,
      canMutateNativeBlueskyFeed: false,
    },
    corpusProvenance: api.corpusProvenance,
    topicCatalog: api.topicCatalog,
    sourceFeedUri: api.sourceFeedUri ?? null,
    contentRulesEnabled: api.contentRulesEnabled,
    suggestedExcludeKeywords: api.suggestedExcludeKeywords,
  }
}

function mapPhase(phase: ApiSessionPayload["session"]["phase"]): ShadowDemoPhase {
  switch (phase) {
    case "created": return "corpus_ready"
    case "reviewer_voted": return "reviewer_vote_cast"
    case "synthetic_voters_ran": return "agent_votes_cast"
    case "epoch_advanced": return "reranked"
  }
}

function mapCommunity(community: ApiCommunity, health: ApiCorpusHealth): ShadowDemoCommunity {
  const source = corpusSourcePresentation(health.source)
  return {
    id: community.id,
    name: community.name,
    tagline: community.description,
    corpusStrategy: source.strategy,
    candidateTerms: [],
    bridgeTerms: [],
    publicBlueskyFeedUrl: source.hasPublicCommunityFeed
      ? "https://bsky.app/profile/corgi-network.bsky.social/feed/community-gov"
      : null,
  }
}

function mapEpoch(epoch: ApiEpoch): ShadowDemoEpoch {
  const totalVotes = epoch.aggregate.voteCount
  return {
    id: epoch.id,
    sequence: epoch.sequence,
    status: epoch.status === "open" ? "open" : "closed",
    label: epoch.label,
    weights: epoch.aggregate.weights,
    topicIntent: mapTopicIntent(epoch.aggregate.topicIntent),
    voteSummary: {
      reviewerVotes: totalVotes > 0 ? 1 : 0,
      agentVotes: Math.max(0, totalVotes - 1),
      totalVotes,
      aggregateMethod: "trimmed_mean_no_trim_under_10",
      trimCount: epoch.aggregate.trimCount,
      reviewerBallotShare: totalVotes > 0 ? 1 / totalVotes : 0,
      contentRules: epoch.aggregate.contentRules,
    },
    startedAt: epoch.createdAt,
    closedAt: epoch.advancedAt,
  }
}

function mapCurrentEpoch(api: ApiSessionPayload["session"]): ShadowDemoEpoch {
  const epoch = requiredEpoch(api, api.currentEpochId)
  if (epoch.status === "advanced") {
    return mapEpoch(epoch)
  }
  const status: ShadowDemoEpoch["status"] = api.phase === "synthetic_voters_ran"
    ? "agent_voting"
    : api.phase === "epoch_advanced"
      ? "published"
      : "open"
  return { ...mapEpoch(epoch), status }
}

function mapAggregate(summary: ApiVoteSummary): ShadowDemoAggregate {
  return {
    weights: summary.weights,
    topicIntent: mapTopicIntent(summary.topicIntent),
    voteSummary: {
      reviewerVotes: summary.voteCount > 0 ? 1 : 0,
      agentVotes: Math.max(0, summary.voteCount - 1),
      totalVotes: summary.voteCount,
      aggregateMethod: summary.aggregateMethod,
      trimCount: summary.trimCount,
      reviewerBallotShare: summary.voteCount > 0 ? 1 / summary.voteCount : 0,
      contentRules: summary.contentRules,
    },
  }
}

function mapAgent(profile: ApiVoterProfile): ShadowDemoAgent {
  return {
    id: profile.id,
    name: profile.label,
    role: `${profile.voterCount} scripted deterministic voter archetypes in this community bloc.`,
    deterministicSeed: `server:${profile.id}`,
    voteRationale: `Stable bloc preferences, ${Math.round(profile.policyInertia * 100)}% prior-policy inertia, and ${Math.round(profile.reviewerBlend * 100)}% bounded response to your proposal.`,
    voterCount: profile.voterCount,
    baseWeights: profile.baseWeights,
    reviewerBlend: profile.reviewerBlend,
    policyInertia: profile.policyInertia,
  }
}

function mapVote(vote: ApiVote): ShadowDemoVote {
  return {
    id: vote.id,
    epochId: vote.epochId,
    voterKind: vote.actorType === "reviewer" ? "reviewer" : "agent",
    voterId: vote.actorId,
    voterLabel: vote.label,
    weights: vote.weights,
    topicIntent: mapTopicIntent(vote.topicIntent),
    rationale: vote.actorType === "reviewer" ? "Your demo-only policy proposal." : `Deterministic ${vote.blocId} voter.`,
    castAt: vote.createdAt,
  }
}

function mapTopicIntent(intent: ShadowDemoTopicIntent): ShadowDemoTopicIntent {
  return { topicWeights: intent.topicWeights }
}

function mapFeed(payload: ApiFeedPayload, generatedAt: string): ShadowDemoFeed {
  const source = corpusSourcePresentation(payload.corpusHealth.source)
  const items = payload.posts.map((post) => mapFeedItem(post, payload.aggregate.weights))
  const publicItems = items.filter((item) => item.visibility === "public").length
  const visibleHiddenCount = items.filter((item) => item.visibility === "hidden").length
  const withheldCount = payload.corpusHealth.source === "production_feed_snapshot"
    && payload.corpusHealth.sourcePostCount !== undefined
    ? Math.max(0, payload.corpusHealth.sourcePostCount - payload.corpusHealth.publicScoredPosts)
    : visibleHiddenCount
  return {
    epochId: payload.epochId,
    corpusId: payload.corpusId,
    rankingSource: source.rankingSource,
    generatedAt,
    items,
    corpusProvenance: payload.corpusProvenance,
    aggregate: mapAggregate(payload.aggregate),
    corpusHealth: {
      status: payload.corpusHealth.status === "live" ? "live" : "fallback",
      candidatePostCount: payload.corpusHealth.candidatePosts72h,
      publicScoredPostCount: payload.corpusHealth.publicScoredPosts,
      displayedPublicPostCount: publicItems,
      displayedHiddenPostCount: withheldCount,
      uniqueAuthorCount: payload.corpusHealth.uniqueAuthors72h,
      collectedAt: payload.corpusHealth.sampledAt,
      frozenForSession: true,
      sourcePostCount: payload.corpusHealth.sourcePostCount ?? null,
      eligiblePostCount: payload.corpusHealth.eligiblePostCount ?? null,
      englishTaggedShare: payload.corpusHealth.englishTaggedShare ?? null,
      richMediaShare: payload.corpusHealth.richMediaShare ?? null,
    },
    withheldPosts: payload.withheldPosts?.map(mapWithheldPost),
  }
}

function mapWithheldPost(withheld: NonNullable<ApiFeedPayload["withheldPosts"]>[number]): ShadowDemoWithheldFeedItem {
  // The backend only withholds public posts (text-less/hidden posts pass the
  // exclude filter), but the display-post union is modeled faithfully so this
  // mapping stays correct if that ever changes.
  if (withheld.post.kind === "hidden_post") {
    return {
      keyword: withheld.keyword,
      supportCount: withheld.supportCount,
      previousRank: withheld.previousRank,
      post: null,
      hiddenReason: withheld.post.reason,
    }
  }
  return {
    keyword: withheld.keyword,
    supportCount: withheld.supportCount,
    previousRank: withheld.previousRank,
    post: {
      uri: withheld.post.uri,
      cid: withheld.post.cid,
      bskyUrl: withheld.post.bskyUrl,
      authorDid: withheld.post.authorDid,
      authorHandle: withheld.post.authorHandle,
      authorDisplayName: withheld.post.authorDisplayName,
      authorAvatar: withheld.post.authorAvatar,
      text: withheld.post.text,
      indexedAt: withheld.post.indexedAt,
      createdAt: withheld.post.createdAt,
      likeCount: withheld.post.likeCount,
      repostCount: withheld.post.repostCount,
      replyCount: withheld.post.replyCount,
      quoteCount: withheld.post.quoteCount,
      labels: [],
      languages: withheld.post.languages ?? [],
      media: withheld.post.media ?? null,
    },
    hiddenReason: null,
  }
}

export function corpusSourcePresentation(source: ApiCorpusHealth["source"]): {
  strategy: ShadowDemoCommunity["corpusStrategy"]
  rankingSource: ShadowDemoFeed["rankingSource"]
  hasPublicCommunityFeed: boolean
} {
  switch (source) {
    case "production_feed_snapshot":
      return {
        strategy: "published_feed_snapshot",
        rankingSource: "live_public_posts_shadow_weights",
        hasPublicCommunityFeed: true,
      }
    case "production_scores_appview":
      return {
        strategy: "live_appview_search",
        rankingSource: "live_public_posts_shadow_weights",
        hasPublicCommunityFeed: false,
      }
    case "fixture_fallback":
      return {
        strategy: "fixture_fallback",
        rankingSource: "fixture_posts_shadow_weights",
        hasPublicCommunityFeed: false,
      }
  }
}

function mapFeedItem(post: ApiRankedPost, weights: ShadowDemoWeights): ShadowDemoFeedItem {
  const movement = movementFor(post.movement)
  if (post.post.kind === "hidden_post") {
    return {
      visibility: "hidden",
      rank: post.rank,
      publishedRank: post.publishedRank ?? null,
      publishedScore: post.publishedScore ?? null,
      previousRank: post.previousRank,
      movement,
      post: null,
      score: null,
      hiddenReason: hiddenReason(post.post.reason),
      labels: [],
    }
  }
  if (post.score === null || post.rawScores === null || post.weightedComponents === null) {
    return {
      visibility: "hidden",
      rank: post.rank,
      publishedRank: post.publishedRank ?? null,
      publishedScore: post.publishedScore ?? null,
      previousRank: post.previousRank,
      movement,
      post: null,
      score: null,
      hiddenReason: "missing_text",
      labels: [],
    }
  }
  return {
    visibility: "public",
    rank: post.rank,
    publishedRank: post.publishedRank ?? null,
    publishedScore: post.publishedScore ?? null,
    previousRank: post.previousRank,
    movement,
    post: {
      uri: post.post.uri,
      cid: post.post.cid,
      bskyUrl: post.post.bskyUrl,
      authorDid: post.post.authorDid,
      authorHandle: post.post.authorHandle,
      authorDisplayName: post.post.authorDisplayName,
      authorAvatar: post.post.authorAvatar,
      text: post.post.text,
      indexedAt: post.post.indexedAt,
      createdAt: post.post.createdAt,
      likeCount: post.post.likeCount,
      repostCount: post.post.repostCount,
      replyCount: post.post.replyCount,
      quoteCount: post.post.quoteCount,
      labels: [],
      languages: post.post.languages ?? [],
      media: post.post.media ?? null,
    },
    score: {
      total: post.score,
      componentTotal: post.componentScore ?? null,
      publicationAdjustment: post.publicationAdjustment ?? null,
      components: SHADOW_DEMO_SIGNAL_KEYS.map((key) => ({
        key,
        label: SIGNAL_LABELS[key],
        rawScore: post.rawScores?.[key] ?? 0,
        weight: weights[key],
        contribution: post.weightedComponents?.[key] ?? 0,
      })),
    },
  }
}

function movementFor(delta: number | null): { delta: number; label: "new" | "same" | "up" | "down" } {
  if (delta === null) return { delta: 0, label: "new" }
  if (delta === 0) return { delta: 0, label: "same" }
  return { delta, label: delta > 0 ? "up" : "down" }
}

export function hiddenReason(reason: string): "no_unauthenticated" | "hide_label" | "adult_label" | "deleted_or_unavailable" | "missing_text" {
  if (reason.startsWith("Hidden by Bluesky public-view label !no-unauthenticated")) return "no_unauthenticated"
  if (reason.startsWith("Hidden by Bluesky public-view label !hide")) return "hide_label"
  if (reason.startsWith("Hidden by Bluesky adult-content label ")) return "adult_label"
  if (reason === "Post text unavailable from Bluesky public AppView") return "missing_text"
  if (
    reason === "Post unavailable from Bluesky public AppView"
    || reason === "Post metadata unavailable from Bluesky public AppView"
  ) return "deleted_or_unavailable"
  return "deleted_or_unavailable"
}

function mapReceipt(receipt: ApiReceiptPayload["receipt"], generatedAt: string): ShadowDemoReceipt {
  return {
    postUri: receipt.postUri,
    epochId: receipt.epochId,
    visibleRank: receipt.visibleRank,
    previousRank: receipt.previousRank,
    totalScore: receipt.score,
    componentScore: receipt.componentScore ?? null,
    publicationAdjustment: receipt.publicationAdjustment ?? null,
    publishedRank: receipt.publishedRank ?? null,
    publishedScore: receipt.publishedScore ?? null,
    scoredAt: receipt.scoredAt,
    aggregate: mapAggregate(receipt.aggregate),
    reviewerBallotShare: receipt.reviewerBallotShare,
    components: receipt.components.map((component) => ({
      key: component.signal,
      label: SIGNAL_LABELS[component.signal],
      rawScore: component.rawScore,
      weight: component.weight,
      contribution: component.contribution,
    })),
    topicBreakdown: receipt.topicRelevanceFormula.terms.map((term) => ({
      slug: term.topic,
      label: topicLabel(term.topic),
      postScore: term.postScore,
      communityWeight: term.communityWeight,
      contribution: term.weightedTerm,
    })),
    topicRelevanceFormula: receipt.topicRelevanceFormula,
    provenance: receipt.provenance,
    counterfactuals: receipt.counterfactuals.map(mapCounterfactual),
    generatedAt,
    explanationKind: "shadow_demo_receipt",
    contentRules: receipt.contentRules,
  }
}

function mapCounterfactual(item: ApiReceiptPayload["receipt"]["counterfactuals"][number]): ShadowDemoCounterfactual {
  const id = item.label === "previous_epoch" ? "prior_epoch" : item.label
  const label = item.label === "previous_epoch"
    ? "Prior epoch"
    : item.label === "engagement_only"
      ? "Engagement-only ranking"
      : "Direct reviewer ballot removed"
  return { id, label, description: item.description, rank: item.rank, deltaFromVisibleRank: item.deltaFromVisible }
}

function topicLabel(slug: string): string {
  return slug.split("-").map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(" ")
}

function requiredEpoch(session: ApiSession, epochId: string): ApiEpoch {
  const epoch = session.epochs.find((candidate) => candidate.id === epochId)
  if (epoch === undefined) throw new Error(`Shadow demo response omitted epoch ${epochId}.`)
  return epoch
}

function feedPath(sessionId: string, epochId: string, limit: number): string {
  const query = new URLSearchParams({ epochId, limit: String(limit) })
  return `${sessionPath(sessionId)}/feed?${query.toString()}`
}

function receiptPath(sessionId: string, request: ShadowDemoReceiptRequest): string {
  const query = new URLSearchParams({ epochId: request.epochId, postUri: request.postUri })
  return `${sessionPath(sessionId)}/receipts?${query.toString()}`
}

function sessionPath(sessionId: string): string {
  return `${SHADOW_DEMO_ENDPOINTS.createSession}/${encodeURIComponent(sessionId)}`
}

function mutationPath(sessionId: string, suffix: "votes" | "agents/run" | "epochs/advance"): string {
  return `${sessionPath(sessionId)}/${suffix}`
}

function apiUrl(path: string): string {
  const base = process.env.NEXT_PUBLIC_CORGI_API_BASE_URL?.replace(/\/$/, "") ?? ""
  return `${base}${path}`
}
