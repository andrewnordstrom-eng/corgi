import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { DEMO_RESUME_KEY, readDemoResume, writeDemoResume } from "../demo-session-resume"
import type { DemoSessionResume } from "../demo-session-resume"
import { BASELINE_TOPIC_INTENT } from "../shadow-demo-fixtures"
import { driveFullFlow } from "./_flow"
import {
  COMMUNITY_GOV_FEED_URL,
  getDegradedCorpusWarning,
  getDemoCorpusPresentation,
  getLiveProofPresentation,
  getReceiptSelectionAnnouncement,
} from "@/components/demo/live-proof-panel"
import type { ShadowDemoCorpusProvenance, ShadowDemoFeed } from "../shadow-demo-view-model"
import {
  createDemoVoteSubmission,
  formatPolicySliderValue,
  getEditedTopicSlugs,
  POLICY_EDIT_THRESHOLD,
  validateDemoVoteSubmission,
} from "../shadow-demo-vote-policy"

const snapshotProvenance: ShadowDemoCorpusProvenance = {
  mode: "production_feed_snapshot_session_frozen",
  label: "Reviewer-safe snapshot of the live Community Governed Feed",
  description: "Frozen comparison corpus.",
  corpusId: "corpus-release",
  productionEpochId: 8,
  sampledAt: "2026-07-11T01:00:00.000Z",
  windowHours: 72,
  topicScoreThreshold: 0.5,
  eligiblePostCount: 42,
  sourceFeedUri: "at://did:plc:test/app.bsky.feed.generator/community-gov",
  sourceFeedName: "Contract-backed feed name",
  sourceSnapshotDigest: "a".repeat(64),
  sourceRunId: "run-8",
  sourceUpdatedAt: "2026-07-11T00:55:00.000Z",
  sourceReviewedAt: "2026-07-11T01:05:00.000Z",
  sourcePostCount: 100,
  selectionPolicyVersion: "v4",
  baselineOrderDigest: "b".repeat(64),
}

const demoPageSource = readFileSync(new URL("../page.tsx", import.meta.url), "utf8")
const votePanelSource = readFileSync(
  new URL("../../../components/demo/vote-panel.tsx", import.meta.url),
  "utf8",
)
const agentsPanelSource = readFileSync(
  new URL("../../../components/demo/agents-panel.tsx", import.meta.url),
  "utf8",
)
const receiptPanelSource = readFileSync(
  new URL("../../../components/demo/receipt-panel.tsx", import.meta.url),
  "utf8",
)
const panelLayoutSource = readFileSync(
  new URL("../../../components/demo/panel-layout.ts", import.meta.url),
  "utf8",
)
const sliderSource = readFileSync(
  new URL("../../../components/ui/slider.tsx", import.meta.url),
  "utf8",
)

function makeFeed(overrides: Partial<ShadowDemoFeed>): ShadowDemoFeed {
  return {
    epochId: "epoch-1",
    corpusId: "corpus-release",
    rankingSource: "live_public_posts_shadow_weights",
    generatedAt: "2026-07-11T01:10:00.000Z",
    items: [],
    corpusProvenance: snapshotProvenance,
    aggregate: {
      weights: { recency: 0.2, engagement: 0.2, bridging: 0.2, source_diversity: 0.2, relevance: 0.2 },
      topicIntent: { topicWeights: {} },
      voteSummary: {
        reviewerVotes: 0,
        agentVotes: 0,
        totalVotes: 0,
        aggregateMethod: "trimmed_mean_no_trim_under_10",
        trimCount: 0,
        reviewerBallotShare: 0,
      },
    },
    corpusHealth: {
      status: "live",
      candidatePostCount: 100,
      publicScoredPostCount: 42,
      displayedPublicPostCount: 12,
      displayedHiddenPostCount: 0,
      uniqueAuthorCount: 38,
      collectedAt: "2026-07-11T01:00:00.000Z",
      frozenForSession: true,
      sourcePostCount: 100,
      eligiblePostCount: 42,
    },
    ...overrides,
  }
}

describe("demo v4 frontend release blockers", () => {
  it("restores the published topic policy in the mock pending aggregate", async () => {
    const flow = await driveFullFlow("field_notes")
    expect(flow.agentsRun.payload.pendingAggregate.topicIntent).toEqual(BASELINE_TOPIC_INTENT)
    expect(Object.keys(flow.advanced.payload.currentEpoch.topicIntent.topicWeights)).toHaveLength(26)
    expect(flow.advanced.payload.currentEpoch.topicIntent).not.toEqual(BASELINE_TOPIC_INTENT)

    const restored = await flow.client.getSession(flow.sessionId, flow.signal)
    expect(restored.payload.pendingAggregate?.topicIntent).toEqual(flow.advanced.payload.currentEpoch.topicIntent)
    expect(restored.payload.pendingAggregate?.topicIntent).toEqual(restored.payload.feed.aggregate.topicIntent)
  })

  it("retains only a versioned tab continuation hint, not response evidence", () => {
    const values = new Map<string, string>()
    const storage: Storage = { get length() { return values.size }, clear: () => values.clear(), key: (index) => [...values.keys()][index] ?? null, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) }, removeItem: (key) => { values.delete(key) } }
    const hint: DemoSessionResume = { version: 1, sessionId: "demo-test", expiresAt: "2026-09-24T00:00:00Z", selection: { epochId: "epoch-2", postUri: "at://did:plc:fixture/app.bsky.feed.post/1" }, nextEpochId: null, mobileView: "receipt" }
    writeDemoResume(storage, hint)
    expect(readDemoResume(storage, Date.parse("2026-09-23T00:00:00Z"))).toEqual(hint)
    expect([...values.keys()]).toEqual([DEMO_RESUME_KEY])
    expect(Object.keys(JSON.parse(values.get(DEMO_RESUME_KEY) ?? "{}"))).toEqual(["version", "sessionId", "expiresAt", "selection", "nextEpochId", "mobileView"])
    expect(() => readDemoResume(storage, Date.parse("2026-09-25T00:00:00Z"))).toThrow(/expired/)
    storage.setItem(DEMO_RESUME_KEY, JSON.stringify({ ...hint, version: 2 }))
    expect(() => readDemoResume(storage, 0)).toThrow(/incompatible/)
    storage.setItem(DEMO_RESUME_KEY, JSON.stringify({ ...hint, selection: { epochId: "epoch-2", postUri: "https://private.invalid/secret" } }))
    expect(() => readDemoResume(storage, 0)).toThrow(/selection is invalid/)
    storage.setItem(DEMO_RESUME_KEY, "{")
    expect(() => readDemoResume(storage, 0)).toThrow(/continuation is invalid/)
    writeDemoResume(storage, null)
    expect(readDemoResume(storage, 0)).toBeNull()
  })

  it("does not claim persistence when browser storage refuses access", () => {
    const denied = (): never => { throw new DOMException("Storage disabled", "SecurityError") }
    const storage: Storage = { length: 0, clear: denied, key: denied, getItem: denied, setItem: denied, removeItem: denied }
    expect(() => readDemoResume(storage, 0)).toThrow(/Storage disabled/)
    expect(() => writeDemoResume(storage, null)).toThrow(/Storage disabled/)
  })

  it("labels fixture corpus counts and provenance without live-snapshot or publication claims", () => {
    const presentation = getDemoCorpusPresentation(makeFeed({
      rankingSource: "fixture_posts_shadow_weights",
      corpusHealth: {
        status: "fallback",
        candidatePostCount: 13,
        publicScoredPostCount: 12,
        displayedPublicPostCount: 12,
        displayedHiddenPostCount: 1,
        uniqueAuthorCount: 10,
        collectedAt: "2026-07-11T01:00:00.000Z",
        frozenForSession: true,
      },
    }))

    expect(presentation.usesMechanicsFixture).toBe(true)
    expect(`${presentation.provenanceLine} ${presentation.metricsLine}`).toMatch(/mechanics fixture/i)
    expect(presentation.metricsLine).toMatch(/13 fixture items.*12 rankable/i)
    expect(`${presentation.provenanceLine} ${presentation.metricsLine}`).not.toMatch(/published entries|reviewed snapshot|live snapshot|captured/i)
  })

  it("keeps the fixture live-proof panel separate and omits the fixture timestamp", () => {
    const presentation = getLiveProofPresentation(snapshotProvenance, true)

    expect(presentation.feedName).toBe("Corgi Commons")
    expect(presentation.sourceTimestamp).toBeNull()
    expect(presentation.description).toContain("mechanics fixture")
    expect(COMMUNITY_GOV_FEED_URL).toBe("https://bsky.app/profile/corgi-network.bsky.social/feed/community-gov")
    expect(`${presentation.eyebrow} ${presentation.description}`).not.toMatch(/reviewed snapshot|live snapshot|snapshot captured|Jul 11, 2026/i)
  })

  it("derives snapshot live-proof labels and source time from contract provenance", () => {
    const presentation = getLiveProofPresentation(snapshotProvenance, false)

    expect(presentation.eyebrow).toBe("Snapshot source live on Bluesky")
    expect(presentation.feedName).toBe("Corgi Commons")
    expect(presentation.description).toMatch(/published-feed comparison corpus/i)
    expect(presentation.sourceTimestamp).toMatch(/Jul 11, 2026.*UTC/i)
    expect(presentation.description).not.toMatch(/reviewed snapshot/i)
  })

  it("shows a concise degraded warning and bounds unsafe diagnostic detail", () => {
    expect(getDegradedCorpusWarning([
      { code: "snapshot_unavailable", message: "The approved snapshot could not be loaded. Using the mechanics fixture.", recoverable: false },
    ])).toMatch(/approved snapshot could not be loaded/i)
    expect(getDegradedCorpusWarning([
      { code: "raw_failure", message: "x".repeat(181), recoverable: false },
    ])).toBe("The published-feed snapshot is unavailable, so this session is using a mechanics fixture.")
  })

  it("creates distinct receipt announcements for same-epoch post selections", () => {
    const first = getReceiptSelectionAnnouncement(1, false)
    const second = getReceiptSelectionAnnouncement(7, false)

    expect(first).toBe("Receipt view opened for rank 1. Loading ranking details.")
    expect(second).toBe("Receipt view opened for rank 7. Loading ranking details.")
    expect(first).not.toBe(second)
    expect(getReceiptSelectionAnnouncement(7, true)).toBe("Ranking receipt ready for rank 7.")
  })

  it("moves focus and announces every receipt selection, including within one epoch", () => {
    expect(demoPageSource).toMatch(/setReceiptFocusRequest\(\(current\) => current \+ 1\)/)
    expect(demoPageSource).toMatch(/panel\.focus\(\{ preventScroll: true \}\)/)
    expect(demoPageSource).toMatch(
      /\[mobileView, receiptFocusRequest, reduceMotion, reranked, selectedUri\]/,
    )
    expect(demoPageSource).toMatch(/aria-live="polite" aria-atomic="true"[\s\S]*?\{receiptAnnouncement\}/)
  })

  it("keeps every desktop workflow panel bounded with independently scrolling content", () => {
    expect(panelLayoutSource).toMatch(/xl:max-h-\[calc\(100dvh-7rem\)\]/)
    expect(panelLayoutSource).toMatch(/xl:overflow-y-auto/)
    expect(panelLayoutSource).toMatch(/xl:overscroll-contain/)
    expect(panelLayoutSource).toMatch(/xl:\[scrollbar-gutter:stable\]/)
    expect(votePanelSource.match(/className=\{DEMO_PANEL_FRAME_CLASS\}/g)).toHaveLength(1)
    expect(votePanelSource.match(/className=\{`\$\{DEMO_PANEL_SCROLL_BODY_CLASS\}/g)).toHaveLength(1)
    expect(agentsPanelSource.match(/className=\{DEMO_PANEL_FRAME_CLASS\}/g)).toHaveLength(2)
    expect(agentsPanelSource.match(/className=\{`\$\{DEMO_PANEL_SCROLL_BODY_CLASS\}/g)).toHaveLength(2)
    expect(receiptPanelSource.match(/<aside className=\{`\$\{DEMO_PANEL_FRAME_CLASS\}/g)).toHaveLength(1)
    expect(receiptPanelSource.match(/className=\{`\$\{DEMO_PANEL_SCROLL_BODY_CLASS\}/g)).toHaveLength(1)
    expect(votePanelSource).toMatch(/data-demo-panel-footer="vote"[^>]*xl:shrink-0[\s\S]{0,700}STEP_PANELS\.vote\.cta/)
    expect(agentsPanelSource).toMatch(/data-demo-panel-footer="community"[^>]*xl:shrink-0[\s\S]{0,700}STEP_PANELS\.agents\.cta/)
    expect(agentsPanelSource).toMatch(/data-demo-panel-footer="epoch"[^>]*xl:shrink-0[\s\S]{0,700}STEP_PANELS\.epoch\.cta/)
    expect(receiptPanelSource).toMatch(/data-demo-panel-footer="receipt"[^>]*xl:shrink-0[\s\S]{0,700}Run another epoch/)
  })

  it("makes every independent desktop scrollport keyboard-focusable and named", () => {
    expect(votePanelSource).toMatch(/role="region"[\s\S]{0,120}aria-label="Demo policy controls"[\s\S]{0,80}tabIndex=\{0\}/)
    expect(agentsPanelSource).toMatch(/aria-label="Community ballot simulation details"[\s\S]{0,80}tabIndex=\{0\}/)
    expect(agentsPanelSource).toMatch(/aria-label="Aggregated community policy details"[\s\S]{0,80}tabIndex=\{0\}/)
    expect(receiptPanelSource).toMatch(/aria-label="Ranking receipt details"[\s\S]{0,80}tabIndex=\{0\}/)
    expect(panelLayoutSource).toMatch(/xl:focus-visible:ring-2/)
  })

  it("submits a complete 26-topic policy and preserves a fine-tuned value", () => {
    const topicCatalog = Array.from({ length: 26 }, (_, index) => ({
      slug: `topic-${index}`,
      name: `Topic ${index}`,
      description: null,
      baselineWeight: 0.5,
    }))
    const presetTopicIntent = {
      topicWeights: Object.fromEntries(topicCatalog.map((topic) => [topic.slug, 0.5])),
    }
    const editedTopicIntent = {
      topicWeights: { ...presetTopicIntent.topicWeights, "topic-7": 0.83 },
    }

    expect(getEditedTopicSlugs(editedTopicIntent, presetTopicIntent, topicCatalog)).toEqual(["topic-7"])
    expect(getEditedTopicSlugs(presetTopicIntent, presetTopicIntent, topicCatalog)).toEqual([])

    const submission = createDemoVoteSubmission(
      { recency: 0.4, engagement: 0.4, bridging: 0.4, source_diversity: 0.4, relevance: 0.4 },
      editedTopicIntent,
      topicCatalog,
    )

    expect(Object.keys(submission.topicIntent.topicWeights)).toHaveLength(26)
    expect(submission.topicIntent.topicWeights["topic-7"]).toBe(0.83)
    expect(Object.values(submission.weights).reduce((total, value) => total + value, 0)).toBeCloseTo(1)
  })

  it("uses one shared edit threshold and resets edited topics to the preset", () => {
    const topicCatalog = [{
      slug: "research",
      name: "Research",
      description: null,
      baselineWeight: 0.5,
    }]
    const presetTopicIntent = { topicWeights: { research: 0.5 } }

    expect(getEditedTopicSlugs(
      { topicWeights: { research: 0.5 + POLICY_EDIT_THRESHOLD } },
      presetTopicIntent,
      topicCatalog,
    )).toEqual(["research"])
    expect(getEditedTopicSlugs(
      { topicWeights: { research: 0.5049 } },
      presetTopicIntent,
      topicCatalog,
    )).toEqual([])
    expect(getEditedTopicSlugs(presetTopicIntent, presetTopicIntent, topicCatalog)).toEqual([])
  })

  it("shows the raw relative signal setting and validates with the shared ballot rules", () => {
    const weights = {
      recency: 0.4,
      engagement: 0.2,
      bridging: 0.2,
      source_diversity: 0.1,
      relevance: 0.1,
    }
    const topicCatalog = [{
      slug: "research",
      name: "Research",
      description: null,
      baselineWeight: 0.5,
    }]
    const validation = validateDemoVoteSubmission(
      weights,
      { topicWeights: { research: 0.5 } },
      topicCatalog,
    )

    expect(formatPolicySliderValue(weights.recency)).toBe("40%")
    expect(validation.valid).toBe(true)
    expect(votePanelSource).toMatch(/displayValue=\{rawWeights\[key\]\}/)
    expect(votePanelSource).toMatch(/Corgi normalizes them to 100%/)
  })

  it("fails closed when a demo ballot omits a topic", () => {
    const topicCatalog = Array.from({ length: 26 }, (_, index) => ({
      slug: `topic-${index}`,
      name: `Topic ${index}`,
      description: null,
      baselineWeight: 0.5,
    }))
    const incompleteTopicIntent = {
      topicWeights: Object.fromEntries(topicCatalog.slice(0, 25).map((topic) => [topic.slug, 0.5])),
    }

    expect(() => createDemoVoteSubmission(
      { recency: 0.2, engagement: 0.2, bridging: 0.2, source_diversity: 0.2, relevance: 0.2 },
      incompleteTopicIntent,
      topicCatalog,
    )).toThrow(/exactly the 26 catalog topics/i)
  })

  it("fails closed when a demo signal weight is outside the slider contract", () => {
    const topicCatalog = Array.from({ length: 26 }, (_, index) => ({
      slug: `topic-${index}`,
      name: `Topic ${index}`,
      description: null,
      baselineWeight: 0.5,
    }))
    const topicIntent = {
      topicWeights: Object.fromEntries(topicCatalog.map((topic) => [topic.slug, 0.5])),
    }

    expect(() => createDemoVoteSubmission(
      { recency: -0.1, engagement: 0.2, bridging: 0.3, source_diversity: 0.3, relevance: 0.3 },
      topicIntent,
      topicCatalog,
    )).toThrow(/signal recency has invalid weight/i)
  })

  it("uses one accessible slider system for signals and topics", () => {
    expect(votePanelSource).toMatch(/import \{ Slider \} from "@\/components\/ui\/slider"/)
    expect(votePanelSource).not.toMatch(/<input type="range"/)
    expect(votePanelSource).toMatch(/Your custom policy/)
    expect(votePanelSource).toMatch(/Every ballot carries all/)
    expect(votePanelSource).toMatch(/onClick=\{submitPolicy\}/)
    expect(sliderSource).toMatch(/thumbValues\.map/)
  })
})
