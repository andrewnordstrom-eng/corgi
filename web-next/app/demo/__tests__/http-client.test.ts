import { afterEach, describe, expect, it, vi } from "vitest"
import { corpusSourcePresentation, createHttpShadowDemoClient, hiddenReason } from "../http-shadow-demo-client"
import { type ShadowDemoWeights } from "../shadow-demo-contract"
import {
  apiReceiptComponentsSchema,
  apiReceiptPayloadSchema,
  apiPostMediaSchema,
  apiSessionPayloadSchema,
  apiSyntheticVoteSchema,
  CONTRACT_VERSION,
} from "../shadow-demo-api-schemas"

const NOW = "2026-07-10T05:00:00.000Z"
const SESSION_ID = "demo-http-contract"
const BASE_WEIGHTS: ShadowDemoWeights = {
  recency: 0.2,
  engagement: 0.2,
  bridging: 0.2,
  source_diversity: 0.2,
  relevance: 0.2,
}
const NEXT_WEIGHTS: ShadowDemoWeights = {
  recency: 0.12,
  engagement: 0.08,
  bridging: 0.3,
  source_diversity: 0.2,
  relevance: 0.3,
}
const TOPIC_INTENT = {
  topicWeights: {
    "science-research": 0.9,
    "data-science": 0.8,
    "software-development": 0.7,
    "open-source": 0.75,
  },
}
const PRODUCTION_TOPIC_INTENT = {
  topicWeights: {
    "adult-content": 0, "ai-machine-learning": 0.7, "art-creative": 0.2, "books-reading": 0.2,
    "climate-environment": 0.3, "cooking-food": 0.2, cybersecurity: 0.7, "data-science": 0.8,
    "decentralized-social": 0.9, "design-ux": 0.4, "devops-infrastructure": 0.6, "dogs-pets": 0.5,
    education: 0.4, gaming: 0.1, "health-fitness": 0.2, "mobile-development": 0.4,
    music: 0.1, "news-journalism": 0.1, "open-source": 0.75, "politics-governance": 0.1,
    "science-research": 0.9, "software-development": 0.7, "space-astronomy": 0.3,
    "startups-business": 0.3, "systems-programming": 0.6, "web-development": 0.6,
  },
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("HTTP shadow demo client", () => {
  it.each(["created", "reviewer_voted", "synthetic_voters_ran", "epoch_advanced"] as const)("restores authoritative %s state using only GET requests", async (phase) => {
    const advanced = phase === "epoch_advanced"
    const hasAgents = advanced || phase === "synthetic_voters_ran"
    const currentId = advanced ? "epoch-2" : "epoch-1"
    const votes = hasAgents ? syntheticVotes("epoch-1") : []
    const epochs = [epoch("epoch-1", 1, BASE_WEIGHTS, 0)]
    if (advanced) epochs.push(epoch("epoch-2", 2, NEXT_WEIGHTS, 25, "epoch-1"))
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonEnvelope(sessionPayload(phase, currentId, epochs, votes, hasAgents && !advanced ? aggregate(NEXT_WEIGHTS, 25, 2) : null)))
      .mockResolvedValueOnce(jsonEnvelope(feedPayload(currentId, [1, 2])))
    vi.stubGlobal("fetch", fetchMock)
    const response = await createHttpShadowDemoClient().getSession(SESSION_ID, new AbortController().signal)
    expect(response.payload.session.id).toBe(SESSION_ID)
    expect(response.payload.currentEpoch.id).toBe(currentId)
    expect(response.payload.agentVotes).toHaveLength(hasAgents ? 24 : 0)
    expect(response.payload.agentVotes.every((vote) => vote.epochId === "epoch-1")).toBe(true)
    expect(response.payload.agents.reduce((sum, agent) => sum + agent.voterCount, 0)).toBe(24)
    expect(response.payload.pendingAggregate?.voteSummary.totalVotes ?? 0).toBe(hasAgents ? 25 : 0)
    expect(response.payload.nextRecommendedAction).toBe(phase === "created" ? "cast_reviewer_vote" : phase === "reviewer_voted" ? "run_agent_votes" : phase === "synthetic_voters_ran" ? "advance_epoch" : "select_post")
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.every((call) => call[1]?.method === "GET")).toBe(true)
  })

  it("refuses a recovery response for another session before fetching its feed", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonEnvelope(sessionPayload("created", "epoch-1", [epoch("epoch-1", 1, BASE_WEIGHTS, 0)])))
    vi.stubGlobal("fetch", fetchMock)
    await expect(createHttpShadowDemoClient().getSession("other-session", new AbortController().signal)).rejects.toThrow(/different session/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("keeps novel backend hidden reasons withheld behind a generic row", () => {
    expect(hiddenReason("Withheld by a future public-view rule")).toBe("deleted_or_unavailable")
  })

  it("rejects synthetic voter identities that disagree with their declared bloc", () => {
    const vote = syntheticVotes("epoch-1")[0] as Record<string, unknown>

    expect(apiSyntheticVoteSchema.safeParse({ ...vote, blocId: "relevance_steward" }).success).toBe(false)
    expect(apiSyntheticVoteSchema.safeParse({ ...vote, actorId: "synthetic-unknown_bloc-1", blocId: "unknown_bloc" }).success).toBe(false)
  })

  it("accepts each v4 synthetic voter bloc identity", () => {
    const votes = syntheticVotes("epoch-1") as ReadonlyArray<{ readonly blocId: string }>
    for (const blocId of ["freshness_watcher", "conversation_follower", "bridge_builder", "source_diversifier", "relevance_steward"] as const) {
      const vote = votes.find((candidate) => candidate.blocId === blocId)
      expect(vote).toBeDefined()
      expect(apiSyntheticVoteSchema.safeParse(vote).success).toBe(true)
    }
  })

  it("accepts the honestly labeled mechanics fixture provenance", () => {
    const payload = sessionPayload("created", "epoch-1", [epoch("epoch-1", 1, BASE_WEIGHTS, 0)]) as {
      session: Record<string, unknown>
    }
    payload.session.corpusHealth = {
      ...corpusHealth() as Record<string, unknown>,
      status: "degraded",
      source: "fixture_fallback",
    }
    payload.session.corpusProvenance = {
      mode: "illustrative_fixture_session_frozen",
      label: "Illustrative mechanics fixture",
      description: "Illustrative posts and score inputs frozen for this session.",
      corpusId: "fixture-corpus",
      productionEpochId: 0,
      sampledAt: NOW,
      windowHours: 0,
      topicScoreThreshold: 0,
      eligiblePostCount: 8,
    }

    expect(apiSessionPayloadSchema.safeParse(payload).success).toBe(true)
  })

  it("fails closed when the frozen 26-topic catalog is missing or incomplete", () => {
    const valid = sessionPayload("created", "epoch-1", [epoch("epoch-1", 1, BASE_WEIGHTS, 0)]) as {
      session: Record<string, unknown>
    }
    expect(apiSessionPayloadSchema.safeParse(valid).success).toBe(true)
    expect(apiSessionPayloadSchema.safeParse({ session: { ...valid.session, topicCatalog: undefined } }).success).toBe(false)
    const catalog = valid.session.topicCatalog as unknown[]
    expect(apiSessionPayloadSchema.safeParse({ session: { ...valid.session, topicCatalog: catalog.slice(0, 25) } }).success).toBe(false)
  })

  it("bounds the content-rules support array on parsed session payloads", () => {
    const valid = sessionPayload("created", "epoch-1", [epoch("epoch-1", 1, BASE_WEIGHTS, 0)]) as {
      session: Record<string, unknown>
    }
    const epochs = valid.session.epochs as Array<Record<string, unknown>>
    const withContentRules = (supportLength: number): unknown => {
      const support = Array.from({ length: supportLength }, (_unused, i) => ({
        keyword: `rule-${i}`,
        supportCount: 1,
        adopted: false,
      }))
      const aggregate = { ...(epochs[0].aggregate as Record<string, unknown>) }
      aggregate.contentRules = { enabled: true, threshold: 8, electorate: 25, adoptedExcludeKeywords: [], support }
      return { session: { ...valid.session, epochs: [{ ...epochs[0], aggregate }] } }
    }
    expect(apiSessionPayloadSchema.safeParse(withContentRules(250)).success).toBe(true)
    expect(apiSessionPayloadSchema.safeParse(withContentRules(251)).success).toBe(false)
  })

  it("accepts retained live and fallback corpus-health source values", () => {
    const valid = sessionPayload("created", "epoch-1", [epoch("epoch-1", 1, BASE_WEIGHTS, 0)]) as {
      session: Record<string, unknown>
    }
    const corpusHealth = valid.session.corpusHealth as Record<string, unknown>
    for (const source of ["production_scores_appview", "production_feed_snapshot", "fixture_fallback"]) {
      expect(apiSessionPayloadSchema.safeParse({
        session: { ...valid.session, corpusHealth: { ...corpusHealth, source } },
      }).success).toBe(true)
    }
  })

  it("maps every retained corpus source without treating live AppView data as a fixture", () => {
    expect(corpusSourcePresentation("production_feed_snapshot")).toMatchObject({
      strategy: "published_feed_snapshot",
      rankingSource: "live_public_posts_shadow_weights",
    })
    expect(corpusSourcePresentation("production_scores_appview")).toMatchObject({
      strategy: "live_appview_search",
      rankingSource: "live_public_posts_shadow_weights",
    })
    expect(corpusSourcePresentation("fixture_fallback")).toMatchObject({
      strategy: "fixture_fallback",
      rankingSource: "fixture_posts_shadow_weights",
    })
  })

  it("rejects receipts that repeat a signal instead of covering all five signals", () => {
    const components = Object.entries(BASE_WEIGHTS).map(([signal, weight]) => ({
      signal,
      rawScore: 0.5,
      weight,
      contribution: 0.5 * weight,
    }))
    components[4] = { ...components[4], signal: "recency" }

    expect(apiReceiptComponentsSchema.safeParse(components).success).toBe(false)
  })

  it("accepts HTTPS media and rejects non-web media schemes", () => {
    const media = {
      images: [{
        thumb: "https://cdn.bsky.app/thumb.jpg",
        fullsize: "https://cdn.bsky.app/full.jpg",
        alt: "Preview",
        width: 800,
        height: 600,
      }],
      external: {
        uri: "https://example.com/report",
        title: "Report",
        description: "A public report",
        thumb: "https://cdn.bsky.app/external.jpg",
      },
      quote: {
        uri: "at://did:plc:quoted/app.bsky.feed.post/one",
        authorHandle: "quoted.bsky.social",
        authorDisplayName: "Quoted Author",
        text: "Quoted context",
      },
      video: {
        thumbnail: "https://cdn.bsky.app/video.jpg",
        width: 1280,
        height: 720,
      },
    }
    expect(apiPostMediaSchema.safeParse(media).success).toBe(true)
    expect(apiPostMediaSchema.safeParse({
      ...media,
      images: [{ ...media.images[0], fullsize: "javascript:alert(1)" }],
    }).success).toBe(false)
    expect(apiPostMediaSchema.safeParse({
      ...media,
      images: [{ ...media.images[0], thumb: "data:image/png;base64,abc" }],
    }).success).toBe(false)
    expect(apiPostMediaSchema.safeParse({
      ...media,
      images: [{ ...media.images[0], fullsize: "http://cdn.bsky.app/full.jpg" }],
    }).success).toBe(false)
    for (const invalid of [
      { ...media, external: { ...media.external, uri: "http://example.com/report" } },
      { ...media, external: { ...media.external, thumb: "http://cdn.bsky.app/external.jpg" } },
      { ...media, quote: { ...media.quote, uri: "https://bsky.app/not-an-at-uri" } },
      { ...media, video: { ...media.video, thumbnail: "http://cdn.bsky.app/video.jpg" } },
    ]) {
      expect(apiPostMediaSchema.safeParse(invalid).success).toBe(false)
    }
  })

  it("accepts published-feed inclusion provenance returned by v4 receipts", () => {
    const components = Object.entries(BASE_WEIGHTS).map(([signal, weight]) => ({
      signal,
      rawScore: 0.5,
      weight,
      contribution: 0.5 * weight,
    }))
    const parsed = apiReceiptPayloadSchema.safeParse({
      receipt: {
        type: "shadow_demo_receipt",
        epochId: "epoch-2",
        postUri: "at://did:plc:test/app.bsky.feed.post/one",
        visibleRank: 1,
        previousRank: 4,
        score: 0.5,
        componentScore: 0.5,
        publicationAdjustment: 1,
        publishedRank: 4,
        publishedScore: 0.45,
        scoredAt: NOW,
        aggregate: aggregate(NEXT_WEIGHTS, 25, 2),
        reviewerBallotShare: 0.04,
        components,
        topicRelevanceFormula: {
          formulaApplied: true,
          defaultTopicWeight: 0.2,
          confidenceThreshold: 0.5,
          weightedSum: 0.8,
          signalSum: 1,
          baseRelevance: 0.8,
          confidenceMultiplier: 1,
          effectiveRelevance: 0.8,
          usedDefaultWeight: false,
          terms: [],
        },
        provenance: {
          ...corpusProvenance(),
          shadowEpochId: "epoch-2",
          postInclusionReasons: {
            matchedTopics: [],
            matchedTerms: [],
            sourceRank: 4,
            reason: "published_feed_snapshot",
          },
        },
        counterfactuals: [{
          label: "previous_epoch",
          description: "Published rank in the frozen baseline.",
          rank: null,
          deltaFromVisible: null,
        }],
      },
    })

    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.receipt.counterfactuals[0]).toMatchObject({
        rank: null,
        deltaFromVisible: null,
      })
    }
  })

  it("maps a live-scored session without claiming the unpublished community is a native Bluesky feed", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const path = requestPath(input)
      if (path === "/api/demo/v4/sessions") return jsonEnvelope(sessionPayload("created", "epoch-1", [epoch("epoch-1", 1, BASE_WEIGHTS, 0)]))
      if (path.startsWith(`/api/demo/v4/sessions/${SESSION_ID}/feed`)) return jsonEnvelope(feedPayload("epoch-1", [1, 2]))
      return new Response(null, { status: 404 })
    })
    vi.stubGlobal("fetch", fetchMock)

    const response = await createHttpShadowDemoClient().createSession(
      { communityId: "community_gov", scenarioId: "guided_default", clientNonce: "nonce", mode: "guided" },
      new AbortController().signal,
    )

    expect(response.payload.community.name).toBe("Corgi Commons")
    expect(response.payload.community.publicBlueskyFeedUrl).toContain("community-gov")
    expect(response.payload.session.capabilities.canOpenNativeBlueskyFeed).toBe(true)
    expect(response.payload.session.capabilities.canAdvanceEpoch).toBe(false)
    expect(response.payload.feed.rankingSource).toBe("live_public_posts_shadow_weights")
    expect(response.payload.feed.corpusHealth.candidatePostCount).toBe(84_831)
    expect(response.payload.feed.corpusHealth.publicScoredPostCount).toBe(80)
    expect(response.payload.feed.corpusHealth.displayedPublicPostCount).toBe(2)
    expect(response.payload.currentEpoch.topicIntent.topicWeights).toMatchObject({
      music: 0.1,
      "decentralized-social": 0.9,
    })
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      communityId: "community_gov",
      clientNonce: "nonce",
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const [input, init] of fetchMock.mock.calls) {
      expect(requestPath(input)).toMatch(/^\/api\/demo\/v4\//)
      expect(new Headers(init?.headers).has("x-csrf-token")).toBe(false)
    }
  })

  it("rejects malformed community, provenance, topic, and session identity fields", () => {
    const invalidPayloads: unknown[] = []
    const emptyCommunity = structuredClone(sessionPayload("created", "epoch-1", [epoch("epoch-1", 1, BASE_WEIGHTS, 0)])) as {
      session: { community: Record<string, unknown> }
    }
    emptyCommunity.session.community.name = ""
    invalidPayloads.push(emptyCommunity)

    const nullCommunity = structuredClone(sessionPayload("created", "epoch-1", [epoch("epoch-1", 1, BASE_WEIGHTS, 0)])) as {
      session: { community: Record<string, unknown> }
    }
    nullCommunity.session.community.id = null
    invalidPayloads.push(nullCommunity)

    const missingProvenance = structuredClone(sessionPayload("created", "epoch-1", [epoch("epoch-1", 1, BASE_WEIGHTS, 0)])) as {
      session: Record<string, unknown>
    }
    delete missingProvenance.session.corpusProvenance
    invalidPayloads.push(missingProvenance)

    const staleShapeProvenance = structuredClone(sessionPayload("created", "epoch-1", [epoch("epoch-1", 1, BASE_WEIGHTS, 0)])) as {
      session: { corpusProvenance: Record<string, unknown> }
    }
    staleShapeProvenance.session.corpusProvenance.sourceUpdatedAt = "not-a-timestamp"
    invalidPayloads.push(staleShapeProvenance)

    const duplicateTopics = structuredClone(sessionPayload("created", "epoch-1", [epoch("epoch-1", 1, BASE_WEIGHTS, 0)])) as {
      session: { topicCatalog: Array<Record<string, unknown>> }
    }
    duplicateTopics.session.topicCatalog[1].slug = duplicateTopics.session.topicCatalog[0].slug
    invalidPayloads.push(duplicateTopics)

    const nullEpoch = structuredClone(sessionPayload("created", "epoch-1", [epoch("epoch-1", 1, BASE_WEIGHTS, 0)])) as {
      session: Record<string, unknown>
    }
    nullEpoch.session.currentEpochId = null
    invalidPayloads.push(nullEpoch)

    for (const payload of invalidPayloads) {
      expect(apiSessionPayloadSchema.safeParse(payload).success).toBe(false)
    }
  })

  it("preserves a structured non-2xx conflict message without retrying the mutation", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      error: "StaleEpoch",
      message: "The shadow epoch changed before this ballot was accepted.",
    }), { status: 409, headers: { "content-type": "application/json" } }))
    vi.stubGlobal("fetch", fetchMock)

    await expect(createHttpShadowDemoClient().castVote(
      SESSION_ID,
      {
        idempotencyKey: "stale-vote",
        baseEpochId: "epoch-1",
        voterLabel: "Reviewer",
        weights: BASE_WEIGHTS,
        topicIntent: PRODUCTION_TOPIC_INTENT,
      },
      new AbortController().signal,
    )).rejects.toThrow("The shadow epoch changed before this ballot was accepted.")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("treats duplicate session creation nonce conflicts as non-retryable", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      error: "DemoConflictError",
      message: "Session creation nonce has already been used",
    }), { status: 409, headers: { "content-type": "application/json" } }))
    vi.stubGlobal("fetch", fetchMock)

    await expect(createHttpShadowDemoClient().createSession(
      { communityId: "community_gov", scenarioId: "guided_default", clientNonce: "duplicate-nonce", mode: "guided" },
      new AbortController().signal,
    )).rejects.toThrow("Session creation nonce has already been used")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      communityId: "community_gov",
      clientNonce: "duplicate-nonce",
    })
  })

  it("maps withheld posts with their adopted rule and support", async () => {
    const feed = feedPayload("epoch-2", [1, 2]) as { posts: Array<Record<string, unknown>> } & Record<string, unknown>
    const withheldPost = { ...(feed.posts[0].post as Record<string, unknown>), uri: "at://did:plc:test/app.bsky.feed.post/withheld" }
    feed.withheldPosts = [{ keyword: "atproto", supportCount: 10, previousRank: 4, post: withheldPost }]
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const path = requestPath(input)
      if (path.startsWith(`/api/demo/v4/sessions/${SESSION_ID}/feed`)) return jsonEnvelope(feed)
      return new Response(null, { status: 404 })
    })
    vi.stubGlobal("fetch", fetchMock)

    const response = await createHttpShadowDemoClient().getFeed(
      SESSION_ID,
      { epochId: "epoch-2", limit: 12 },
      new AbortController().signal,
    )
    expect(response.payload.withheldPosts).toEqual([
      {
        keyword: "atproto",
        supportCount: 10,
        previousRank: 4,
        hiddenReason: null,
        post: expect.objectContaining({ uri: "at://did:plc:test/app.bsky.feed.post/withheld", labels: [] }),
      },
    ])
  })

  it("counts visible hidden rows when snapshot source totals are unavailable", async () => {
    const feed = feedPayload("epoch-1", [1, 2]) as { posts: Array<Record<string, unknown>> }
    feed.posts[0] = {
      ...feed.posts[0],
      score: null,
      weightedComponents: null,
      rawScores: null,
      post: { kind: "hidden_post", reason: "Post unavailable from Bluesky public AppView" },
    }
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const path = requestPath(input)
      if (path === "/api/demo/v4/sessions") return jsonEnvelope(sessionPayload("created", "epoch-1", [epoch("epoch-1", 1, BASE_WEIGHTS, 0)]))
      if (path.startsWith(`/api/demo/v4/sessions/${SESSION_ID}/feed`)) return jsonEnvelope(feed)
      return new Response(null, { status: 404 })
    }))

    const response = await createHttpShadowDemoClient().createSession(
      { communityId: "community_gov", scenarioId: "guided_default", clientNonce: "hidden-row", mode: "guided" },
      new AbortController().signal,
    )
    expect(response.payload.feed.corpusHealth.displayedHiddenPostCount).toBe(1)
  })

  it("uses snapshot source totals when eligible count is omitted", async () => {
    const feed = feedPayload("epoch-1", [1, 2]) as {
      corpusHealth: Record<string, unknown>
    }
    feed.corpusHealth = {
      ...feed.corpusHealth,
      sourcePostCount: 100,
      publicScoredPosts: 71,
    }
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const path = requestPath(input)
      if (path === "/api/demo/v4/sessions") return jsonEnvelope(sessionPayload("created", "epoch-1", [epoch("epoch-1", 1, BASE_WEIGHTS, 0)]))
      if (path.startsWith(`/api/demo/v4/sessions/${SESSION_ID}/feed`)) return jsonEnvelope(feed)
      return new Response(null, { status: 404 })
    }))

    const response = await createHttpShadowDemoClient().createSession(
      { communityId: "community_gov", scenarioId: "guided_default", clientNonce: "source-total", mode: "guided" },
      new AbortController().signal,
    )
    expect(response.payload.feed.corpusHealth.displayedHiddenPostCount).toBe(29)
  })

  it("bridges only the explicit pre-nonce server rejection during rollout", async () => {
    const bodies: unknown[] = []
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = requestPath(input)
      if (path === "/api/demo/v4/sessions") {
        bodies.push(JSON.parse(String(init?.body)))
        if (bodies.length === 1) {
          return new Response(JSON.stringify({ message: "Unrecognized key(s) in object: 'clientNonce'" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          })
        }
        return jsonEnvelope(sessionPayload("created", "epoch-1", [epoch("epoch-1", 1, BASE_WEIGHTS, 0)]))
      }
      if (path.startsWith(`/api/demo/v4/sessions/${SESSION_ID}/feed`)) return jsonEnvelope(feedPayload("epoch-1", [1, 2]))
      return new Response(null, { status: 404 })
    })
    vi.stubGlobal("fetch", fetchMock)

    await createHttpShadowDemoClient().createSession(
      { communityId: "community_gov", scenarioId: "guided_default", clientNonce: "rollout-nonce", mode: "guided" },
      new AbortController().signal,
    )

    expect(bodies).toEqual([
      { communityId: "community_gov", clientNonce: "rollout-nonce" },
      { communityId: "community_gov" },
    ])
  })

  it("maps the full 24-voter electorate and production-faithful trimmed aggregate", async () => {
    const votes = syntheticVotes("epoch-1")
    vi.stubGlobal("fetch", vi.fn(async () => jsonEnvelope(sessionPayload(
      "synthetic_voters_ran",
      "epoch-1",
      [epoch("epoch-1", 1, BASE_WEIGHTS, 0)],
      votes,
      aggregate(NEXT_WEIGHTS, 25, 2),
    ))))

    const response = await createHttpShadowDemoClient().runAgents(
      SESSION_ID,
      { idempotencyKey: "run-1", baseEpochId: "epoch-1" },
      new AbortController().signal,
    )

    expect(response.payload.agents).toHaveLength(5)
    expect(response.payload.agentVotes).toHaveLength(24)
    expect(response.payload.pendingAggregate.voteSummary).toMatchObject({
      reviewerVotes: 1,
      agentVotes: 24,
      totalVotes: 25,
      trimCount: 2,
    })
    expect(response.payload.currentEpoch.status).toBe("agent_voting")
    expect(response.payload.agents.map((profile) => profile.name)).toEqual([
      "Freshness Watchers",
      "Conversation Followers",
      "Bridge Builders",
      "Source Diversifiers",
      "Relevance Stewards",
    ])
  })

  it("fetches both sides of an epoch transition and preserves real rank movement", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = requestPath(input)
      if (path.includes("/feed") && path.includes("epochId=epoch-1")) return jsonEnvelope(feedPayload("epoch-1", [1, 2]))
      if (path.endsWith("/epochs/advance") && init?.method === "POST") {
        return jsonEnvelope(sessionPayload(
          "epoch_advanced",
          "epoch-2",
          [advancedEpoch("epoch-1", 1, BASE_WEIGHTS), epoch("epoch-2", 2, NEXT_WEIGHTS, 25, "epoch-1")],
          syntheticVotes("epoch-1"),
          null,
        ))
      }
      if (path.includes("/feed") && path.includes("epochId=epoch-2")) return jsonEnvelope(feedPayload("epoch-2", [2, 1]))
      return new Response(null, { status: 404 })
    })
    vi.stubGlobal("fetch", fetchMock)

    const response = await createHttpShadowDemoClient().advanceEpoch(
      SESSION_ID,
      { idempotencyKey: "advance-1", fromEpochId: "epoch-1" },
      new AbortController().signal,
    )

    expect(response.payload.previousEpoch.status).toBe("closed")
    expect(response.payload.currentEpoch.status).toBe("published")
    expect(response.payload.currentEpoch.sequence).toBe(2)
    expect(response.payload.feedBefore.items.map((item) => item.rank)).toEqual([1, 2])
    expect(response.payload.feedAfter.items.map((item) => item.previousRank)).toEqual([2, 1])
    expect(response.payload.feedAfter.items.map((item) => item.movement.label)).toEqual(["up", "down"])
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it("fails closed when the frontend and backend contract versions drift", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      contractVersion: "2026-07-09.shadow-demo.v1",
      requestId: "request-old",
      generatedAt: NOW,
      sessionId: SESSION_ID,
      payload: {},
      warnings: [],
    }), { status: 200, headers: { "content-type": "application/json" } })))

    await expect(createHttpShadowDemoClient().createSession(
      { communityId: "community_gov", scenarioId: "guided_default", clientNonce: "nonce", mode: "guided" },
      new AbortController().signal,
    )).rejects.toThrow("invalid response envelope")
  })

  it("sanitizes non-JSON server failures and rejects malformed success envelopes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("secret upstream stack", {
      status: 503,
      statusText: "Service Unavailable",
    })))

    const failedRequest = createHttpShadowDemoClient().createSession(
      { communityId: "community_gov", scenarioId: "guided_default", clientNonce: "nonce", mode: "guided" },
      new AbortController().signal,
    )
    await expect(failedRequest).rejects.toThrow("HTTP 503")
    await expect(failedRequest).rejects.not.toThrow("secret upstream stack")

    vi.stubGlobal("fetch", vi.fn(async () => new Response("not-json", { status: 200 })))
    await expect(createHttpShadowDemoClient().createSession(
      { communityId: "community_gov", scenarioId: "guided_default", clientNonce: "nonce", mode: "guided" },
      new AbortController().signal,
    )).rejects.toThrow("invalid response envelope")
  })

  it("sanitizes direct network failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed: connect ECONNREFUSED 10.0.0.4:6381")
    }))

    await expect(createHttpShadowDemoClient().createSession(
      { communityId: "community_gov", scenarioId: "guided_default", clientNonce: "nonce", mode: "guided" },
      new AbortController().signal,
    )).rejects.toThrow("temporarily unavailable")
  })

  it("rejects malformed provenance timestamps before they reach receipt and corpus UI", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      contractVersion: CONTRACT_VERSION,
      requestId: "request-bad-timestamp",
      generatedAt: "not-a-timestamp",
      sessionId: SESSION_ID,
      payload: sessionPayload("created", "epoch-1", [epoch("epoch-1", 1, BASE_WEIGHTS, 0)]),
      warnings: [],
    }), { status: 200, headers: { "content-type": "application/json" } })))

    await expect(createHttpShadowDemoClient().createSession(
      { communityId: "community_gov", scenarioId: "guided_default", clientNonce: "nonce", mode: "guided" },
      new AbortController().signal,
    )).rejects.toThrow("invalid response envelope")
  })

  it("honors caller cancellation independently of the internal timeout", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
      }),
    ))
    const controller = new AbortController()
    const request = createHttpShadowDemoClient().getFeed(
      SESSION_ID,
      { epochId: "epoch-1", limit: 12 },
      controller.signal,
    )

    controller.abort(new Error("stale demo request"))

    await expect(request).rejects.toThrow("stale demo request")
  })

  it("times out a backend request that never completes", async () => {
    vi.useFakeTimers()
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
      }),
    ))

    const request = createHttpShadowDemoClient().getFeed(
      SESSION_ID,
      { epochId: "epoch-1", limit: 12 },
      new AbortController().signal,
    )
    const rejection = expect(request).rejects.toThrow("timed out after 10000ms")
    await vi.advanceTimersByTimeAsync(10_000)

    await rejection
    expect(vi.getTimerCount()).toBe(0)
  })

  it("allows a cold corpus session longer than ordinary demo requests", async () => {
    vi.useFakeTimers()
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
      }),
    ))

    const request = createHttpShadowDemoClient().createSession(
      { communityId: "community_gov", scenarioId: "guided_default", clientNonce: "nonce", mode: "guided" },
      new AbortController().signal,
    )
    const rejection = expect(request).rejects.toThrow("timed out after 30000ms")
    await vi.advanceTimersByTimeAsync(10_000)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(20_000)

    await rejection
    expect(vi.getTimerCount()).toBe(0)
  })

  it("derives action capabilities from the server phase and epoch limit", async () => {
    const cases = [
      { phase: "created", expected: [true, false, false], epochCount: 1 },
      { phase: "reviewer_voted", expected: [true, true, false], epochCount: 1 },
      { phase: "synthetic_voters_ran", expected: [false, false, true], epochCount: 1 },
      { phase: "epoch_advanced", expected: [true, false, false], epochCount: 2 },
      { phase: "synthetic_voters_ran", expected: [false, false, false], epochCount: 10 },
    ] as const

    for (const testCase of cases) {
      const epochs = Array.from({ length: testCase.epochCount }, (_unused, index) =>
        epoch(`epoch-${index + 1}`, index + 1, BASE_WEIGHTS, 0),
      )
      const currentEpochId = `epoch-${testCase.epochCount}`
      let requestCount = 0
      vi.stubGlobal("fetch", vi.fn(async () => {
        requestCount += 1
        return requestCount % 2 === 1
          ? jsonEnvelope(sessionPayload(testCase.phase, currentEpochId, epochs))
          : jsonEnvelope(feedPayload(currentEpochId, [1, 2]))
      }))

      const response = await createHttpShadowDemoClient().getSession(SESSION_ID, new AbortController().signal)
      const capabilities = response.payload.session.capabilities
      expect([
        capabilities.canCastReviewerVote,
        capabilities.canRunAgents,
        capabilities.canAdvanceEpoch,
      ]).toEqual(testCase.expected)
      vi.unstubAllGlobals()
    }
  })
})

function requestPath(input: string | URL | Request): string {
  const value = input instanceof Request ? input.url : String(input)
  return value.startsWith("http") ? `${new URL(value).pathname}${new URL(value).search}` : value
}

function jsonEnvelope(payload: unknown): Response {
  return new Response(JSON.stringify({
    contractVersion: CONTRACT_VERSION,
    requestId: "request-http-contract",
    generatedAt: NOW,
    sessionId: SESSION_ID,
    payload,
    warnings: [],
  }), { status: 200, headers: { "content-type": "application/json" } })
}

function sessionPayload(
  phase: "created" | "reviewer_voted" | "synthetic_voters_ran" | "epoch_advanced",
  currentEpochId: string,
  epochs: readonly unknown[],
  votes: readonly unknown[] = [],
  pendingAggregate: unknown = null,
): unknown {
  return {
    session: {
      sessionId: SESSION_ID,
      community: {
        id: "community_gov",
        name: "Corgi Commons",
        status: "live_shadow",
        description: "Research, data, software, and open-source methods.",
        liveFeedReady: true,
      },
      phase,
      currentEpochId,
      expiresAt: "2026-07-10T06:30:00.000Z",
      corpusHealth: corpusHealth(),
      epochs,
      pendingAggregate,
      voteCount: votes.length,
      guidedEpochs: 5,
      maxEpochs: 10,
      syntheticVoterCount: 24,
      totalDemoVoters: 25,
      corpusProvenance: corpusProvenance(),
      topicCatalog: Object.entries(PRODUCTION_TOPIC_INTENT.topicWeights).map(([slug, baselineWeight]) => ({ slug, name: slug, description: null, baselineWeight })),
      sourceFeedUri: "at://did:plc:amzyknmm4auxijvykyfgznw2/app.bsky.feed.generator/community-gov",
      voterProfiles: voterProfiles(),
      votes,
    },
  }
}

function epoch(
  id: string,
  sequence: number,
  weights: ShadowDemoWeights,
  voteCount: number,
  decidedByEpochId: string | null = null,
): Record<string, unknown> {
  return {
    id,
    sequence,
    label: sequence === 1 ? "Baseline policy" : `Shadow epoch ${sequence}`,
    status: "open",
    createdAt: NOW,
    advancedAt: null,
    decidedByEpochId,
    aggregate: aggregate(weights, voteCount, voteCount >= 10 ? 2 : 0),
  }
}

function advancedEpoch(id: string, sequence: number, weights: ShadowDemoWeights): Record<string, unknown> {
  return {
    ...epoch(id, sequence, weights, 0),
    status: "advanced",
    advancedAt: NOW,
  }
}

function aggregate(weights: ShadowDemoWeights, voteCount: number, trimCount: number): unknown {
  return {
    aggregateMethod: "trimmed_mean_no_trim_under_10",
    voteCount,
    trimCount,
    weights,
    topicIntent: PRODUCTION_TOPIC_INTENT,
  }
}

function corpusHealth(): unknown {
  return {
    status: "live",
    source: "production_feed_snapshot",
    candidatePosts72h: 84_831,
    publicScoredPosts: 80,
    uniqueAuthors72h: 46_652,
    bridgePostShare: 0.027,
    topAuthorConcentration: 0.017,
    sampledAt: NOW,
  }
}

function corpusProvenance(): Record<string, unknown> {
  return {
    mode: "production_feed_snapshot_session_frozen",
    label: "Reviewer-safe snapshot of the live Community Governed Feed",
    description: "Reviewer-safe snapshot of the live Community Governed Feed, frozen for this demo run so rank movement is attributable to policy changes.",
    corpusId: "corpus-community-gov",
    productionEpochId: 7,
    sampledAt: NOW,
    windowHours: 72,
    topicScoreThreshold: 0.5,
    eligiblePostCount: 80,
    sourceFeedUri: "at://did:plc:amzyknmm4auxijvykyfgznw2/app.bsky.feed.generator/community-gov",
    sourceFeedName: "Corgi Commons",
    sourceSnapshotDigest: "7".repeat(64),
    sourceRunId: "run-community-gov",
    sourceUpdatedAt: NOW,
    sourceReviewedAt: NOW,
    sourcePostCount: 100,
    selectionPolicyVersion: "community-gov-reviewer-safe-v1",
    baselineOrderDigest: "a".repeat(64),
  }
}

function voterProfiles(): readonly unknown[] {
  const profiles = [
    ["freshness_watcher", "Freshness Watchers", 5],
    ["conversation_follower", "Conversation Followers", 4],
    ["bridge_builder", "Bridge Builders", 5],
    ["source_diversifier", "Source Diversifiers", 5],
    ["relevance_steward", "Relevance Stewards", 5],
  ] as const
  return profiles.map(([id, label, voterCount]) => ({
    id,
    label,
    voterCount,
    baseWeights: BASE_WEIGHTS,
    baseTopicWeights: TOPIC_INTENT.topicWeights,
    reviewerBlend: 0.2,
    policyInertia: 0.3,
  }))
}

function syntheticVotes(epochId: string): readonly unknown[] {
  return voterProfiles().flatMap((profile) => {
    const typed = profile as { readonly id: string; readonly label: string; readonly voterCount: number }
    return Array.from({ length: typed.voterCount }, (_unused, index) => ({
      id: `vote-${typed.id}-${index + 1}`,
      epochId,
      actorType: "synthetic_voter",
      actorId: `synthetic-${typed.id}-${index + 1}`,
      blocId: typed.id,
      label: `${typed.label} voter ${index + 1}`,
      weights: NEXT_WEIGHTS,
      topicIntent: TOPIC_INTENT,
      createdAt: NOW,
    }))
  })
}

function feedPayload(epochId: string, previousRanks: readonly number[]): unknown {
  return {
    epochId,
    corpusId: "corpus-community-gov",
    communityId: "community_gov",
    corpusHealth: corpusHealth(),
    corpusProvenance: corpusProvenance(),
    aggregate: aggregate(epochId === "epoch-1" ? BASE_WEIGHTS : NEXT_WEIGHTS, epochId === "epoch-1" ? 0 : 25, epochId === "epoch-1" ? 0 : 2),
    posts: previousRanks.map((previousRank, index) => ({
      rank: index + 1,
      previousRank: epochId === "epoch-1" ? null : previousRank,
      movement: epochId === "epoch-1" ? null : previousRank - (index + 1),
      score: 0.7 - index * 0.1,
      weightedComponents: {
        recency: 0.1,
        engagement: 0.1,
        bridging: 0.15,
        source_diversity: 0.15,
        relevance: 0.2,
      },
      rawScores: {
        recency: 0.5,
        engagement: 0.5,
        bridging: 0.5,
        source_diversity: 0.5,
        relevance: 0.5,
      },
      post: {
        kind: "public_post",
        uri: `at://did:plc:test/app.bsky.feed.post/${index + 1}`,
        cid: `cid-${index + 1}`,
        authorDid: `did:plc:researcher${index + 1}`,
        authorHandle: `researcher${index + 1}.bsky.social`,
        authorDisplayName: `Researcher ${index + 1}`,
        authorAvatar: null,
        text: `Published feed post ${index + 1}`,
        likeCount: 10,
        repostCount: 2,
        replyCount: 1,
        quoteCount: 0,
        indexedAt: NOW,
        createdAt: NOW,
        bskyUrl: `https://bsky.app/profile/researcher${index + 1}.bsky.social/post/${index + 1}`,
      },
    })),
  }
}
