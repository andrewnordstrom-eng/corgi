import { expect, test } from "@playwright/test"
import type { Page, Route } from "@playwright/test"

const POST_A = "at://did:plc:alpha/app.bsky.feed.post/a"
const POST_B = "at://did:plc:beta/app.bsky.feed.post/b"
const SUPERSEDED_RESPONSE_DELAY_MS = 1_000

type AppViewMode = "complete" | "omit-first" | "hide-first" | "fail-last-batch" | "fail-all"

interface FixtureControl {
  snapshotId: string
  orderedUris: readonly string[]
  appViewMode: AppViewMode
  snapshotDelayMs: number
  snapshotStatus: 200 | 502 | 503
}

interface ObservedRequest {
  readonly method: string
  readonly url: string
}

interface FixtureObservations {
  readonly protectedRequests: string[]
  readonly snapshotRequests: ObservedRequest[]
  readonly appViewRequests: ObservedRequest[]
}

function scoreComponents(baseScore: number): Record<string, { raw_score: number; weight: number; weighted: number }> {
  const recencyWeighted = baseScore - 0.6125
  return {
    recency: { raw_score: recencyWeighted / 0.2, weight: 0.2, weighted: recencyWeighted },
    engagement: { raw_score: 0.9, weight: 0.3, weighted: 0.27 },
    bridging: { raw_score: 0.7, weight: 0.2, weighted: 0.14 },
    source_diversity: { raw_score: 0.6, weight: 0.15, weighted: 0.09 },
    relevance: { raw_score: 0.75, weight: 0.15, weighted: 0.1125 },
  }
}

function snapshotPayload(control: FixtureControl): Record<string, unknown> {
  return {
    schema_version: 1,
    feed_uri: "at://did:plc:corgi/app.bsky.feed.generator/community-gov",
    presentation_snapshot_id: control.snapshotId,
    publication_run_id: `run-${control.snapshotId}`,
    epoch_id: 12,
    published_at: new Date().toISOString(),
    status: "current",
    total_published_items: control.orderedUris.length,
    expected_refresh_seconds: 300,
    active_weights: {
      recency: 0.2,
      engagement: 0.3,
      bridging: 0.2,
      source_diversity: 0.15,
      relevance: 0.15,
    },
    items: control.orderedUris.map((uri, index) => {
      const baseScore = 0.92 - index * 0.01
      return {
        position: index + 1,
        epoch_id: 12,
        ranked_position: index + 1,
        placement: "ranked",
        post_uri: uri,
        base_score: baseScore,
        publication_adjustment: 1,
        final_score: baseScore,
        components: scoreComponents(baseScore),
        source_score_run_id: `score-${control.snapshotId}`,
        scored_at: new Date().toISOString(),
        classification_method: "keyword",
        engagement_only_position: index === 0 ? 2 : index === 1 ? 1 : index + 1,
      }
    }),
  }
}

function appViewPost(uri: string): Record<string, unknown> {
  const suffix = uri.split("/").at(-1) ?? "unknown"
  return {
    uri,
    author: {
      did: uri.split("/")[2],
      handle: `${suffix}.example`,
      displayName: `Author ${suffix.toUpperCase()}`,
    },
    record: { text: `Post ${suffix}`, langs: ["en"] },
    indexedAt: "2026-09-02T17:00:00.000Z",
    likeCount: 12,
    repostCount: 4,
    replyCount: 2,
  }
}

function assertSnapshotRequest(request: ObservedRequest): void {
  const url = new URL(request.url)
  expect(request.method).toBe("GET")
  expect(url.pathname).toBe("/api/transparency/feed-snapshot")
  expect([...url.searchParams.entries()]).toEqual([["limit", "50"]])
}

function appViewUris(request: ObservedRequest): readonly string[] {
  const url = new URL(request.url)
  return url.searchParams.getAll("uris")
}

function assertAppViewRequest(request: ObservedRequest): void {
  const url = new URL(request.url)
  expect(request.method).toBe("GET")
  expect(url.origin).toBe("https://public.api.bsky.app")
  expect(url.pathname).toBe("/xrpc/app.bsky.feed.getPosts")
  expect([...url.searchParams.keys()].every((key) => key === "uris")).toBe(true)
  const uris = url.searchParams.getAll("uris")
  expect(uris.length).toBeGreaterThan(0)
  expect(uris.length).toBeLessThanOrEqual(25)
  expect(new Set(uris).size).toBe(uris.length)
}

async function fulfillSnapshot(
  route: Route,
  control: FixtureControl,
  observations: FixtureObservations,
): Promise<void> {
  observations.snapshotRequests.push({
    method: route.request().method(),
    url: route.request().url(),
  })
  const requestControl: FixtureControl = {
    snapshotId: control.snapshotId,
    orderedUris: [...control.orderedUris],
    appViewMode: control.appViewMode,
    snapshotDelayMs: control.snapshotDelayMs,
    snapshotStatus: control.snapshotStatus,
  }
  if (requestControl.snapshotDelayMs > 0) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, requestControl.snapshotDelayMs)
    })
  }
  if (requestControl.snapshotStatus !== 200) {
    await route.fulfill({ status: requestControl.snapshotStatus, contentType: "application/json", body: JSON.stringify({ error: POST_A }) })
    return
  }
  const etag = `"${requestControl.snapshotId}"`
  if (route.request().headers()["if-none-match"] === etag) {
    await route.fulfill({ status: 304, headers: { ETag: etag } })
    return
  }
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { ETag: etag },
    body: JSON.stringify(snapshotPayload(requestControl)),
  })
}

async function fulfillAppView(
  route: Route,
  control: FixtureControl,
  observations: FixtureObservations,
): Promise<void> {
  const observedRequest = {
    method: route.request().method(),
    url: route.request().url(),
  }
  observations.appViewRequests.push(observedRequest)
  const uris = appViewUris(observedRequest)
  const finalUri = control.orderedUris.at(-1)
  const isLastBatch = finalUri !== undefined && uris.includes(finalUri)
  if (control.appViewMode === "fail-all" || (control.appViewMode === "fail-last-batch" && isLastBatch)) {
    await route.fulfill({
      status: 502,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "fixture AppView failure" }),
    })
    return
  }

  const visibleUris = control.appViewMode === "omit-first" ? uris.slice(1) : uris
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify({ posts: visibleUris.map((uri, index) => (
      control.appViewMode === "hide-first" && index === 0
        ? { ...appViewPost(uri), labels: [{ val: "!no-unauthenticated" }] }
        : appViewPost(uri)
    )) }),
  })
}

async function installFeedFixtures(page: Page, control: FixtureControl): Promise<FixtureObservations> {
  const observations: FixtureObservations = {
    protectedRequests: [],
    snapshotRequests: [],
    appViewRequests: [],
  }
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname
    if (/^\/api\/(?:admin|auth|session)(?:\/|$)/.test(path) || path === "/api/governance/auth/session") {
      observations.protectedRequests.push(path)
    }
  })
  await page.route("**/api/transparency/feed-snapshot**", async (route) => {
    await fulfillSnapshot(route, control, observations)
  })
  await page.route("**/xrpc/app.bsky.feed.getPosts**", async (route) => {
    await fulfillAppView(route, control, observations)
  })
  return observations
}

async function openLoadedFeed(page: Page, control: FixtureControl): Promise<string[]> {
  const observations = await installFeedFixtures(page, control)
  await page.goto("/feed/", { waitUntil: "domcontentloaded" })
  await expect(page.getByRole("heading", { level: 1, name: /See the live feed/i })).toBeVisible()
  await expect(page.locator("[data-feed-row-uri]").first()).toBeVisible()
  expect(observations.snapshotRequests.length).toBeGreaterThan(0)
  observations.snapshotRequests.forEach(assertSnapshotRequest)
  expect(observations.appViewRequests.length).toBeGreaterThan(0)
  observations.appViewRequests.forEach(assertAppViewRequest)
  return observations.protectedRequests
}

async function tabToNthWhyButton(page: Page, occurrence: number): Promise<void> {
  let seen = 0
  for (let press = 0; press < 50; press += 1) {
    await page.keyboard.press("Tab")
    const activeText = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "")
    if (activeText.includes("Why this order")) {
      seen += 1
      if (seen === occurrence) return
    }
  }
  throw new Error(`Keyboard focus did not reach Why this order button ${occurrence}`)
}

test("is usable while signed out on desktop and mobile", async ({ page }, testInfo) => {
  const control: FixtureControl = { snapshotId: "initial", orderedUris: [POST_A, POST_B], appViewMode: "complete", snapshotDelayMs: 0, snapshotStatus: 200 }
  const protectedRequests = await openLoadedFeed(page, control)
  await expect(page.getByText("Post a", { exact: true })).toBeVisible()
  const policy = page.getByRole("region", { name: "How this feed is ranked" })
  await expect(policy).toBeVisible()
  await expect(policy).toContainText("Epoch 12 · pilot policy")
  await expect(policy.getByRole("list", { name: "Active weights" })).toContainText("Engagement 30%")
  await expect(policy).toContainText("Engagement counts most")

  if (testInfo.project.name === "desktop-chrome") {
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible()
    await expect(page.getByRole("complementary", { name: "Selected post ranking explanation" })).toBeVisible()
  } else {
    await expect(page.getByRole("complementary", { name: "Selected post ranking explanation" })).toBeHidden()
    const explainButton = page.getByRole("button", { name: "Why this order" }).first()
    await expect(explainButton).toHaveAttribute("aria-expanded", "false")
    await explainButton.click()
    await expect(explainButton).toHaveAttribute("aria-expanded", "true")
    await expect(page.locator("#feed-explanation-mobile-1")).toBeVisible()
    await page.getByRole("button", { name: "Open menu" }).click()
    await expect(page.getByRole("button", { name: /Already approved.*Sign in/i })).toBeVisible()
  }
  expect(protectedRequests).toEqual([])
})

test("supports keyboard-only explanation inspection", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "Desktop inspector is the keyboard acceptance surface")
  const control: FixtureControl = { snapshotId: "keyboard", orderedUris: [POST_A, POST_B], appViewMode: "complete", snapshotDelayMs: 0, snapshotStatus: 200 }
  await openLoadedFeed(page, control)
  await tabToNthWhyButton(page, 2)
  await page.keyboard.press("Enter")
  await expect(page.getByRole("button", { name: "Why this order" }).nth(1)).toHaveAttribute("aria-pressed", "true")
  await expect(page.getByRole("complementary", { name: "Selected post ranking explanation" })).toContainText("Why position 2")
  await expect(page.getByRole("complementary", { name: "Selected post ranking explanation" })).toContainText("Above: position 1")
})

test("explains the active policy above the feed with a keyboard-operable disclosure", async ({ page }) => {
  let snapshotRequestCount = 0
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/transparency/feed-snapshot") {
      snapshotRequestCount += 1
    }
  })
  const control: FixtureControl = { snapshotId: "policy-context", orderedUris: [POST_A, POST_B], appViewMode: "complete", snapshotDelayMs: 0, snapshotStatus: 200 }
  await page.setViewportSize({ width: 375, height: 900 })
  await openLoadedFeed(page, control)
  const policy = page.getByRole("region", { name: "How this feed is ranked" })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  const policyBox = await policy.boundingBox()
  const firstRowBox = await page.locator("[data-feed-row-uri]").first().boundingBox()
  expect(policyBox).not.toBeNull()
  expect(firstRowBox).not.toBeNull()
  expect(policyBox!.y).toBeLessThan(firstRowBox!.y)

  const toggle = policy.getByRole("button", { name: "How to read this" })
  const detailsId = await toggle.getAttribute("aria-controls")
  expect(detailsId).toBeTruthy()
  const details = page.locator(`[id="${detailsId}"]`)
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
  await expect(details).toBeHidden()
  await toggle.focus()
  await page.keyboard.press("Enter")
  await expect(policy.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true")
  await expect(details).toBeVisible()
  await expect(details).toContainText("Topics are detected by keywords")
  await page.keyboard.press("Space")
  await expect(policy.getByRole("button", { name: "How to read this" })).toHaveAttribute("aria-expanded", "false")
  await expect(details).toBeHidden()
  expect(snapshotRequestCount).toBe(1)
})

test("clears the old body while notifying, then accepts a reordered snapshot", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "One desktop flow covers the shared refresh state machine")
  const control: FixtureControl = { snapshotId: "before", orderedUris: [POST_A, POST_B], appViewMode: "complete", snapshotDelayMs: 0, snapshotStatus: 200 }
  await openLoadedFeed(page, control)
  await page.getByRole("button", { name: "Why this order" }).nth(1).click()
  await expect(page.getByRole("button", { name: "Why this order" }).nth(1)).toHaveAttribute("aria-pressed", "true")

  control.snapshotId = "after"
  control.orderedUris = [POST_B, POST_A]
  await page.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect(page.getByRole("button", { name: "Show latest" })).toBeVisible()
  await expect(page.locator("[data-feed-row-uri]")).toHaveCount(0)
  const pendingBody = await page.locator("body").evaluate((node) => node.outerHTML)
  expect(pendingBody).not.toContain(POST_A)
  expect(pendingBody).not.toContain(POST_B)

  await page.getByRole("button", { name: "Show latest" }).click()
  await expect(page.locator("[data-feed-row-uri]").first()).toHaveAttribute("data-feed-row-uri", POST_B)
  await expect(page.getByRole("button", { name: "Why this order" }).first()).toHaveAttribute("aria-pressed", "true")
  await expect(page.getByRole("complementary", { name: "Selected post ranking explanation" })).toContainText("Why position 1")
})

test("deduplicates background checks and ignores a superseded late response", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "One desktop flow covers the shared request coordinator")
  let snapshotRequestCount = 0
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/transparency/feed-snapshot") {
      snapshotRequestCount += 1
    }
  })
  const control: FixtureControl = { snapshotId: "initial", orderedUris: [POST_A, POST_B], appViewMode: "complete", snapshotDelayMs: 0, snapshotStatus: 200 }
  await openLoadedFeed(page, control)
  expect(snapshotRequestCount).toBe(1)

  control.snapshotId = "slow-background"
  control.snapshotDelayMs = SUPERSEDED_RESPONSE_DELAY_MS
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"))
    window.dispatchEvent(new Event("focus"))
    window.dispatchEvent(new Event("focus"))
  })
  await expect.poll(() => snapshotRequestCount).toBe(2)
  const refreshButton = page.getByRole("button", { name: "Check for updates" })
  await expect(refreshButton).toHaveAttribute("data-refreshing", "true")

  control.snapshotId = "manual-newer"
  control.orderedUris = [POST_B, POST_A]
  control.snapshotDelayMs = 0
  await refreshButton.click()
  await expect.poll(() => snapshotRequestCount).toBe(3)
  await expect(page.getByRole("button", { name: "Show latest" })).toBeVisible()
  await page.waitForTimeout(SUPERSEDED_RESPONSE_DELAY_MS + 250)
  await expect(page.getByRole("button", { name: "Show latest" })).toBeVisible()

  await page.getByRole("button", { name: "Show latest" }).click()
  await expect(page.locator("[data-feed-row-uri]").first()).toHaveAttribute("data-feed-row-uri", POST_B)
})

test("disables row layout animation for reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  const control: FixtureControl = { snapshotId: "reduced", orderedUris: [POST_A, POST_B], appViewMode: "complete", snapshotDelayMs: 0, snapshotStatus: 200 }
  await openLoadedFeed(page, control)
  await expect(page.locator("[data-feed-row-uri]")).toHaveCount(2)
  await expect(page.locator('[data-motion-duration="0"]')).toHaveCount(2)
})

test("has no horizontal overflow and survives a hard refresh", async ({ page }) => {
  const control: FixtureControl = { snapshotId: "responsive", orderedUris: [POST_A, POST_B], appViewMode: "complete", snapshotDelayMs: 0, snapshotStatus: 200 }
  await openLoadedFeed(page, control)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.getByRole("heading", { level: 1, name: /See the live feed/i })).toBeVisible()
  await expect(page.locator("[data-feed-row-uri]")).toHaveCount(2)
})

async function expectWithdrawn(page: Page, uris: readonly string[]): Promise<void> {
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible()
  await expect(page.locator("[data-feed-row-uri]")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Show latest" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Why this order" })).toHaveCount(0)
  await expect(page.locator('[id^="feed-explanation-mobile-"]')).toHaveCount(0)
  await expect(page.getByRole("complementary", { name: "Selected post ranking explanation" })).toHaveCount(0)
  const html = await page.locator("body").evaluate((body) => body.outerHTML)
  for (const marker of [...uris, "did:plc:alpha", "did:plc:beta", "Author A", "Post a", "Post b", "Score 0.920", "Above: position", "Below: position"]) {
    expect(html).not.toContain(marker)
  }
}

for (const appViewMode of ["fail-last-batch", "fail-all"] as const) {
  test(`rejects initial ${appViewMode} metadata before rendering`, async ({ page }) => {
    const uris = appViewMode === "fail-last-batch"
      ? Array.from({ length: 26 }, (_, index) => `at://did:plc:fixture/app.bsky.feed.post/${index + 1}`)
      : [POST_A, POST_B]
    const control: FixtureControl = { snapshotId: "initial-denied", orderedUris: uris, appViewMode, snapshotDelayMs: 0, snapshotStatus: 200 }
    await installFeedFixtures(page, control)
    await page.goto("/feed/", { waitUntil: "domcontentloaded" })
    await expectWithdrawn(page, uris)
  })
}

test("renders generic placeholders at original positions in a mixed 50-position feed", async ({ page }) => {
  const uris = Array.from({ length: 50 }, (_, index) => (
    `at://did:plc:fixture/app.bsky.feed.post/${index === 0 ? "withheld-alpha" : index === 25 ? "withheld-omega" : `visible-${index + 1}`}`
  ))
  const control: FixtureControl = { snapshotId: "mixed-50", orderedUris: uris, appViewMode: "omit-first", snapshotDelayMs: 0, snapshotStatus: 200 }
  await installFeedFixtures(page, control)
  await page.goto("/feed/", { waitUntil: "domcontentloaded" })
  await expect(page.locator('[aria-label="Position 1 withheld"]')).toBeVisible()
  await expect(page.locator('[aria-label="Position 26 withheld"]')).toBeVisible()
  await expect(page.locator("[data-feed-row-uri]")).toHaveCount(48)
  const withheld = await page.locator('[aria-label="Position 1 withheld"]').evaluate((node) => node.outerHTML)
  for (const marker of [uris[0] ?? "", "Post withheld-alpha", "Author WITHHELD-ALPHA", "0.92", "score-mixed-50"]) {
    expect(withheld).not.toContain(marker)
  }
  const body = await page.locator("body").evaluate((node) => node.outerHTML)
  expect(body).not.toContain(uris[0] ?? "")
  expect(body).not.toContain(uris[25] ?? "")
})

for (const appViewMode of ["omit-first", "hide-first", "fail-all"] as const) {
  test(`handles ${appViewMode} metadata on unchanged Corgi ETag`, async ({ page }) => {
    const control: FixtureControl = { snapshotId: "visibility", orderedUris: [POST_A, POST_B], appViewMode: "complete", snapshotDelayMs: 0, snapshotStatus: 200 }
    const observations = await installFeedFixtures(page, control)
    await page.goto("/feed/", { waitUntil: "domcontentloaded" })
    await expect(page.getByText("Post a", { exact: true })).toBeVisible()
    await page.getByRole("button", { name: "Why this order" }).first().click()
    const initialSnapshotReads = observations.snapshotRequests.length
    const initialHydrations = observations.appViewRequests.length
    control.appViewMode = appViewMode
    await page.evaluate(() => window.dispatchEvent(new Event("focus")))
    if (appViewMode === "fail-all") {
      await expectWithdrawn(page, [POST_A, POST_B])
    } else {
      await expect(page.locator('[aria-label="Position 1 withheld"]')).toBeVisible()
      await expect(page.locator("[data-feed-row-uri]")).toHaveCount(1)
      const body = await page.locator("body").evaluate((node) => node.outerHTML)
      expect(body).not.toContain(POST_A)
      expect(body).not.toContain("Post a")
      expect(body).not.toContain("0.920")
    }
    expect(observations.snapshotRequests.length - initialSnapshotReads).toBe(1)
    expect(observations.appViewRequests.length - initialHydrations).toBe(1)
    if (appViewMode === "fail-all") {
      control.appViewMode = "complete"
      await page.getByRole("button", { name: "Try again" }).click()
      await expect(page.getByText("Post a", { exact: true })).toBeVisible()
      await expect(page.locator("[data-feed-row-uri]")).toHaveCount(2)
    }
  })
}

for (const duringAccept of [false, true]) {
  test(`withdraws displayed and pending metadata during ${duringAccept ? "acceptance" : "background refresh"}`, async ({ page }) => {
    const control: FixtureControl = { snapshotId: "displayed", orderedUris: [POST_A, POST_B], appViewMode: "complete", snapshotDelayMs: 0, snapshotStatus: 200 }
    await openLoadedFeed(page, control)
    control.snapshotId = "pending"
    control.orderedUris = [POST_B, POST_A]
    await page.evaluate(() => window.dispatchEvent(new Event("focus")))
    await expect(page.getByRole("button", { name: "Show latest" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Check for updates" })).toHaveAttribute("data-refreshing", "false")
    control.appViewMode = "omit-first"
    if (duringAccept) {
      await page.getByRole("button", { name: "Show latest" }).click()
      await expect(page.locator('[aria-label="Position 1 withheld"]')).toBeVisible()
      await expect(page.locator("[data-feed-row-uri]")).toHaveCount(1)
      const body = await page.locator("body").evaluate((node) => node.outerHTML)
      expect(body).not.toContain(POST_B)
      expect(body).not.toContain("Post b")
    } else {
      await page.evaluate(() => window.dispatchEvent(new Event("focus")))
      await expect(page.getByRole("button", { name: "Show latest" })).toBeVisible()
      await expect(page.locator("[data-feed-row-uri]")).toHaveCount(0)
      const body = await page.locator("body").evaluate((node) => node.outerHTML)
      expect(body).not.toContain(POST_A)
      expect(body).not.toContain(POST_B)
    }
  })
}

for (const status of [502, 503] as const) {
  test(`clears displayed and pending metadata on snapshot ${status}`, async ({ page }) => {
    const control: FixtureControl = { snapshotId: "displayed", orderedUris: [POST_A, POST_B], appViewMode: "complete", snapshotDelayMs: 0, snapshotStatus: 200 }
    await openLoadedFeed(page, control)
    control.snapshotId = "pending"
    control.orderedUris = [POST_B, POST_A]
    await page.evaluate(() => window.dispatchEvent(new Event("focus")))
    await expect(page.getByRole("button", { name: "Show latest" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Check for updates" })).toHaveAttribute("data-refreshing", "false")
    control.snapshotDelayMs = 0
    control.snapshotStatus = status
    await page.getByRole("button", { name: "Show latest" }).click()
    await expectWithdrawn(page, [POST_A, POST_B])
    await page.waitForTimeout(SUPERSEDED_RESPONSE_DELAY_MS + 100)
    await expectWithdrawn(page, [POST_A, POST_B])
  })
}


test("does not resurrect withdrawn metadata after a superseded late AppView response", async ({ page }) => {
  const control: FixtureControl = { snapshotId: "late-hydration", orderedUris: [POST_A, POST_B], appViewMode: "complete", snapshotDelayMs: 0, snapshotStatus: 200 }
  const observations = await installFeedFixtures(page, control)
  await page.goto("/feed/", { waitUntil: "domcontentloaded" })
  await expect(page.getByText("Post a", { exact: true })).toBeVisible()
  let releaseLate!: () => void
  const heldHydration = new Promise<void>((resolve) => { releaseLate = resolve })
  let captured = false
  let released = false
  await page.route("**/xrpc/app.bsky.feed.getPosts**", async (route) => {
    if (captured) {
      await fulfillAppView(route, control, observations)
      return
    }
    const uris = new URL(route.request().url()).searchParams.getAll("uris")
    const capturedPosts = uris.map(appViewPost)
    captured = true
    await heldHydration
    await route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ posts: capturedPosts }) })
    released = true
  })
  await page.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect.poll(() => captured).toBe(true)
  control.appViewMode = "hide-first"
  await page.getByRole("button", { name: "Check for updates" }).click()
  await expect(page.locator('[aria-label="Position 1 withheld"]')).toBeVisible()
  await expect(page.locator("[data-feed-row-uri]")).toHaveCount(1)
  await expect(page.getByText("Post b", { exact: true })).toBeVisible()
  const beforeLateResponse = await page.locator("body").evaluate((node) => node.outerHTML)
  expect(beforeLateResponse).not.toContain(POST_A)
  expect(beforeLateResponse).not.toContain("Post a")
  expect(beforeLateResponse).not.toContain("0.920")
  releaseLate()
  await expect.poll(() => released).toBe(true)
  await expect(page.locator('[aria-label="Position 1 withheld"]')).toBeVisible()
  await expect(page.locator("[data-feed-row-uri]")).toHaveCount(1)
  await expect(page.getByText("Post b", { exact: true })).toBeVisible()
  const afterLateResponse = await page.locator("body").evaluate((node) => node.outerHTML)
  expect(afterLateResponse).not.toContain(POST_A)
  expect(afterLateResponse).not.toContain("Post a")
  expect(afterLateResponse).not.toContain("0.920")
})
