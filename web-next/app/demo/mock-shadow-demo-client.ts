// Deterministic mock implementation of ShadowDemoClient.
//
// This is a test-only in-memory implementation of the `/api/demo/*` contract.
// The product path uses the HTTP client. The mock writes nothing anywhere and
// remains deterministic so contract and ranking tests are replayable.
// Timestamps/ids come from an injectable monotonic clock so tests are stable.
//
// Epoch model (gives a crisp before/after "aha"): the OPEN epoch keeps the
// baseline (engagement-heavy) policy that the feed currently uses. Reviewer +
// agent votes accumulate into it but do NOT rerank the visible feed. Only
// `advanceEpoch` closes it and opens a new epoch with the aggregated policy,
// reranking the frozen corpus — so feedBefore/feedAfter is the reorder.

import {
  type AdvanceShadowDemoEpochRequest,
  type AdvanceShadowDemoEpochResponse,
  type CastShadowDemoVoteRequest,
  type CastShadowDemoVoteResponse,
  type CreateShadowDemoSessionRequest,
  type RunShadowDemoAgentsRequest,
  type RunShadowDemoAgentsResponse,
  type ShadowDemoAction,
  type ShadowDemoClient,
  type ShadowDemoEnvelope,
  type ShadowDemoEpoch,
  type ShadowDemoFeed,
  type ShadowDemoFeedRequest,
  type ShadowDemoPhase,
  type ShadowDemoReceipt,
  type ShadowDemoReceiptRequest,
  type ShadowDemoReceiptResponse,
  type ShadowDemoSession,
  type ShadowDemoSessionResponse,
  type ShadowDemoVote,
  type ShadowDemoWarning,
  type ShadowDemoWeights,
} from "./shadow-demo-view-model"
import { CONTRACT_VERSION } from "./shadow-demo-api-schemas"
import {
  BASELINE_TOPIC_INTENT,
  BASELINE_WEIGHTS,
  buildCounterfactuals,
  CORPUS_COLLECTED_AT,
  DEMO_AGENTS,
  getCommunityFixture,
  normalizeWeights,
  rankCorpus,
  rankedIds,
  topicBreakdownFor,
  trimmedVoterAverage,
  type DemoCommunityFixture,
  type DemoCorpusEntry,
} from "./shadow-demo-fixtures"

export class ShadowDemoClientError extends Error {
  constructor(
    message: string,
    readonly kind: "not_found" | "invalid_phase" | "stale_epoch" | "invalid_request" | "unknown_post",
  ) {
    super(message)
    this.name = "ShadowDemoClientError"
  }
}

interface SessionState {
  session: ShadowDemoSession
  readonly fixture: DemoCommunityFixture
  readonly corpus: readonly DemoCorpusEntry[]
  reviewerVote: ShadowDemoVote | null
  agentVotes: readonly ShadowDemoVote[]
  /** Epoch currently accepting votes / applied to the feed. */
  openEpoch: ShadowDemoEpoch
  /** Set once the epoch is advanced. */
  publishedEpoch: ShadowDemoEpoch | null
  /** Rank map of the currently-applied feed (baseline, then aggregate after advance). */
  currentRankById: Readonly<Record<string, number>>
  baselineRankById: Readonly<Record<string, number>>
  readonly idempotency: Map<string, unknown>
}

type IdempotentOperation = "vote" | "synthetic_voters" | "advance_epoch"

const ISOLATION = {
  writesProductionGovernance: false,
  writesGovernanceVotes: false,
  writesGovernanceEpochs: false,
  writesResearchExports: false,
  writesProductionFeedCache: false,
  storageNamespace: "demo",
} as const

const CAPABILITIES = {
  canCastReviewerVote: true,
  canRunAgents: true,
  canAdvanceEpoch: true,
  canOpenNativeBlueskyFeed: false,
  canMutateNativeBlueskyFeed: false,
} as const

function nextRecommendedActionFor(phase: ShadowDemoPhase): ShadowDemoAction {
  switch (phase) {
    case "corpus_ready":
      return "cast_reviewer_vote"
    case "reviewer_vote_cast":
      return "run_agent_votes"
    case "agent_votes_cast":
      return "advance_epoch"
    case "epoch_transitioned":
    case "reranked":
      return "select_post"
    default:
      return "create_session"
  }
}

export interface MockShadowDemoClientOptions {
  /** Monotonic epoch-millis source; defaults to a deterministic counter. */
  readonly now?: () => number
}

export function createMockShadowDemoClient(options: MockShadowDemoClientOptions = {}): ShadowDemoClient {
  const sessions = new Map<string, SessionState>()
  let counter = 0
  const baseMs = Date.parse(CORPUS_COLLECTED_AT)
  const now = options.now ?? (() => baseMs + counter * 1000)
  const nextId = (prefix: string): string => {
    counter += 1
    return `${prefix}_${counter}`
  }
  const iso = (): string => new Date(now()).toISOString()

  function envelope<T>(sessionId: string | null, payload: T, warnings: readonly ShadowDemoWarning[] = []): ShadowDemoEnvelope<T> {
    return {
      contractVersion: CONTRACT_VERSION,
      requestId: nextId("req"),
      generatedAt: iso(),
      sessionId,
      payload,
      warnings,
    }
  }

  function requireSession(sessionId: string): SessionState {
    const state = sessions.get(sessionId)
    if (state === undefined) {
      throw new ShadowDemoClientError(`Unknown demo session: ${sessionId}`, "not_found")
    }
    return state
  }

  function throwIfAborted(signal: AbortSignal): void {
    if (!signal.aborted) return
    if (signal.reason instanceof Error) throw signal.reason
    throw new DOMException("The operation was aborted.", "AbortError")
  }

  function buildFeed(state: SessionState, weights: ShadowDemoWeights, previousRankById: Readonly<Record<string, number>> | null): ShadowDemoFeed {
    const { items } = rankCorpus(state.corpus, weights, previousRankById)
    const publicEntries = state.corpus.filter((entry) => entry.hidden === undefined)
    const hiddenEntries = state.corpus.filter((entry) => entry.hidden !== undefined)
    const uniqueAuthors = new Set(publicEntries.map((entry) => entry.post.authorHandle))
    return {
      epochId: state.publishedEpoch?.id ?? state.openEpoch.id,
      corpusId: `demo_corpus_${state.session.id}`,
      rankingSource: "fixture_posts_shadow_weights",
      generatedAt: iso(),
      items,
      corpusProvenance: state.session.corpusProvenance,
      aggregate: {
        weights,
        topicIntent: state.publishedEpoch?.topicIntent ?? state.openEpoch.topicIntent,
        voteSummary: state.publishedEpoch?.voteSummary ?? state.openEpoch.voteSummary,
      },
      corpusHealth: {
        status: "fallback",
        candidatePostCount: state.corpus.length,
        publicScoredPostCount: publicEntries.length,
        displayedPublicPostCount: publicEntries.length,
        displayedHiddenPostCount: hiddenEntries.length,
        uniqueAuthorCount: uniqueAuthors.size,
        collectedAt: CORPUS_COLLECTED_AT,
        frozenForSession: true,
      },
    }
  }

  function appliedWeights(state: SessionState): ShadowDemoWeights {
    return state.publishedEpoch ? state.publishedEpoch.weights : state.openEpoch.weights
  }

  function currentFeed(state: SessionState): ShadowDemoFeed {
    if (state.publishedEpoch) {
      return buildFeed(state, state.publishedEpoch.weights, state.baselineRankById)
    }
    return buildFeed(state, state.openEpoch.weights, null)
  }

  function sessionResponse(state: SessionState): ShadowDemoSessionResponse {
    return {
      session: state.session,
      community: state.fixture.community,
      currentEpoch: state.publishedEpoch ?? state.openEpoch,
      previousEpoch: state.publishedEpoch ? state.openEpoch : null,
      feed: currentFeed(state),
      nextRecommendedAction: nextRecommendedActionFor(state.session.phase),
      agents: DEMO_AGENTS.map((entry) => entry.agent),
      agentVotes: state.agentVotes,
      pendingAggregate: state.agentVotes.length === 0 ? null : {
        weights: state.publishedEpoch?.weights ?? trimmedVoterAverage([
          state.reviewerVote?.weights ?? state.openEpoch.weights,
          ...state.agentVotes.map((vote) => vote.weights),
        ]),
        topicIntent: state.publishedEpoch?.topicIntent ?? BASELINE_TOPIC_INTENT,
        voteSummary: (state.publishedEpoch ?? state.openEpoch).voteSummary,
      },
    }
  }

  function advanceSequence(state: SessionState, phase: ShadowDemoPhase): void {
    state.session = { ...state.session, phase, sequence: state.session.sequence + 1 }
  }

  function operationKey(operation: IdempotentOperation, key: string): string {
    return `${operation}:${key}`
  }

  /** Return a cached idempotent response if this operation and key were already applied. */
  function replay<T>(state: SessionState, operation: IdempotentOperation, key: string): ShadowDemoEnvelope<T> | null {
    const cached = state.idempotency.get(operationKey(operation, key))
    if (cached === undefined) {
      return null
    }
    const envelopeCopy = cached as ShadowDemoEnvelope<T>
    return {
      ...envelopeCopy,
      warnings: [
        { code: "demo_state_replayed", message: "This action was already applied; returning the same demo state.", recoverable: true },
      ],
    }
  }

  const client: ShadowDemoClient = {
    async createSession(request: CreateShadowDemoSessionRequest, signal: AbortSignal) {
      throwIfAborted(signal)
      const fixture = getCommunityFixture(request.communityId)
      if (fixture.isPreview || fixture.corpus.length === 0) {
        throw new ShadowDemoClientError(`Community not available in this demo pass: ${request.communityId}`, "invalid_request")
      }
      const sessionId = nextId("demo_sess")
      const openEpoch: ShadowDemoEpoch = {
        id: nextId("demo_epoch"),
        sequence: 1,
        status: "open",
        label: "Baseline policy",
        weights: BASELINE_WEIGHTS,
        topicIntent: BASELINE_TOPIC_INTENT,
        voteSummary: {
          reviewerVotes: 0,
          agentVotes: 0,
          totalVotes: 0,
          aggregateMethod: "trimmed_mean_no_trim_under_10",
          trimCount: 0,
          reviewerBallotShare: 0,
        },
        startedAt: iso(),
        closedAt: null,
      }
      const baselineRankById: Record<string, number> = {}
      rankedIds(fixture.corpus, BASELINE_WEIGHTS).forEach((id, index) => {
        baselineRankById[id] = index + 1
      })
      const session: ShadowDemoSession = {
        id: sessionId,
        phase: "corpus_ready",
        communityId: request.communityId,
        scenarioId: request.scenarioId,
        mode: request.mode,
        seed: `seed_${request.communityId}_${request.scenarioId}_${request.clientNonce}`,
        createdAt: iso(),
        expiresAt: new Date(now() + 30 * 60_000).toISOString(),
        sequence: 1,
        guidedEpochs: 5,
        maxEpochs: 10,
        isolation: ISOLATION,
        capabilities: CAPABILITIES,
        corpusProvenance: {
          mode: "illustrative_fixture_session_frozen",
          label: "Illustrative mechanics fixture",
          description: "Illustrative fallback frozen for deterministic mock verification.",
          corpusId: `demo_corpus_${sessionId}`,
          productionEpochId: 0,
          sampledAt: CORPUS_COLLECTED_AT,
          windowHours: 72,
          topicScoreThreshold: 0.5,
          eligiblePostCount: fixture.corpus.length,
        },
        topicCatalog: fixture.topics.map((topic) => ({
          slug: topic.slug,
          name: topic.label,
          description: null,
          baselineWeight: topic.baselineWeight,
        })),
      }
      const state: SessionState = {
        session,
        fixture,
        corpus: fixture.corpus,
        reviewerVote: null,
        agentVotes: [],
        openEpoch,
        publishedEpoch: null,
        currentRankById: baselineRankById,
        baselineRankById,
        idempotency: new Map(),
      }
      sessions.set(sessionId, state)
      return envelope(sessionId, sessionResponse(state))
    },

    async getSession(sessionId: string, signal: AbortSignal) {
      throwIfAborted(signal)
      const state = requireSession(sessionId)
      return envelope(sessionId, sessionResponse(state))
    },

    async castVote(sessionId: string, request: CastShadowDemoVoteRequest, signal: AbortSignal) {
      throwIfAborted(signal)
      const state = requireSession(sessionId)
      const replayed = replay<CastShadowDemoVoteResponse>(state, "vote", request.idempotencyKey)
      if (replayed) {
        return replayed
      }
      validateMockTopicIntent(state, request.topicIntent)
      if (
        state.session.phase === "reranked" &&
        state.publishedEpoch !== null &&
        request.baseEpochId === state.publishedEpoch.id
      ) {
        state.openEpoch = {
          ...state.publishedEpoch,
          status: "open",
          closedAt: null,
          voteSummary: {
            reviewerVotes: 0,
            agentVotes: 0,
            totalVotes: 0,
            aggregateMethod: "trimmed_mean_no_trim_under_10",
            trimCount: 0,
            reviewerBallotShare: 0,
          },
        }
        state.publishedEpoch = null
        state.baselineRankById = { ...state.currentRankById }
        state.reviewerVote = null
        state.agentVotes = []
        state.session = { ...state.session, phase: "corpus_ready" }
      }
      if (state.session.phase !== "corpus_ready" && state.session.phase !== "reviewer_vote_cast") {
        throw new ShadowDemoClientError(`Cannot cast a vote from phase "${state.session.phase}"`, "invalid_phase")
      }
      if (request.baseEpochId !== state.openEpoch.id) {
        throw new ShadowDemoClientError("Stale epoch: the demo has moved on. Reset to try again.", "stale_epoch")
      }
      const weights = normalizeWeights(request.weights)
      const reviewerVote: ShadowDemoVote = {
        id: nextId("vote"),
        epochId: state.openEpoch.id,
        voterKind: "reviewer",
        voterId: "reviewer",
        voterLabel: request.voterLabel,
        weights,
        topicIntent: request.topicIntent,
        rationale: "Reviewer's demo-only policy choice.",
        castAt: iso(),
      }
      state.reviewerVote = reviewerVote
      state.openEpoch = {
        ...state.openEpoch,
        voteSummary: {
          ...state.openEpoch.voteSummary,
          reviewerVotes: 1,
          totalVotes: 1 + state.agentVotes.length,
          reviewerBallotShare: 1 / (1 + state.agentVotes.length),
        },
      }
      advanceSequence(state, "reviewer_vote_cast")
      const payload: CastShadowDemoVoteResponse = {
        session: state.session,
        reviewerVote,
        currentEpoch: state.openEpoch,
        nextRecommendedAction: "run_agent_votes",
      }
      const result = envelope(sessionId, payload)
      state.idempotency.set(operationKey("vote", request.idempotencyKey), result)
      return result
    },

    async runAgents(sessionId: string, request: RunShadowDemoAgentsRequest, signal: AbortSignal) {
      throwIfAborted(signal)
      const state = requireSession(sessionId)
      const replayed = replay<RunShadowDemoAgentsResponse>(state, "synthetic_voters", request.idempotencyKey)
      if (replayed) {
        return replayed
      }
      if (state.session.phase !== "reviewer_vote_cast") {
        throw new ShadowDemoClientError("Cast the reviewer vote before running agents.", "invalid_phase")
      }
      if (request.baseEpochId !== state.openEpoch.id) {
        throw new ShadowDemoClientError("Stale epoch: the demo has moved on. Reset to try again.", "stale_epoch")
      }
      const selected = DEMO_AGENTS
      const agents = selected.map((entry) => entry.agent)
      const agentVotes: ShadowDemoVote[] = selected.flatMap((entry) =>
        Array.from({ length: entry.agent.voterCount }, (_unused, voterIndex) => ({
          id: nextId("vote"),
          epochId: state.openEpoch.id,
          voterKind: "agent" as const,
          voterId: `synthetic-${entry.agent.id}-${voterIndex + 1}`,
          voterLabel: `${entry.agent.name} voter ${voterIndex + 1}`,
          weights: normalizeWeights(entry.weights),
          topicIntent: BASELINE_TOPIC_INTENT,
          rationale: entry.agent.voteRationale,
          castAt: iso(),
        })),
      )
      state.agentVotes = agentVotes
      state.openEpoch = {
        ...state.openEpoch,
        status: "agent_voting",
        voteSummary: {
          reviewerVotes: 1,
          agentVotes: agentVotes.length,
          totalVotes: 1 + agentVotes.length,
          aggregateMethod: "trimmed_mean_no_trim_under_10",
          trimCount: 2,
          reviewerBallotShare: 1 / (1 + agentVotes.length),
        },
      }
      advanceSequence(state, "agent_votes_cast")
      const payload: RunShadowDemoAgentsResponse = {
        session: state.session,
        agents,
        agentVotes,
        currentEpoch: state.openEpoch,
        pendingAggregate: {
          weights: trimmedVoterAverage([
            state.reviewerVote?.weights ?? state.openEpoch.weights,
            ...agentVotes.map((vote) => vote.weights),
          ]),
          topicIntent: BASELINE_TOPIC_INTENT,
          voteSummary: state.openEpoch.voteSummary,
        },
        nextRecommendedAction: "advance_epoch",
      }
      const result = envelope(sessionId, payload)
      state.idempotency.set(operationKey("synthetic_voters", request.idempotencyKey), result)
      return result
    },

    async advanceEpoch(sessionId: string, request: AdvanceShadowDemoEpochRequest, signal: AbortSignal) {
      throwIfAborted(signal)
      const state = requireSession(sessionId)
      const replayed = replay<AdvanceShadowDemoEpochResponse>(state, "advance_epoch", request.idempotencyKey)
      if (replayed) {
        return replayed
      }
      if (state.session.phase !== "agent_votes_cast") {
        throw new ShadowDemoClientError("Run the agent votes before advancing the epoch.", "invalid_phase")
      }
      if (request.fromEpochId !== state.openEpoch.id) {
        throw new ShadowDemoClientError("Stale epoch: the demo has moved on. Reset to try again.", "stale_epoch")
      }
      if (state.reviewerVote === null) {
        throw new ShadowDemoClientError("No reviewer vote recorded.", "invalid_request")
      }
      const feedBefore = buildFeed(state, state.openEpoch.weights, null)
      const aggregate = trimmedVoterAverage([
        state.reviewerVote.weights,
        ...state.agentVotes.map((vote) => vote.weights),
      ])
      const closedEpoch: ShadowDemoEpoch = {
        ...state.openEpoch,
        status: "closed",
        closedAt: iso(),
      }
      const publishedEpoch: ShadowDemoEpoch = {
        id: nextId("demo_epoch"),
        sequence: state.openEpoch.sequence + 1,
        status: "published",
        label: "Community-aggregated policy",
        weights: aggregate,
        topicIntent: state.reviewerVote.topicIntent,
        voteSummary: {
          reviewerVotes: 1,
          agentVotes: state.agentVotes.length,
          totalVotes: 1 + state.agentVotes.length,
          aggregateMethod: "trimmed_mean_no_trim_under_10",
          trimCount: 2,
          reviewerBallotShare: 1 / (1 + state.agentVotes.length),
        },
        startedAt: iso(),
        closedAt: null,
      }
      state.openEpoch = closedEpoch
      state.publishedEpoch = publishedEpoch
      const feedAfter = buildFeed(state, publishedEpoch.weights, state.baselineRankById)
      const aggregateRankById: Record<string, number> = {}
      rankedIds(state.corpus, publishedEpoch.weights).forEach((id, index) => {
        aggregateRankById[id] = index + 1
      })
      state.currentRankById = aggregateRankById
      advanceSequence(state, "reranked")
      const payload: AdvanceShadowDemoEpochResponse = {
        session: state.session,
        previousEpoch: closedEpoch,
        currentEpoch: publishedEpoch,
        feedBefore,
        feedAfter,
        nextRecommendedAction: "select_post",
      }
      const result = envelope(sessionId, payload)
      state.idempotency.set(operationKey("advance_epoch", request.idempotencyKey), result)
      return result
    },

    async getFeed(sessionId: string, request: ShadowDemoFeedRequest, signal: AbortSignal) {
      throwIfAborted(signal)
      if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 100) {
        throw new ShadowDemoClientError("Feed limit must be an integer between 1 and 100.", "invalid_request")
      }
      const state = requireSession(sessionId)
      const publishedEpoch = state.publishedEpoch
      const isPublished = publishedEpoch?.id === request.epochId
      const isOpen = state.openEpoch.id === request.epochId
      if (!isPublished && !isOpen) {
        throw new ShadowDemoClientError("That epoch is not part of this demo session.", "stale_epoch")
      }
      const weights = isPublished && publishedEpoch !== null ? publishedEpoch.weights : state.openEpoch.weights
      const previous = isPublished ? state.baselineRankById : null
      const feed = buildFeed(state, weights, previous)
      const items = feed.items.slice(0, request.limit)
      return envelope(sessionId, {
        ...feed,
        epochId: request.epochId,
        items,
        corpusHealth: {
          ...feed.corpusHealth,
          displayedPublicPostCount: items.filter((item) => item.visibility === "public").length,
          displayedHiddenPostCount: items.filter((item) => item.visibility === "hidden").length,
        },
      })
    },

    async getReceipt(sessionId: string, request: ShadowDemoReceiptRequest, signal: AbortSignal) {
      throwIfAborted(signal)
      const state = requireSession(sessionId)
      const isPublished = state.publishedEpoch?.id === request.epochId
      const isOpen = state.openEpoch.id === request.epochId
      if (!isPublished && !isOpen) {
        throw new ShadowDemoClientError("That epoch is not part of this demo session.", "stale_epoch")
      }
      const selectedEpoch = isPublished && state.publishedEpoch !== null
        ? state.publishedEpoch
        : state.openEpoch
      const entry = state.corpus.find((candidate) => candidate.post.uri === request.postUri)
      if (entry === undefined) {
        throw new ShadowDemoClientError("That post is not part of this demo session's frozen corpus.", "unknown_post")
      }
      if (entry.hidden) {
        throw new ShadowDemoClientError("This row is withheld from the public view and has no public receipt.", "unknown_post")
      }
      const weights = selectedEpoch.weights
      const order = rankedIds(state.corpus, weights)
      const visibleRank = order.indexOf(entry.id) + 1
      const previousRank = isPublished ? (state.baselineRankById[entry.id] ?? null) : null
      const { items } = rankCorpus(state.corpus, weights, isPublished ? state.baselineRankById : null)
      const feedItem = items.find((item) => item.visibility === "public" && item.post.uri === request.postUri)
      const score = feedItem && feedItem.visibility === "public" ? feedItem.score : null
      if (score === null) {
        throw new ShadowDemoClientError("No score available for that post.", "unknown_post")
      }

      const topicIntent = selectedEpoch.topicIntent
      const agentsOnlyWeights = state.agentVotes.length > 0
        ? trimmedVoterAverage(state.agentVotes.map((vote) => vote.weights))
        : BASELINE_WEIGHTS
      const topicBreakdown = topicBreakdownFor(entry, state.fixture.topics, topicIntent)
      const weightedSum = topicBreakdown.reduce((sum, topic) => sum + topic.contribution, 0)
      const signalSum = topicBreakdown.reduce((sum, topic) => sum + topic.postScore, 0)
      const baseRelevance = signalSum > 0 ? weightedSum / signalSum : entry.rawScores.relevance

      const receipt: ShadowDemoReceipt = {
        postUri: entry.post.uri,
        epochId: request.epochId,
        visibleRank,
        previousRank,
        totalScore: score.total,
        scoredAt: iso(),
        aggregate: {
          weights,
          topicIntent,
          voteSummary: selectedEpoch.voteSummary,
        },
        reviewerBallotShare: selectedEpoch.voteSummary.reviewerBallotShare,
        components: score.components,
        topicBreakdown,
        topicRelevanceFormula: {
          formulaApplied: true,
          defaultTopicWeight: 0.5,
          confidenceThreshold: 0.6,
          weightedSum,
          signalSum,
          baseRelevance,
          confidenceMultiplier: 1,
          effectiveRelevance: baseRelevance,
          usedDefaultWeight: false,
          terms: topicBreakdown.map((topic) => ({
            topic: topic.slug,
            postScore: topic.postScore,
            communityWeight: topic.communityWeight,
            weightedTerm: topic.contribution,
            usedDefaultWeight: false,
          })),
        },
        provenance: {
          ...state.session.corpusProvenance,
          shadowEpochId: request.epochId,
          postInclusionReasons: {
            matchedTopics: Object.entries(entry.topicAffinity).map(([topic, value]) => ({ topic, score: value ?? 0 })),
            matchedTerms: [],
          },
        },
        counterfactuals: buildCounterfactuals({
          corpus: state.corpus,
          postId: entry.id,
          visibleRank,
          currentWeights: weights,
          priorWeights: isPublished ? state.openEpoch.weights : BASELINE_WEIGHTS,
          agentsOnlyWeights,
        }),
        generatedAt: iso(),
        explanationKind: "shadow_demo_receipt",
      }
      const payload: ShadowDemoReceiptResponse = { session: state.session, receipt }
      return envelope(sessionId, payload)
    },
  }

  return client
}

function validateMockTopicIntent(state: SessionState, topicIntent: CastShadowDemoVoteRequest["topicIntent"]): void {
  const catalogSlugs = (state.session.topicCatalog ?? []).map((topic) => topic.slug)
  const submittedEntries = Object.entries(topicIntent.topicWeights)
  if (catalogSlugs.length === 0 || new Set(catalogSlugs).size !== catalogSlugs.length) {
    throw new ShadowDemoClientError("The frozen topic catalog must contain unique topic slugs.", "invalid_request")
  }
  if (
    submittedEntries.length !== catalogSlugs.length
    || submittedEntries.some(([slug, weight]) => !catalogSlugs.includes(slug) || !Number.isFinite(weight) || weight < 0 || weight > 1)
  ) {
    throw new ShadowDemoClientError("The vote must include the complete frozen topic catalog.", "invalid_request")
  }
}
