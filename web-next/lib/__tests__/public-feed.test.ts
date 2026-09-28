import { afterEach, describe, expect, it, vi } from "vitest"
import {
  APPVIEW_BATCH_SIZE,
  PUBLIC_FEED_APPVIEW_TIMEOUT_MS,
  PUBLIC_FEED_MAX_REQUESTS_PER_REFRESH,
  PUBLIC_FEED_SNAPSHOT_TIMEOUT_MS,
  loadPublicFeed,
  isPublicFeedRow,
  publicFeedSnapshotSchema,
  retainSelectedUri,
  splitPostUris,
  strongestContribution,
} from "../public-feed"
import type { PublicFeedItem, PublicFeedRankedItem, PublicFeedSnapshot } from "../public-feed"
import {
  BlueskyPublicDataError,
  bskyPostUrlFromAtUri,
  buildPostHydrationUrl,
} from "../bluesky-public"

afterEach(() => {
  vi.useRealTimers()
})

function rankedItem(position: number, uri: string): PublicFeedRankedItem {
  return {
    position,
    epoch_id: 7,
    ranked_position: position,
    placement: "ranked",
    post_uri: uri,
    base_score: 0.4,
    publication_adjustment: 1,
    final_score: 0.4,
    components: {
      recency: { raw_score: 0.2, weight: 0.1, weighted: 0.02 },
      engagement: { raw_score: 0.4, weight: 0.4, weighted: 0.16 },
      bridging: { raw_score: 0.5, weight: 0.2, weighted: 0.1 },
      source_diversity: { raw_score: 0.55, weight: 0.2, weighted: 0.11 },
      relevance: { raw_score: 0.1, weight: 0.1, weighted: 0.01 },
    },
    source_score_run_id: "run-1",
    scored_at: "2026-09-02T17:00:00.000Z",
    classification_method: "keyword",
    engagement_only_position: position,
  }
}

function snapshot(items: readonly PublicFeedItem[]): PublicFeedSnapshot {
  return {
    schema_version: 1,
    feed_uri: "at://did:plc:test/app.bsky.feed.generator/community-gov",
    presentation_snapshot_id: "snapshot-1",
    publication_run_id: "run-1",
    epoch_id: 7,
    published_at: "2026-09-02T17:00:00.000Z",
    status: "current",
    total_published_items: items.length,
    expected_refresh_seconds: 300,
    active_weights: {
      recency: 0.1,
      engagement: 0.4,
      bridging: 0.2,
      source_diversity: 0.2,
      relevance: 0.1,
    },
    items: [...items],
  }
}

function appViewPost(uri: string): Record<string, unknown> {
  return {
    uri,
    author: { did: uri.split("/")[2], handle: "ada.example", displayName: "Ada" },
    record: { text: `Post ${uri}` },
    indexedAt: "2026-09-02T17:00:00.000Z",
  }
}

describe("public feed contract", () => {
  it("enforces the Bluesky AppView 25-URI hydration limit", () => {
    const accepted = Array.from({ length: 25 }, (_, index) => `at://did:plc:test/app.bsky.feed.post/${index}`)
    expect(new URL(buildPostHydrationUrl(accepted)).searchParams.getAll("uris")).toEqual(accepted)
    expect(() => buildPostHydrationUrl([...accepted, "at://did:plc:test/app.bsky.feed.post/25"]))
      .toThrow(BlueskyPublicDataError)
  })

  it("encodes Bluesky profile and record-key URL segments", () => {
    const url = bskyPostUrlFromAtUri("at://did:plc:test/app.bsky.feed.post/a#b")
    expect(url).toBe("https://bsky.app/profile/did:plc:test/post/a%23b")
  })

  it("rejects unknown snapshot fields and invalid ranked/pinned nullability", () => {
    expect(publicFeedSnapshotSchema.safeParse({ ...snapshot([]), unexpected: true }).success).toBe(false)
    expect(publicFeedSnapshotSchema.safeParse({
      ...snapshot([rankedItem(1, "at://did:plc:test/app.bsky.feed.post/a")]),
      items: [{ ...rankedItem(1, "at://did:plc:test/app.bsky.feed.post/a"), final_score: null }],
    }).success).toBe(false)
  })

  it("accepts scored and scoreless pinned announcements but not mixed evidence", () => {
    const ranked = rankedItem(3, "at://did:plc:test/app.bsky.feed.post/pinned")
    const scoredPinned = { ...ranked, placement: "pinned_announcement" as const }
    const scorelessPinned = {
      position: 1,
      epoch_id: null,
      ranked_position: null,
      placement: "pinned_announcement" as const,
      post_uri: "at://did:plc:test/app.bsky.feed.post/inserted",
      base_score: null,
      publication_adjustment: null,
      final_score: null,
      components: null,
      source_score_run_id: null,
      scored_at: null,
      classification_method: null,
      engagement_only_position: null,
    }
    expect(publicFeedSnapshotSchema.safeParse({ ...snapshot([]), items: [scoredPinned, scorelessPinned] }).success).toBe(true)
    expect(publicFeedSnapshotSchema.safeParse({
      ...snapshot([]),
      items: [{ ...scoredPinned, final_score: null }],
    }).success).toBe(false)
  })

  it("caps hydration at two ordered batches of at most 25", () => {
    const uris = Array.from({ length: 50 }, (_, index) => `uri-${index + 1}`)
    const batches = splitPostUris(uris)
    expect(batches).toHaveLength(2)
    expect(batches.every((batch) => batch.length <= APPVIEW_BATCH_SIZE)).toBe(true)
    expect(batches.flat()).toEqual(uris)
    expect(() => splitPostUris([...uris, "uri-51"])).toThrow(/public limit is 50/)
  })

  it("uses one snapshot request plus at most two parallel hydration requests", async () => {
    const items = Array.from({ length: 50 }, (_, index) => (
      rankedItem(index + 1, `at://did:plc:test/app.bsky.feed.post/${index + 1}`)
    ))
    const requestedHydrationUrls: string[] = []
    let activeHydrations = 0
    let peakHydrations = 0
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.includes("feed-snapshot")) {
        return new Response(JSON.stringify(snapshot(items)), {
          status: 200,
          headers: { "Content-Type": "application/json", ETag: '"snapshot-1"' },
        })
      }

      requestedHydrationUrls.push(url)
      activeHydrations += 1
      peakHydrations = Math.max(peakHydrations, activeHydrations)
      await Promise.resolve()
      activeHydrations -= 1
      const parsedUrl = new URL(url)
      return new Response(JSON.stringify({
        posts: parsedUrl.searchParams.getAll("uris").map(appViewPost),
      }), { status: 200, headers: { "Content-Type": "application/json" } })
    })

    const result = await loadPublicFeed(new AbortController().signal, null, fetcher, null)
    expect(result.kind).toBe("loaded")
    if (result.kind !== "loaded") throw new Error("Expected a loaded result")
    expect(fetcher).toHaveBeenCalledTimes(PUBLIC_FEED_MAX_REQUESTS_PER_REFRESH)
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("/api/transparency/feed-snapshot?limit=50")
    expect(fetcher.mock.calls[0]?.[1]?.credentials).toBe("omit")
    expect(fetcher.mock.calls[0]?.[1]?.cache).toBe("no-store")
    expect(requestedHydrationUrls).toHaveLength(2)
    expect(peakHydrations).toBe(2)
    expect(result.data.rows.filter(isPublicFeedRow).map((row) => row.item.post_uri)).toEqual(items.map((item) => item.post_uri))
  })

  it("rejects 304 without a matching cached snapshot", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 304 }))
    await expect(loadPublicFeed(new AbortController().signal, null, fetcher, null))
      .rejects.toMatchObject({ kind: "contract" })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("preserves generic withheld positions and never hydrates, selects, or stores their URI", async () => {
    const first = rankedItem(1, "at://did:plc:test/app.bsky.feed.post/public-a")
    const withheld = {
      position: 2,
      placement: "withheld" as const,
      reason: "Post withheld from the public view" as const,
    }
    const last = rankedItem(3, "at://did:plc:test/app.bsky.feed.post/public-b")
    const privateUri = "at://did:plc:secret/app.bsky.feed.post/hidden"
    const hydrationRequests: string[][] = []
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (String(input).includes("feed-snapshot")) {
        return new Response(JSON.stringify(snapshot([first, withheld, last])), {
          status: 200,
          headers: { ETag: '"withheld-mask"' },
        })
      }
      const uris = new URL(String(input)).searchParams.getAll("uris")
      hydrationRequests.push(uris)
      return new Response(JSON.stringify({ posts: uris.map(appViewPost) }), { status: 200 })
    })

    const result = await loadPublicFeed(new AbortController().signal, null, fetcher, null)

    expect(result.data.rows.map((row) => row.item.position)).toEqual([1, 2, 3])
    expect(result.data.rows[1]).toEqual({ item: withheld, post: null })
    expect(hydrationRequests.flat()).toEqual([first.post_uri, last.post_uri])
    expect(hydrationRequests.flat().join(" ")).not.toContain(privateUri)
    expect(JSON.stringify(result.data.rows[1])).not.toContain(privateUri)
    expect(publicFeedSnapshotSchema.safeParse({ ...snapshot([first, withheld, last]), items: [
      first, { ...withheld, post_uri: privateUri }, last,
    ] }).success).toBe(false)
    expect(retainSelectedUri("at://did:plc:secret/app.bsky.feed.post/hidden", result.data.rows)).toBe(first.post_uri)
  })

  it("replaces a same-publication visible row when the server returns a changed withholding mask", async () => {
    const previouslyVisible = rankedItem(1, "at://did:plc:test/app.bsky.feed.post/newly-withheld")
    const remaining = rankedItem(2, "at://did:plc:test/app.bsky.feed.post/still-public")
    const withheld = { position: 1, placement: "withheld" as const, reason: "Post withheld from the public view" as const }
    let refresh = false
    const hydrationRequests: string[][] = []
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (String(input).includes("feed-snapshot")) {
        return new Response(JSON.stringify(refresh
          ? snapshot([withheld, remaining])
          : snapshot([previouslyVisible, remaining])), {
          status: 200,
          headers: { ETag: refresh ? '"mask-2"' : '"mask-1"' },
        })
      }
      const uris = new URL(String(input)).searchParams.getAll("uris")
      hydrationRequests.push(uris)
      return new Response(JSON.stringify({ posts: uris.map(appViewPost) }), { status: 200 })
    })
    const initial = await loadPublicFeed(new AbortController().signal, null, fetcher, null)
    refresh = true

    const changed = await loadPublicFeed(new AbortController().signal, initial.data, fetcher, initial.data)

    expect(changed.kind).toBe("loaded")
    expect(changed.data.rows.map((row) => row.item.position)).toEqual([1, 2])
    expect(changed.data.rows[0]).toEqual({ item: withheld, post: null })
    expect(hydrationRequests.at(-1)).toEqual([remaining.post_uri])
    expect(JSON.stringify(changed.data)).not.toContain(previouslyVisible.post_uri)
    expect(retainSelectedUri(previouslyVisible.post_uri, changed.data.rows)).toBe(remaining.post_uri)
  })

  it.each(["deleted", "!hide", "!no-unauthenticated", "porn"])("rehydrates unchanged ranking and withdraws %s content", async (visibility) => {
    const item = rankedItem(1, "at://did:plc:test/app.bsky.feed.post/a")
    let refresh = false
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (String(input).includes("feed-snapshot")) {
        return refresh ? new Response(null, { status: 304 }) : new Response(JSON.stringify(snapshot([item])), {
          status: 200, headers: { ETag: '\"snapshot-1\"' },
        })
      }
      return new Response(JSON.stringify({ posts: refresh
        ? visibility === "deleted" ? [] : [{ ...appViewPost(item.post_uri), labels: [{ val: visibility }] }]
        : [appViewPost(item.post_uri)],
      }), { status: 200 })
    })
    const initial = await loadPublicFeed(new AbortController().signal, null, fetcher, null)
    expect(initial.data.rows[0].post?.visibility).toBe("public")
    refresh = true
    fetcher.mockClear()
    const refreshed = await loadPublicFeed(new AbortController().signal, initial.data, fetcher, initial.data)
    expect(refreshed.data.rows[0]).toMatchObject({ item: { placement: "withheld" }, post: null })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("If-None-Match")).toBe(initial.data.etag)
    expect(fetcher.mock.calls[1]?.[1]?.cache).toBe("no-store")
  })

  it("clears old content while a different ranking is pending, then hydrates accepted order", async () => {
    const a = rankedItem(1, "at://did:plc:test/app.bsky.feed.post/a")
    const b = rankedItem(1, "at://did:plc:test/app.bsky.feed.post/b")
    let refresh = false
    const hydratedUris: string[][] = []
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (String(input).includes("feed-snapshot")) {
        return new Response(JSON.stringify(refresh
          ? { ...snapshot([b]), presentation_snapshot_id: "snapshot-2", publication_run_id: "run-2" }
          : snapshot([a])), { status: 200, headers: { ETag: refresh ? '\"snapshot-2\"' : '\"snapshot-1\"' } })
      }
      const uris = new URL(String(input)).searchParams.getAll("uris")
      hydratedUris.push(uris)
      return new Response(JSON.stringify({ posts: uris.map(appViewPost) }), { status: 200 })
    })
    const initial = await loadPublicFeed(new AbortController().signal, null, fetcher, null)
    refresh = true
    const update = await loadPublicFeed(new AbortController().signal, initial.data, fetcher, initial.data)
    expect(hydratedUris).toHaveLength(1)
    expect(update.kind).toBe("pending")
    expect(update.pendingSnapshotId).toBe("snapshot-2")
    expect(update.data.rows.every((row) => row.item.placement === "withheld")).toBe(true)
    expect(update.displayedData).toBeNull()
    expect(JSON.stringify(update)).not.toContain(a.post_uri)
    expect(JSON.stringify(update)).not.toContain(b.post_uri)
    const repeat = await loadPublicFeed(new AbortController().signal, initial.data, fetcher, initial.data)
    expect(repeat.kind).toBe("pending")
    expect(hydratedUris).toHaveLength(1)
    const accepted = await loadPublicFeed(new AbortController().signal, initial.data, fetcher, null)
    expect(hydratedUris.at(-1)).toEqual([b.post_uri])
    expect(accepted.data.rows[0].post?.visibility).toBe("public")
    expect(accepted.data.snapshot.presentation_snapshot_id).toBe("snapshot-2")
    expect(accepted.data.requestCount).toBeLessThanOrEqual(PUBLIC_FEED_MAX_REQUESTS_PER_REFRESH)
  })

  it("reports background 503 as unavailable without hydrating or silently reusing the cache", async () => {
    const item = rankedItem(1, "at://did:plc:test/app.bsky.feed.post/a")
    const initialFetcher = vi.fn<typeof fetch>(async (input) => new Response(JSON.stringify(
      String(input).includes("feed-snapshot") ? snapshot([item]) : { posts: [appViewPost(item.post_uri)] },
    ), { status: 200 }))
    const initial = await loadPublicFeed(new AbortController().signal, null, initialFetcher, null)
    const fetcher = vi.fn<typeof fetch>(async () => new Response("unavailable", { status: 503 }))
    await expect(loadPublicFeed(new AbortController().signal, initial.data, fetcher, initial.data))
      .rejects.toMatchObject({ kind: "unavailable" })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("keeps a 50-row 304 visibility refresh within two AppView batches", async () => {
    const items = Array.from({ length: 50 }, (_, index) => rankedItem(index + 1, `at://did:plc:test/app.bsky.feed.post/${index}`))
    let refresh = false
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (String(input).includes("feed-snapshot")) return refresh
        ? new Response(null, { status: 304 }) : new Response(JSON.stringify(snapshot(items)), { status: 200 })
      return new Response(JSON.stringify({ posts: new URL(String(input)).searchParams.getAll("uris").map(appViewPost) }), { status: 200 })
    })
    const initial = await loadPublicFeed(new AbortController().signal, null, fetcher, null)
    refresh = true
    fetcher.mockClear()
    const result = await loadPublicFeed(new AbortController().signal, initial.data, fetcher, initial.data)
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(result.data.requestCount).toBe(3)
    expect(result.data.rows.map((row) => row.item)).toEqual(items)
    expect(result.displayedData?.rows.every((row) => row.post !== null && row.post.visibility === "public")).toBe(true)
  })

  it("bounds the snapshot request and reports a timeout distinctly", async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
    }))

    const result = loadPublicFeed(new AbortController().signal, null, fetcher, null)
    const rejection = expect(result).rejects.toMatchObject({
      name: "PublicFeedDataError",
      kind: "request",
      message: `Public feed snapshot timed out after ${PUBLIC_FEED_SNAPSHOT_TIMEOUT_MS}ms`,
    })
    await vi.advanceTimersByTimeAsync(PUBLIC_FEED_SNAPSHOT_TIMEOUT_MS)
    await rejection
  })

  it("preserves caller cancellation instead of misreporting it as a timeout", async () => {
    vi.useFakeTimers()
    const caller = new AbortController()
    const callerError = new DOMException("User navigated away", "AbortError")
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
    }))

    const result = loadPublicFeed(caller.signal, null, fetcher, null)
    const rejection = expect(result).rejects.toBe(callerError)
    caller.abort(callerError)
    await rejection
    expect(vi.getTimerCount()).toBe(0)
  })

  it("bounds AppView hydration and rejects unverified ranked metadata", async () => {
    vi.useFakeTimers()
    const item = rankedItem(1, "at://did:plc:test/app.bsky.feed.post/a")
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes("feed-snapshot")) {
        return new Response(JSON.stringify(snapshot([item])), { status: 200 })
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
      })
    })

    const resultPromise = loadPublicFeed(new AbortController().signal, null, fetcher, null)
    const rejection = expect(resultPromise).rejects.toMatchObject({ kind: "request" })
    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(PUBLIC_FEED_APPVIEW_TIMEOUT_MS)
    await rejection
    expect(vi.getTimerCount()).toBe(0)
  })

  it("cleans up the AppView timeout when hydration is cancelled by the caller", async () => {
    vi.useFakeTimers()
    const caller = new AbortController()
    const callerError = new DOMException("Feed view unmounted", "AbortError")
    const item = rankedItem(1, "at://did:plc:test/app.bsky.feed.post/a")
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes("feed-snapshot")) {
        return new Response(JSON.stringify(snapshot([item])), { status: 200 })
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
      })
    })

    const result = loadPublicFeed(caller.signal, null, fetcher, null)
    const rejection = expect(result).rejects.toBe(callerError)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)
    caller.abort(callerError)
    await rejection
    expect(vi.getTimerCount()).toBe(0)
  })

  it("withholds only an omitted hydration URI and scrubs it from retained snapshot state", async () => {
    const first = rankedItem(1, "at://did:plc:test/app.bsky.feed.post/a")
    const second = rankedItem(2, "at://did:plc:test/app.bsky.feed.post/b")
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (String(input).includes("feed-snapshot")) {
        return new Response(JSON.stringify(snapshot([first, second])), { status: 200 })
      }
      return new Response(JSON.stringify({ posts: [appViewPost(second.post_uri)] }), { status: 200 })
    })
    const result = await loadPublicFeed(new AbortController().signal, null, fetcher, null)
    expect(result.data.rows.map((row) => row.item.position)).toEqual([1, 2])
    expect(result.data.rows[0]).toMatchObject({ item: { placement: "withheld", position: 1 }, post: null })
    expect(result.data.rows[1].item.position).toBe(2)
    expect(JSON.stringify(result.data)).not.toContain(first.post_uri)
  })

  it("rechecks a locally withheld URI instead of reusing the upstream ETag", async () => {
    const first = rankedItem(1, "at://did:plc:test/app.bsky.feed.post/recover")
    let omit = true
    const snapshotReads: Headers[] = []
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes("feed-snapshot")) {
        snapshotReads.push(new Headers(init?.headers))
        return new Response(JSON.stringify(snapshot([first])), { status: 200, headers: { ETag: '"same-publication"' } })
      }
      return new Response(JSON.stringify({ posts: omit ? [] : [appViewPost(first.post_uri)] }), { status: 200 })
    })
    const masked = await loadPublicFeed(new AbortController().signal, null, fetcher, null)
    expect(masked.data.rows[0]).toMatchObject({ item: { placement: "withheld" }, post: null })
    expect(masked.data.etag).toBe("")
    omit = false
    const recovered = await loadPublicFeed(new AbortController().signal, masked.data, fetcher, masked.data)
    expect(snapshotReads[1]?.get("If-None-Match")).toBeNull()
    expect(recovered.data.rows[0].post?.visibility).toBe("public")
  })

  it.each(["duplicate", "unexpected", "malformed", "failure"])("rejects %s hydration without returning snapshot metadata", async (mode) => {
    const item = rankedItem(1, "at://did:plc:test/app.bsky.feed.post/a")
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (String(input).includes("feed-snapshot")) return new Response(JSON.stringify(snapshot([item])), { status: 200 })
      if (mode === "failure") throw new TypeError("synthetic transport failure")
      const posts = mode === "duplicate" ? [appViewPost(item.post_uri), appViewPost(item.post_uri)]
        : mode === "unexpected" ? [appViewPost("at://did:plc:other/app.bsky.feed.post/b")]
          : [{ uri: item.post_uri }]
      return new Response(JSON.stringify({ posts }), { status: 200 })
    })
    await expect(loadPublicFeed(new AbortController().signal, null, fetcher, null)).rejects.toBeInstanceOf(Error)
  })

  it("withholds cached metadata when the current author DID differs from the requested URI", async () => {
    const item = rankedItem(1, "at://did:plc:test/app.bsky.feed.post/a")
    let refresh = false
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (String(input).includes("feed-snapshot")) return refresh
        ? new Response(null, { status: 304 }) : new Response(JSON.stringify(snapshot([item])), { status: 200 })
      const post = appViewPost(item.post_uri)
      return new Response(JSON.stringify({ posts: [refresh
        ? { ...post, author: { did: "did:plc:wrong", handle: "wrong.example" } }
        : post] }), { status: 200 })
    })
    const initial = await loadPublicFeed(new AbortController().signal, null, fetcher, null)
    expect(initial.data.rows[0].post?.visibility).toBe("public")
    refresh = true
    await expect(loadPublicFeed(new AbortController().signal, initial.data, fetcher, initial.data))
      .rejects.toMatchObject({ kind: "unavailable" })
  })

  it("selects the strongest weighted contribution and retains URI selection", () => {
    const item = rankedItem(1, "at://did:plc:test/app.bsky.feed.post/a")
    expect(strongestContribution(item).key).toBe("engagement")
    const rows = [{
      item,
      post: { visibility: "public" as const, uri: item.post_uri, bskyUrl: "https://bsky.app/profile/test/post/a", authorHandle: "test", authorDisplayName: "Test", authorAvatar: null, text: "Test", indexedAt: null, likeCount: null, repostCount: null, replyCount: null, languages: [] },
    }]
    expect(retainSelectedUri(item.post_uri, rows)).toBe(item.post_uri)
    expect(retainSelectedUri("missing", rows)).toBe(item.post_uri)
  })
})
