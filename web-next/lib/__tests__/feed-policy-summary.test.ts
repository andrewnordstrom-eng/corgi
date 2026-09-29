import { describe, expect, it } from "vitest"
import { joinLabels, summarizeFeedPolicy } from "@/components/feed/feed-policy-summary"
import type { PublicFeedItem, PublicFeedRankedItem, PublicFeedSnapshot } from "../public-feed"

function rankedItem(position: number, method: "keyword" | "embedding" = "keyword"): PublicFeedRankedItem {
  return {
    position,
    epoch_id: 2,
    ranked_position: position,
    placement: "ranked",
    post_uri: `at://did:plc:test/app.bsky.feed.post/${position}`,
    base_score: 0.8,
    publication_adjustment: 1,
    final_score: 0.8,
    components: {
      recency: { raw_score: 0.9, weight: 0.25, weighted: 0.225 },
      engagement: { raw_score: 0.5, weight: 0.2, weighted: 0.1 },
      bridging: { raw_score: 0.5, weight: 0.1, weighted: 0.05 },
      source_diversity: { raw_score: 1, weight: 0.1, weighted: 0.1 },
      relevance: { raw_score: 0.9, weight: 0.35, weighted: 0.315 },
    },
    source_score_run_id: "run-1",
    scored_at: "2026-09-29T04:30:00.000Z",
    classification_method: method,
    engagement_only_position: position,
  }
}

function snapshot(
  items: readonly PublicFeedItem[],
  weights: PublicFeedSnapshot["active_weights"] = {
    recency: 0.25,
    engagement: 0.2,
    bridging: 0.1,
    source_diversity: 0.1,
    relevance: 0.35,
  },
): PublicFeedSnapshot {
  return {
    schema_version: 1,
    feed_uri: "at://did:plc:test/app.bsky.feed.generator/community-gov",
    presentation_snapshot_id: "snapshot-1",
    publication_run_id: "run-1",
    epoch_id: 2,
    published_at: "2026-09-29T04:30:00.000Z",
    status: "current",
    total_published_items: 1000,
    expected_refresh_seconds: 300,
    active_weights: weights,
    items: [...items],
  }
}

describe("summarizeFeedPolicy", () => {
  it("shows the snapshot's active weights in canonical signal order", () => {
    const summary = summarizeFeedPolicy(snapshot([rankedItem(1)]))
    expect(summary.epochId).toBe(2)
    expect(summary.weights.map((entry) => [entry.key, entry.percent])).toEqual([
      ["recency", "25%"],
      ["engagement", "20%"],
      ["bridging", "10%"],
      ["source_diversity", "10%"],
      ["relevance", "35%"],
    ])
    expect(summary.weights.reduce((sum, entry) => sum + entry.share, 0)).toBeCloseTo(1, 10)
    expect(summary.leadingLabels).toEqual(["Relevance"])
  })

  it("follows the payload instead of assuming relevance leads", () => {
    const summary = summarizeFeedPolicy(snapshot([rankedItem(1)], {
      recency: 0.2,
      engagement: 0.3,
      bridging: 0.2,
      source_diversity: 0.15,
      relevance: 0.15,
    }))
    expect(summary.leadingLabels).toEqual(["Engagement"])
    expect(summary.weights.find((entry) => entry.key === "engagement")?.share).toBeCloseTo(0.3, 10)
  })

  it("names every signal tied for the largest weight", () => {
    const summary = summarizeFeedPolicy(snapshot([rankedItem(1)], {
      recency: 0.3,
      engagement: 0.1,
      bridging: 0.1,
      source_diversity: 0.2,
      relevance: 0.3,
    }))
    expect(summary.leadingLabels).toEqual(["Recency", "Relevance"])
  })

  it("claims keyword topic detection only when every scored row used it", () => {
    const withheld: PublicFeedItem = { position: 2, placement: "withheld", reason: "Post withheld from the public view" }
    expect(summarizeFeedPolicy(snapshot([rankedItem(1), withheld])).keywordOnly).toBe(true)
    expect(summarizeFeedPolicy(snapshot([rankedItem(1), rankedItem(2, "embedding")])).keywordOnly).toBe(false)
    expect(summarizeFeedPolicy(snapshot([withheld])).keywordOnly).toBe(false)
  })
})

describe("joinLabels", () => {
  it("joins one, two, and several labels as prose", () => {
    expect(joinLabels(["Relevance"])).toBe("Relevance")
    expect(joinLabels(["Recency", "Relevance"])).toBe("Recency and Relevance")
    expect(joinLabels(["Recency", "Bridging", "Relevance"])).toBe("Recency, Bridging, and Relevance")
  })
})
