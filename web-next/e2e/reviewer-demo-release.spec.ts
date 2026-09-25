import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import pg from "pg"
import { Redis } from "ioredis"
import { expect, test, type Page } from "@playwright/test"
import { SHADOW_DEMO_ISOLATION_CONTRACT } from "../app/demo/shadow-demo-contract"
import { redisDatabaseIdentity } from "../../src/demo/redis-safety"
import { DEMO_RESUME_KEY } from "../app/demo/demo-session-resume"
import type { DemoSessionResume } from "../app/demo/demo-session-resume"

const { Pool } = pg

interface DemoVote {
  actorType: "reviewer" | "synthetic_voter"
  actorId: string
  blocId?: string
}

interface DemoSession {
  sessionId: string
  currentEpochId: string
  phase: "created" | "reviewer_voted" | "synthetic_voters_ran" | "epoch_advanced"
  voteCount: number
  topicCatalog: Array<{ slug: string; baselineWeight: number }>
  votes: DemoVote[]
  voterProfiles: Array<{ id: string; voterCount: number }>
  pendingAggregate: { voteCount: number; trimCount: number } | null
  epochs: Array<{ id: string; sequence: number; aggregate: { voteCount: number; trimCount: number } }>
}

interface DemoSessionEnvelope {
  contractVersion: string
  payload: {
    session: DemoSession
  }
}

interface DemoFeedPost {
  post: {
    kind: "public_post" | "hidden_post"
    uri?: string
  }
  rank: number
  previousRank: number | null
  movement: number | null
}

interface DemoFeedEnvelope {
  payload: {
    corpusId: string
    posts: DemoFeedPost[]
  }
}

interface DemoReceiptEnvelope {
  payload: {
    receipt: {
      postUri: string
      epochId: string
      aggregate: { voteCount: number; trimCount: number }
      components: Array<{ signal: string; contribution: number }>
      provenance: {
        mode: string
        shadowEpochId: string
      }
    }
  }
}

interface BrowserProblems {
  console: string[]
  page: string[]
  requests: string[]
}

const CONTRACT_VERSION = "2026-07-11.shadow-demo.v4"
const EXPECTED_SYNTHETIC_VOTERS = 24
const EXPECTED_TOTAL_BALLOTS = 25
const EXPECTED_TRIM_COUNT = 2
const EXPECTED_TOPIC_COUNT = 26
const ALLOWED_DEMO_PREFIXES = SHADOW_DEMO_ISOLATION_CONTRACT.redisPrefixes
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"])

function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required for reviewer-demo validation.`)
  }
  return value
}

function collectBrowserProblems(page: Page): BrowserProblems {
  const problems: BrowserProblems = { console: [], page: [], requests: [] }
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      problems.console.push(`${message.type()}: ${message.text()}`)
    }
  })
  page.on("pageerror", (error) => {
    problems.page.push(error.message)
  })
  page.on("requestfailed", (request) => {
    problems.requests.push(
      `${request.method()} ${request.url()} (${request.failure()?.errorText ?? "unknown failure"})`,
    )
  })
  return problems
}

async function jsonBody<T>(response: { json(): Promise<unknown> }): Promise<T> {
  return await response.json() as T
}

function publicPostUris(feed: DemoFeedEnvelope): string[] {
  return feed.payload.posts.flatMap((entry) => {
    return entry.post.kind === "public_post" && entry.post.uri !== undefined ? [entry.post.uri] : []
  })
}

function quotedIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`
}

async function databaseFingerprint(pool: pg.Pool): Promise<Record<string, string>> {
  const tables = await pool.query<{ table_name: string }>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
  )
  const result: Record<string, string> = {}
  for (const { table_name: tableName } of tables.rows) {
    const fingerprint = await pool.query<{ row_count: string; digest: string }>(
      `SELECT
         COUNT(*)::text AS row_count,
         md5(COALESCE(
           string_agg(to_jsonb(row_value)::text, E'\\n' ORDER BY to_jsonb(row_value)::text),
           ''
         )) AS digest
       FROM ${quotedIdentifier(tableName)} AS row_value`,
    )
    const row = fingerprint.rows[0]
    if (row === undefined) {
      throw new Error(`Could not fingerprint public table ${tableName}.`)
    }
    result[tableName] = `${row.row_count}:${row.digest}`
  }
  return result
}

async function scanKeys(redis: Redis): Promise<string[]> {
  let cursor = "0"
  const keys: string[] = []
  do {
    const [nextCursor, page] = await redis.scan(cursor, "COUNT", 250)
    cursor = nextCursor
    keys.push(...page)
  } while (cursor !== "0")
  return [...new Set(keys)].sort()
}

async function redisValue(redis: Redis, key: string): Promise<unknown> {
  const type = await redis.type(key)
  switch (type) {
    case "string":
      return { type, value: await redis.get(key) }
    case "list":
      return { type, value: await redis.lrange(key, 0, -1) }
    case "set":
      return { type, value: (await redis.smembers(key)).sort() }
    case "zset":
      return { type, value: await redis.zrange(key, 0, -1, "WITHSCORES") }
    case "hash": {
      const hash = await redis.hgetall(key)
      return {
        type,
        value: Object.fromEntries(Object.entries(hash).sort(([left], [right]) => left.localeCompare(right))),
      }
    }
    case "stream":
      return { type, value: await redis.xrange(key, "-", "+") }
    case "none":
      return { type, value: null }
    default:
      throw new Error(`Unsupported Redis type ${type} at ${key}.`)
  }
}

async function redisFingerprint(
  redis: Redis,
  excludedPrefixes: readonly string[],
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {}
  for (const key of await scanKeys(redis)) {
    if (excludedPrefixes.some((prefix) => key.startsWith(prefix))) {
      continue
    }
    result[key] = await redisValue(redis, key)
  }
  return result
}

async function configValue(redis: Redis, key: string): Promise<string> {
  const result = await redis.config("GET", key) as unknown
  if (!Array.isArray(result)) {
    throw new Error(`Redis CONFIG GET ${key} returned a non-array result.`)
  }
  if (result.length !== 2 || result[0] !== key) {
    throw new Error(`Redis CONFIG GET ${key} returned an invalid result.`)
  }
  return typeof result[1] === "string" ? result[1] : ""
}

async function screenshot(page: Page, artifactDirectory: string, name: string): Promise<void> {
  await page.screenshot({
    path: join(artifactDirectory, `${name}.png`),
    fullPage: true,
    scale: "css",
  })
}

test("production build preserves the complete reviewer demo and storage isolation", async ({
  page,
  request,
}, testInfo) => {
  const databaseUrl = requiredEnvironment("CORGI_REVIEWER_DEMO_DATABASE_URL")
  const productionRedisUrl = requiredEnvironment("CORGI_REVIEWER_DEMO_PRODUCTION_REDIS_URL")
  const demoRedisUrl = requiredEnvironment("CORGI_REVIEWER_DEMO_ISOLATED_REDIS_URL")
  const artifactRoot = requiredEnvironment("CORGI_REVIEWER_DEMO_ARTIFACT_DIR")
  const publisherDid = requiredEnvironment("CORGI_REVIEWER_DEMO_PUBLISHER_DID")
  const releaseSha = requiredEnvironment("CORGI_REVIEWER_DEMO_RELEASE_SHA")
  const artifactDirectory = join(artifactRoot, testInfo.project.name)
  await mkdir(artifactDirectory, { recursive: true })

  const database = new Pool({ connectionString: databaseUrl, max: 2 })
  const productionRedis = new Redis(productionRedisUrl, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
  })
  const demoRedis = new Redis(demoRedisUrl, { maxRetriesPerRequest: 1 })
  const browserProblems = collectBrowserProblems(page)
  const browserMutations: string[] = []
  let releasePendingReceipt: (() => void) | null = null
  page.on("request", (outbound) => {
    if (MUTATION_METHODS.has(outbound.method())) {
      browserMutations.push(`${outbound.method()} ${new URL(outbound.url()).pathname}`)
    }
  })

  try {
    if (redisDatabaseIdentity(demoRedisUrl) === redisDatabaseIdentity(productionRedisUrl)) {
      throw new Error(
        "Reviewer-demo validation refuses to clean the production Redis database.",
      )
    }
    const existingDemoKeys = await scanKeys(demoRedis)
    const unexpectedDemoKeys = existingDemoKeys.filter((key) => {
      return !ALLOWED_DEMO_PREFIXES.some((prefix) => key.startsWith(prefix))
    })
    if (unexpectedDemoKeys.length > 0) {
      throw new Error(
        `Reviewer-demo Redis contains ${unexpectedDemoKeys.length} key(s) outside the isolated demo namespaces.`,
      )
    }
    for (let offset = 0; offset < existingDemoKeys.length; offset += 250) {
      await demoRedis.del(...existingDemoKeys.slice(offset, offset + 250))
    }

    const homeResponse = await page.goto("/", { waitUntil: "domcontentloaded" })
    expect(homeResponse?.status()).toBe(200)
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: /Make Bluesky care about what your community cares about/i,
      }),
    ).toBeVisible()
    await screenshot(page, artifactDirectory, "00-homepage")
    await writeFile(
      join(artifactDirectory, "00-homepage-accessibility.yml"),
      await page.locator("body").ariaSnapshot(),
      "utf8",
    )

    const health = await request.get("/health")
    expect(health.status()).toBe(200)
    expect(await health.json()).toEqual({ status: "ok", revision: releaseSha })
    const ready = await request.get("/health/ready")
    expect(ready.status()).toBe(200)
    expect(await ready.json()).toEqual({ status: "ready" })
    const live = await request.get("/health/live")
    expect(live.status()).toBe(200)
    expect(await live.json()).toEqual({ status: "live" })

    const describe = await request.get("/xrpc/app.bsky.feed.describeFeedGenerator")
    expect(describe.status()).toBe(200)
    const describeBody = await describe.json() as { did?: unknown; feeds?: unknown }
    expect(typeof describeBody.did).toBe("string")
    expect(Array.isArray(describeBody.feeds)).toBe(true)

    const feedUri = `at://${publisherDid}/app.bsky.feed.generator/community-gov`
    const skeleton = await request.get(
      `/xrpc/app.bsky.feed.getFeedSkeleton?feed=${encodeURIComponent(feedUri)}&limit=3`,
    )
    expect(skeleton.status()).toBe(200)
    const skeletonBody = await skeleton.json() as { feed?: unknown; cursor?: unknown }
    expect(Array.isArray(skeletonBody.feed)).toBe(true)
    expect(skeletonBody.feed).toHaveLength(3)
    expect(typeof skeletonBody.cursor).toBe("string")

    const stats = await request.get("/api/transparency/stats")
    expect(stats.status()).toBe(200)
    const statsBody = await stats.json() as Record<string, unknown>
    expect(Object.keys(statsBody).sort()).toEqual(
      ["epoch", "feed_stats", "governance", "metrics", "stats_status"].sort(),
    )
    const counterfactual = await request.get("/api/transparency/counterfactual")
    expect(counterfactual.status()).toBe(200)
    const counterfactualBody = await counterfactual.json() as Record<string, unknown>
    expect(Object.keys(counterfactualBody).sort()).toEqual(
      ["alternate_weights", "current_weights", "posts", "summary"].sort(),
    )
    const audit = await request.get("/api/transparency/audit?limit=1")
    expect(audit.status()).toBe(200)
    const auditBody = await audit.json() as { entries?: Array<{ actor_did?: unknown }> }
    expect(auditBody.entries).toHaveLength(1)
    expect(auditBody.entries?.[0]?.actor_did).toBeNull()

    await expect.poll(async () => productionRedis.llen("feed:request_log")).toBeGreaterThanOrEqual(1)

    const demoResponse = await page.goto("/demo/", { waitUntil: "domcontentloaded" })
    expect(demoResponse?.status()).toBe(200)
    await expect(
      page.getByRole("heading", { level: 1, name: /Re-rank a frozen Corgi Commons snapshot/i }),
    ).toBeVisible()
    await expect(page.getByRole("listitem", { name: "Session: current" })).toBeVisible()
    await screenshot(page, artifactDirectory, "01-session")

    const databaseBefore = await databaseFingerprint(database)
    // Next link prefetch and the header's governance-session read legitimately
    // hit non-demo routes while the walkthrough changes panels. The runner
    // separately proves with real Redis that a v4 request creates zero global
    // limiter keys, so exclude only that operational namespace here.
    const productionRedisBefore = await redisFingerprint(
      productionRedis,
      ["fastify-rate-limit-"],
    )

    // Reload recovery must perform reads only and preserve the authoritative phase.
    async function reloadSession(expected: DemoSession, visibleHeading: string | RegExp | null): Promise<void> {
      const mutationsBefore = browserMutations.length
      const restoredResponse = page.waitForResponse((response) => response.request().method() === "GET"
        && new URL(response.url()).pathname === `/api/demo/v4/sessions/${expected.sessionId}`)
      await page.reload({ waitUntil: "domcontentloaded" })
      const restored = await jsonBody<DemoSessionEnvelope>(await restoredResponse)
      expect(restored.payload.session.sessionId).toBe(expected.sessionId)
      expect(restored.payload.session.phase).toBe(expected.phase)
      expect(restored.payload.session.currentEpochId).toBe(expected.currentEpochId)
      expect(restored.payload.session.voteCount).toBe(expected.voteCount)
      if (visibleHeading === null) {
        await expect(page.getByRole("button", { name: "Ranked feed" })).toHaveAttribute("aria-pressed", "true")
        await expect(page.getByRole("article").first()).toBeVisible()
      } else {
        await expect(page.getByRole("heading", { name: visibleHeading })).toBeVisible()
      }
      await expect(page.getByRole("button", { name: "Restore demo session" })).toHaveCount(0)
      expect(browserMutations.length).toBe(mutationsBefore)
    }

    const createResponsePromise = page.waitForResponse((response) => {
      return response.request().method() === "POST"
        && new URL(response.url()).pathname === "/api/demo/v4/sessions"
    })
    await page.getByRole("button", { name: "Start a demo session" }).click()
    const createResponse = await createResponsePromise
    expect(createResponse.status()).toBe(200)
    const createBody = await jsonBody<DemoSessionEnvelope>(createResponse)
    const createdSession = createBody.payload.session
    expect(createBody.contractVersion).toBe(CONTRACT_VERSION)
    expect(createdSession.phase).toBe("created")
    expect(createdSession.voteCount).toBe(0)
    expect(createdSession.topicCatalog).toHaveLength(EXPECTED_TOPIC_COUNT)
    expect(new Set(createdSession.topicCatalog.map((topic) => topic.slug)).size).toBe(EXPECTED_TOPIC_COUNT)
    await expect(page.getByRole("heading", { name: "Cast your demo vote" })).toBeVisible()
    await expect(page.getByRole("listitem", { name: "Your vote: current" })).toBeVisible()
    await expect(page.getByText("Shadow session · never changes the public feed").first()).toBeVisible()
    await screenshot(page, artifactDirectory, "02-your-vote")
    await reloadSession(createdSession, "Cast your demo vote")

    const baselineFeedResponse = await request.get(
      `/api/demo/v4/sessions/${createdSession.sessionId}/feed`
        + `?epochId=${createdSession.currentEpochId}&limit=12`,
    )
    expect(baselineFeedResponse.status()).toBe(200)
    const baselineFeed = await baselineFeedResponse.json() as DemoFeedEnvelope
    const baselineUris = publicPostUris(baselineFeed)
    expect(baselineUris).toHaveLength(12)
    expect(new Set(baselineUris).size).toBe(12)

    await page.getByRole("button", { name: "Research and tooling" }).click()
    // Let each real backend mutation commit, then lose its response body. The
    // browser must recover by GET, never issue the mutation a second time.
    const committedResponses = new Map<string, DemoSessionEnvelope>()
    for (const operation of ["votes", "agents/run", "epochs/advance"]) {
      await page.route(`**/api/demo/v4/sessions/*/${operation}`, async (route) => {
        const committed = await route.fetch()
        expect(committed.status()).toBe(200)
        committedResponses.set(operation, await jsonBody<DemoSessionEnvelope>(committed))
        await route.fulfill({ status: 200, contentType: "application/json", body: "{" })
      }, { times: 1 })
    }

    const voteResponsePromise = page.waitForResponse((response) => {
      return response.request().method() === "POST"
        && new URL(response.url()).pathname.endsWith("/votes")
    })
    await page.getByRole("button", { name: "Cast demo vote" }).click()
    const voteResponse = await voteResponsePromise
    expect(voteResponse.status()).toBe(200)
    const voteBody = committedResponses.get("votes")
    if (voteBody === undefined) throw new Error("Missing committed reviewer-vote recovery evidence")
    expect(voteBody.payload.session.phase).toBe("reviewer_voted")
    expect(voteBody.payload.session.voteCount).toBe(1)
    expect(voteBody.payload.session.votes).toHaveLength(1)
    expect(voteBody.payload.session.votes[0]?.actorType).toBe("reviewer")
    await expect(page.getByRole("heading", { name: "Let the community weigh in" })).toBeVisible()
    await expect(page.getByRole("listitem", { name: "Community: current" })).toBeVisible()
    await screenshot(page, artifactDirectory, "03-community")
    await reloadSession(voteBody.payload.session, "Let the community weigh in")

    const votersResponsePromise = page.waitForResponse((response) => {
      return response.request().method() === "POST"
        && new URL(response.url()).pathname.endsWith("/agents/run")
    })
    await page.getByRole("button", { name: "Simulate 24 voters" }).click()
    const votersResponse = await votersResponsePromise
    expect(votersResponse.status()).toBe(200)
    const votersBody = committedResponses.get("agents/run")
    if (votersBody === undefined) throw new Error("Missing committed synthetic-voter recovery evidence")
    const votersSession = votersBody.payload.session
    const syntheticVotes = votersSession.votes.filter((vote) => vote.actorType === "synthetic_voter")
    expect(votersSession.phase).toBe("synthetic_voters_ran")
    expect(votersSession.voteCount).toBe(EXPECTED_TOTAL_BALLOTS)
    expect(votersSession.votes).toHaveLength(EXPECTED_TOTAL_BALLOTS)
    expect(syntheticVotes).toHaveLength(EXPECTED_SYNTHETIC_VOTERS)
    expect(new Set(syntheticVotes.map((vote) => vote.actorId)).size).toBe(EXPECTED_SYNTHETIC_VOTERS)
    expect(syntheticVotes.every((vote) => vote.blocId !== undefined)).toBe(true)
    expect(votersSession.voterProfiles.reduce((sum, profile) => sum + profile.voterCount, 0))
      .toBe(EXPECTED_SYNTHETIC_VOTERS)
    expect(votersSession.pendingAggregate).toEqual(
      expect.objectContaining({ voteCount: EXPECTED_TOTAL_BALLOTS, trimCount: EXPECTED_TRIM_COUNT }),
    )
    await expect(page.getByRole("heading", { name: "Advance the shadow epoch" })).toBeVisible()
    await expect(page.getByText("25 ballots · trimmed mean · 2 values trimmed from each end per signal"))
      .toBeVisible()
    await expect(page.getByRole("listitem", { name: "Advance epoch: current" })).toBeVisible()
    await screenshot(page, artifactDirectory, "04-advance-epoch")
    await reloadSession(votersSession, "Advance the shadow epoch")
    await expect(page.getByText("25 ballots · trimmed mean · 2 values trimmed from each end per signal")).toBeVisible()

    let releaseReceiptRequest!: () => void
    let noteReceiptRequest!: () => void
    const receiptGate = new Promise<void>((resolve) => {
      releaseReceiptRequest = resolve
      releasePendingReceipt = resolve
    })
    const receiptRequestStarted = new Promise<void>((resolve) => {
      noteReceiptRequest = resolve
    })
    await page.route(/\/api\/demo\/v4\/sessions\/[^/]+\/receipts\?/, async (route) => {
      noteReceiptRequest()
      await receiptGate
      await route.continue()
    }, { times: 1 })

    const advanceResponsePromise = page.waitForResponse((response) => {
      return response.request().method() === "POST"
        && new URL(response.url()).pathname.endsWith("/epochs/advance")
    })
    await page.getByRole("button", { name: "Advance epoch" }).click()
    const advanceResponse = await advanceResponsePromise
    expect(advanceResponse.status()).toBe(200)
    const advanceBody = committedResponses.get("epochs/advance")
    if (advanceBody === undefined) throw new Error("Missing committed epoch-advance recovery evidence")
    const advancedSession = advanceBody.payload.session
    expect(advancedSession.phase).toBe("epoch_advanced")
    expect(advancedSession.currentEpochId).not.toBe(createdSession.currentEpochId)
    expect(advancedSession.epochs.at(-1)?.sequence).toBe(2)
    expect(advancedSession.epochs.at(-1)?.aggregate).toEqual(
      expect.objectContaining({ voteCount: EXPECTED_TOTAL_BALLOTS, trimCount: EXPECTED_TRIM_COUNT }),
    )

    await expect(page.getByRole("listitem", { name: "Reordered: current" })).toBeVisible()
    const advancedHeading = testInfo.project.name === "mobile-chrome" ? null : "Same posts, new order"
    if (advancedHeading === null) {
      await expect(page.getByRole("button", { name: "Ranked feed" })).toHaveAttribute("aria-pressed", "true")
      await expect(page.getByRole("article").first()).toBeVisible()
    } else {
      await expect(page.getByRole("heading", { name: advancedHeading })).toBeVisible()
    }
    await expect(page.getByRole("button", { name: "Restore demo session" })).toHaveCount(0)
    await reloadSession(advancedSession, advancedHeading)
    await page.getByRole("button", { name: "Inspect ranking", exact: true }).first().click()
    await receiptRequestStarted
    await expect(page.getByRole("heading", { name: "Same posts, new order" })).toBeVisible()
    await expect(page.getByRole("listitem", { name: "Reordered: current" })).toBeVisible()
    await screenshot(page, artifactDirectory, "05-reordered")

    const receiptResponsePromise = page.waitForResponse((response) => {
      return response.request().method() === "GET"
        && new URL(response.url()).pathname.endsWith("/receipts")
    })
    releaseReceiptRequest()
    const receiptResponse = await receiptResponsePromise
    expect(receiptResponse.status()).toBe(200)
    const receiptBody = await jsonBody<DemoReceiptEnvelope>(receiptResponse)
    const receipt = receiptBody.payload.receipt
    expect(receipt.epochId).toBe(advancedSession.currentEpochId)
    expect(receipt.provenance.shadowEpochId).toBe(advancedSession.currentEpochId)
    expect(receipt.provenance.mode).toBe("production_feed_snapshot_session_frozen")
    expect(receipt.aggregate).toEqual(
      expect.objectContaining({
        voteCount: EXPECTED_TOTAL_BALLOTS,
        trimCount: EXPECTED_TRIM_COUNT,
      }),
    )
    expect(receipt.components).toHaveLength(5)
    expect(receipt.components.every((component) => Number.isFinite(component.contribution))).toBe(true)
    await expect(page.getByRole("heading", { name: /Why ranked #/ })).toBeVisible()
    await expect(page.getByRole("listitem", { name: "Receipt: completed" })).toBeVisible()
    await screenshot(page, artifactDirectory, "06-receipt")
    await reloadSession(advancedSession, /Why ranked #/)
    await expect(page.getByRole("listitem", { name: "Receipt: completed" })).toBeVisible()
    await writeFile(
      join(artifactDirectory, "06-receipt-accessibility.yml"),
      await page.locator("body").ariaSnapshot(),
      "utf8",
    )

    const rerankedFeedResponse = await request.get(
      `/api/demo/v4/sessions/${createdSession.sessionId}/feed`
        + `?epochId=${advancedSession.currentEpochId}&limit=12`,
    )
    expect(rerankedFeedResponse.status()).toBe(200)
    const rerankedFeed = await rerankedFeedResponse.json() as DemoFeedEnvelope
    const rerankedUris = publicPostUris(rerankedFeed)
    expect(rerankedFeed.payload.corpusId).toBe(baselineFeed.payload.corpusId)
    expect(rerankedUris).toHaveLength(12)
    expect(new Set(rerankedUris).size).toBe(12)
    const baselineRanks = new Map(baselineUris.map((uri, index) => [uri, baselineFeed.payload.posts[index].rank]))
    rerankedFeed.payload.posts.forEach((post, index) => {
      expect(post.rank).toBe(index + 1)
      const previousRank = baselineRanks.get(rerankedUris[index])
      if (previousRank !== undefined) {
        expect(post.previousRank).toBe(previousRank)
        expect(post.movement).toBe(previousRank - post.rank)
      }
    })

    if (testInfo.project.name === "mobile-chrome") {
      await page.getByRole("button", { name: "Ranked feed" }).click()
      await screenshot(page, artifactDirectory, "06b-mobile-ranked-feed")
      expect(await page.locator("body").evaluate((body) => body.scrollWidth <= window.innerWidth)).toBe(true)
    }

    const databaseAfter = await databaseFingerprint(database)
    const productionRedisAfter = await redisFingerprint(
      productionRedis,
      ["fastify-rate-limit-"],
    )
    expect(databaseAfter, "demo browser flow mutated PostgreSQL state").toEqual(databaseBefore)
    expect(productionRedisAfter, "demo browser flow mutated production Redis state").toEqual(productionRedisBefore)

    const demoKeys = await scanKeys(demoRedis)
    expect(demoKeys.length).toBeGreaterThan(0)
    expect(
      demoKeys.filter((key) => !ALLOWED_DEMO_PREFIXES.some((prefix) => key.startsWith(prefix))),
      "demo Redis contained a key outside the exported isolation contract",
    ).toEqual([])
    expect(demoKeys).toContain(`demo:session:${createdSession.sessionId}`)
    expect(demoKeys.some((key) => key.startsWith("demo:session-nonce:"))).toBe(true)
    expect(demoKeys.some((key) => key.startsWith("demo:idempotency:"))).toBe(true)
    expect(demoKeys.some((key) => key.startsWith("demo:rate-limit:"))).toBe(true)
    expect(demoKeys.filter((key) => key.startsWith("demo:lock:"))).toEqual([])
    expect(demoKeys.filter((key) => key.startsWith("demo:staging:"))).toEqual([])
    expect(await productionRedis.exists(...demoKeys), "demo keys leaked into production Redis").toBe(0)
    expect(await configValue(demoRedis, "maxmemory-policy")).toBe("noeviction")
    expect(await configValue(demoRedis, "maxmemory")).toBe(String(64 * 1024 * 1024))
    expect(await configValue(demoRedis, "appendonly")).toBe("no")
    expect(await configValue(demoRedis, "save")).toBe("")

    expect(committedResponses.size).toBe(3)
    // A fresh tab gets no automatic capability binding from this tab.
    const otherTab = await page.context().newPage()
    try {
      await otherTab.goto("/demo/", { waitUntil: "domcontentloaded" })
      await expect(otherTab.getByRole("button", { name: "Start a demo session" })).toBeVisible()
      expect(await otherTab.evaluate((key) => window.sessionStorage.getItem(key), DEMO_RESUME_KEY)).toBeNull()
    } finally {
      await otherTab.close()
    }

    expect(browserMutations.length).toBe(4)
    expect(browserMutations.every((entry) => entry.startsWith("POST /api/demo/v4/"))).toBe(true)
    expect(browserMutations.some((entry) => entry.includes("/api/governance/"))).toBe(false)
    expect(browserMutations.some((entry) => entry.includes("/api/admin/"))).toBe(false)
    expect(browserProblems.console, "browser console warnings/errors").toEqual([])
    expect(browserProblems.page, "uncaught browser errors").toEqual([])
    expect(browserProblems.requests, "failed browser requests").toEqual([])
    const mutationsBeforeExpiry = browserMutations.length
    expect(await demoRedis.del(`demo:session:${createdSession.sessionId}`)).toBe(1)
    const expiredRead = page.waitForResponse((response) => response.request().method() === "GET"
      && new URL(response.url()).pathname === `/api/demo/v4/sessions/${createdSession.sessionId}`)
    await page.reload({ waitUntil: "domcontentloaded" })
    expect((await expiredRead).status()).toBe(404)
    await expect(page.getByRole("main").getByRole("alert")).toContainText("expired or is no longer available")
    await expect(page.getByRole("button", { name: "Start a demo session" })).toBeVisible()
    await expect(page.getByRole("heading", { name: /Why ranked #/ })).toHaveCount(0)
    expect(await page.evaluate((key) => window.sessionStorage.getItem(key), DEMO_RESUME_KEY)).toBeNull()
    expect(browserMutations.length).toBe(mutationsBeforeExpiry)
    expect(browserProblems.page).toEqual([])
    expect(browserProblems.requests).toEqual([])
    expect(browserProblems.console.length).toBeLessThanOrEqual(1)
    expect(browserProblems.console.every((message) => /404/.test(message))).toBe(true)

  } finally {
    if (releasePendingReceipt !== null) releasePendingReceipt()
    await Promise.allSettled([
      database.end(),
      productionRedis.quit(),
      demoRedis.quit(),
    ])
  }
})

async function createBrowserDemo(page: Page): Promise<DemoSession> {
  const response = page.waitForResponse((candidate) => candidate.request().method() === "POST"
    && new URL(candidate.url()).pathname === "/api/demo/v4/sessions")
  await page.getByRole("button", { name: "Start a demo session" }).click()
  const created = await response
  expect(created.status()).toBe(200)
  const body = await jsonBody<DemoSessionEnvelope>(created)
  await expect(page.getByRole("heading", { name: "Cast your demo vote" })).toBeVisible()
  return body.payload.session
}

async function assertProductionUnchanged(action: () => Promise<void>): Promise<void> {
  const database = new Pool({ connectionString: requiredEnvironment("CORGI_REVIEWER_DEMO_DATABASE_URL"), max: 2 })
  const redis = new Redis(requiredEnvironment("CORGI_REVIEWER_DEMO_PRODUCTION_REDIS_URL"), { maxRetriesPerRequest: 1 })
  try {
    const beforeDatabase = await databaseFingerprint(database)
    const beforeRedis = await redisFingerprint(redis, ["fastify-rate-limit-"])
    await action()
    expect(await databaseFingerprint(database)).toEqual(beforeDatabase)
    expect(await redisFingerprint(redis, ["fastify-rate-limit-"])).toEqual(beforeRedis)
  } finally {
    await Promise.all([database.end(), redis.quit()])
  }
}

test("production demo remains usable when tab storage is denied", async ({ context }, testInfo) => {
  await assertProductionUnchanged(async () => {
    for (const mode of ["getter", "methods"] as const) {
      const page = await context.newPage()
      const mutations: string[] = []
      const errors: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      page.on("request", (request) => {
        if (MUTATION_METHODS.has(request.method())) mutations.push(new URL(request.url()).pathname)
      })
      await page.addInitScript((denial) => {
        if (denial === "getter") {
          Object.defineProperty(window, "sessionStorage", { get() { throw new DOMException("Fixture storage denial", "SecurityError") } })
        } else {
          for (const method of ["getItem", "setItem", "removeItem"] as const) {
            Object.defineProperty(window.sessionStorage, method, { value() { throw new DOMException("Fixture storage denial", "SecurityError") } })
          }
        }
      }, mode)
      try {
        await page.goto("/demo/")
        await expect(page.getByRole("status").filter({ hasText: "could not read saved demo continuation" })).toBeVisible()
        const session = await createBrowserDemo(page)
        await expect(page.getByRole("status").filter({ hasText: "could not save demo continuation" })).toBeVisible()
        await page.getByRole("button", { name: "Research and tooling" }).click()
        const voted = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/votes"))
        await page.getByRole("button", { name: "Cast demo vote" }).click()
        const body = await jsonBody<DemoSessionEnvelope>(await voted)
        expect(body.payload.session.sessionId).toBe(session.sessionId)
        expect(body.payload.session.voteCount).toBe(1)
        await expect(page.getByRole("heading", { name: "Let the community weigh in" })).toBeVisible()
        expect(mutations).toEqual(["/api/demo/v4/sessions", `/api/demo/v4/sessions/${session.sessionId}/votes`])
        expect(errors).toEqual([])
        await screenshot(page, join(requiredEnvironment("CORGI_REVIEWER_DEMO_ARTIFACT_DIR"), testInfo.project.name), `07-storage-${mode}`)
      } finally {
        await page.close()
      }
    }
  })
})

test("production demo requires tab opt-in and recovers invalid, transient and expired continuation", async ({ page, context }, testInfo) => {
  const mutations: string[] = []
  const sessionReads: string[] = []
  context.on("request", (request) => {
    const pathname = new URL(request.url()).pathname
    if (MUTATION_METHODS.has(request.method())) mutations.push(pathname)
    if (request.method() === "GET" && /^\/api\/demo\/v4\/sessions\/[^/]+$/.test(pathname)) sessionReads.push(pathname)
  })
  await assertProductionUnchanged(async () => {
    await page.goto("/demo/")
    await page.evaluate((key) => {
      sessionStorage.setItem("fixture-unrelated-key", "preserve")
      sessionStorage.setItem(key, "{")
    }, DEMO_RESUME_KEY)
    await page.reload()
    await expect(page.getByRole("main").getByRole("alert")).toContainText("continuation is invalid")
    expect(await page.evaluate((key) => sessionStorage.getItem(key), DEMO_RESUME_KEY)).toBeNull()
    expect(await page.evaluate(() => sessionStorage.getItem("fixture-unrelated-key"))).toBe("preserve")
    expect(mutations).toHaveLength(0)
    expect(sessionReads).toHaveLength(0)

    const session = await createBrowserDemo(page)
    const sessionPath = `/api/demo/v4/sessions/${session.sessionId}`
    const popupReady = page.waitForEvent("popup")
    await page.evaluate(() => window.open("/demo/", "_blank"))
    const popup = await popupReady
    try {
      await expect(popup.getByRole("button", { name: "Restore demo session" })).toBeVisible()
      expect(await popup.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? "null").sessionId, DEMO_RESUME_KEY)).toBe(session.sessionId)
      expect(sessionReads).toHaveLength(0)
      expect(mutations).toHaveLength(1)
      await popup.getByRole("button", { name: "Restore demo session" }).click()
      await expect(popup.getByRole("heading", { name: "Cast your demo vote" })).toBeVisible()
      expect(sessionReads).toEqual([sessionPath])
      expect(mutations).toHaveLength(1)
    } finally {
      await popup.close()
    }

    await page.goto("/demo/")
    await expect(page.getByRole("button", { name: "Restore demo session" })).toBeVisible()
    expect(sessionReads).toHaveLength(1)
    await page.route(`**${sessionPath}`, (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "Fixture transient GET failure" } }) }), { times: 1 })
    await page.getByRole("button", { name: "Restore demo session" }).click()
    await expect(page.getByRole("main").getByRole("alert")).toBeVisible()
    await expect(page.getByRole("button", { name: "Restore demo session" })).toBeEnabled()
    expect(await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? "null").sessionId, DEMO_RESUME_KEY)).toBe(session.sessionId)
    await page.getByRole("button", { name: "Restore demo session" }).click()
    await expect(page.getByRole("heading", { name: "Cast your demo vote" })).toBeVisible()
    expect(mutations).toHaveLength(1)

    await page.evaluate((key) => {
      const hint = JSON.parse(sessionStorage.getItem(key) ?? "null")
      hint.expiresAt = new Date(0).toISOString()
      sessionStorage.setItem(key, JSON.stringify(hint))
    }, DEMO_RESUME_KEY)
    const readsBeforeExpiry = sessionReads.length
    await page.reload()
    await expect(page.getByRole("main").getByRole("alert")).toContainText("saved demo session has expired")
    expect(sessionReads).toHaveLength(readsBeforeExpiry)
    expect(mutations).toHaveLength(1)
    expect(await page.evaluate((key) => sessionStorage.getItem(key), DEMO_RESUME_KEY)).toBeNull()

    const expiring = await createBrowserDemo(page)
    const demoRedis = new Redis(requiredEnvironment("CORGI_REVIEWER_DEMO_ISOLATED_REDIS_URL"), { maxRetriesPerRequest: 1 })
    try {
      expect(await demoRedis.pexpire(`demo:session:${expiring.sessionId}`, 1)).toBe(1)
      await expect.poll(async () => demoRedis.exists(`demo:session:${expiring.sessionId}`)).toBe(0)
      const expiredRead = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/demo/v4/sessions/${expiring.sessionId}`)
      await page.reload()
      expect((await expiredRead).status()).toBe(404)
      await expect(page.getByRole("main").getByRole("alert")).toContainText("expired or is no longer available")
      await expect(page.getByRole("button", { name: "Start a demo session" })).toBeVisible()
      expect(await page.evaluate((key) => sessionStorage.getItem(key), DEMO_RESUME_KEY)).toBeNull()
      expect(mutations).toHaveLength(2)
      await screenshot(page, join(requiredEnvironment("CORGI_REVIEWER_DEMO_ARTIFACT_DIR"), testInfo.project.name), "08-owned-server-ttl-expired")
    } finally {
      await demoRedis.quit()
    }
  })
})

test("production demo cancels stale session and receipt recovery after reset", async ({ page }, testInfo) => {
  await assertProductionUnchanged(async () => {
    await page.goto("/demo/")
    const old = await createBrowserDemo(page)
    let releaseSession!: () => void
    let noteSession!: () => void
    const heldSession = new Promise<void>((resolve) => { releaseSession = resolve })
    const sessionStarted = new Promise<void>((resolve) => { noteSession = resolve })
    let sessionDelivery: Promise<void> | null = null
    await page.route(`**/api/demo/v4/sessions/${old.sessionId}`, async (route) => {
      const response = await route.fetch()
      expect(response.status()).toBe(200)
      noteSession()
      await heldSession
      sessionDelivery = route.fulfill({ response })
      await sessionDelivery
    }, { times: 1 })
    try {
      await page.reload()
      await sessionStarted
      await page.getByRole("button", { name: "Start a new session" }).click()
      const current = await createBrowserDemo(page)
      expect(current.sessionId).not.toBe(old.sessionId)
      releaseSession()
      await page.unrouteAll({ behavior: "wait" })
      if (sessionDelivery !== null) await sessionDelivery
      expect(await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? "null").sessionId, DEMO_RESUME_KEY)).toBe(current.sessionId)
      await expect(page.getByRole("heading", { name: "Cast your demo vote" })).toBeVisible()
    } finally {
      releaseSession()
      await page.unrouteAll({ behavior: "wait" })
    }

    await page.getByRole("button", { name: "Research and tooling" }).click()
    await page.getByRole("button", { name: "Cast demo vote" }).click()
    await expect(page.getByRole("heading", { name: "Let the community weigh in" })).toBeVisible()
    await page.getByRole("button", { name: "Simulate 24 voters" }).click()
    await expect(page.getByRole("heading", { name: "Advance the shadow epoch" })).toBeVisible()
    await page.getByRole("button", { name: "Advance epoch" }).click()
    // Normal advance automatically loads the top receipt; wait for that stable
    // state before holding the next receipt request for the reset race.
    await expect(page.getByRole("heading", { name: /Why ranked #/ })).toBeVisible()
    const feedButton = page.getByRole("button", { name: "Ranked feed" })
    if (await feedButton.isVisible()) await feedButton.click()
    let releaseReceipt!: () => void
    let noteReceipt!: () => void
    const heldReceipt = new Promise<void>((resolve) => { releaseReceipt = resolve })
    const receiptStarted = new Promise<void>((resolve) => { noteReceipt = resolve })
    await page.route(/\/api\/demo\/v4\/sessions\/[^/]+\/receipts\?/, async (route) => {
      const response = await route.fetch()
      expect(response.status()).toBe(200)
      noteReceipt()
      await heldReceipt
      await route.fulfill({ response })
    }, { times: 1 })
    try {
      await page.getByRole("button", { name: "Inspect ranking", exact: true }).first().click()
      await receiptStarted
      await page.getByRole("button", { name: "Start over" }).click()
      const replacement = await createBrowserDemo(page)
      releaseReceipt()
      await page.unrouteAll({ behavior: "wait" })
      await expect(page.getByRole("heading", { name: /Why ranked #/ })).toHaveCount(0)
      await expect(page.getByRole("heading", { name: "Cast your demo vote" })).toBeVisible()
      const hint = await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? "null"), DEMO_RESUME_KEY) as { sessionId: string; selection: unknown }
      expect(hint.sessionId).toBe(replacement.sessionId)
      expect(hint.selection).toBeNull()
      await screenshot(page, join(requiredEnvironment("CORGI_REVIEWER_DEMO_ARTIFACT_DIR"), testInfo.project.name), "09-stale-response-reset")
    } finally {
      releaseReceipt()
      await page.unrouteAll({ behavior: "wait" })
    }
  })
})

async function publishBrowserDemoForReceiptRecovery(page: Page): Promise<DemoSession> {
  await page.goto("/demo/")
  const session = await createBrowserDemo(page)
  await page.getByRole("button", { name: "Research and tooling" }).click()
  await page.getByRole("button", { name: "Cast demo vote" }).click()
  await expect(page.getByRole("heading", { name: "Let the community weigh in" })).toBeVisible()
  await page.getByRole("button", { name: "Simulate 24 voters" }).click()
  await expect(page.getByRole("heading", { name: "Advance the shadow epoch" })).toBeVisible()
  await page.getByRole("button", { name: "Advance epoch" }).click()
  await expect(page.getByRole("heading", { name: /Why ranked #/ })).toBeVisible()
  return session
}

for (const failure of ["unavailable", "mismatched"] as const) {
  test(`production demo restores usable session after ${failure} saved receipt`, async ({ page }, testInfo) => {
    await assertProductionUnchanged(async () => {
      const mutations: string[] = []
      page.on("request", (request) => {
        if (MUTATION_METHODS.has(request.method())) mutations.push(new URL(request.url()).pathname)
      })
      const session = await publishBrowserDemoForReceiptRecovery(page)
      expect(mutations).toHaveLength(4)
      const hintBefore = await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? "null"), DEMO_RESUME_KEY) as DemoSessionResume
      expect(hintBefore.selection).not.toBeNull()
      let intercepted = 0
      await page.route(/\/api\/demo\/v4\/sessions\/[^/]+\/receipts\?/, async (route) => {
        const response = await route.fetch()
        expect(response.status()).toBe(200)
        intercepted += 1
        if (failure === "unavailable") {
          await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "SyntheticReceiptUnavailable", message: "Synthetic saved receipt unavailable" }) })
        } else {
          const body = await jsonBody<DemoReceiptEnvelope>(response)
          body.payload.receipt.postUri = "at://did:plc:syntheticmismatch/app.bsky.feed.post/wrong"
          await route.fulfill({ response, json: body })
        }
      }, { times: 1 })
      try {
        await page.reload()
        await expect(page.getByRole("main").getByRole("alert")).toContainText(failure === "unavailable"
          ? "Synthetic saved receipt unavailable"
          : "did not match the restored post, epoch, rank and score")
        expect(intercepted).toBe(1)
        await expect(page.getByRole("button", { name: "Restore demo session" })).toHaveCount(0)
        await expect(page.getByRole("heading", { name: /Why ranked #/ })).toHaveCount(0)
        const hintAfter = await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? "null"), DEMO_RESUME_KEY) as DemoSessionResume
        expect(hintAfter).toEqual({ ...hintBefore, selection: null, mobileView: "feed" })
        expect(hintAfter.sessionId).toBe(session.sessionId)
        const feedButton = page.getByRole("button", { name: "Ranked feed" })
        if (await feedButton.isVisible()) await expect(feedButton).toHaveAttribute("aria-pressed", "true")
        expect(mutations).toHaveLength(4)

        await page.getByRole("button", { name: "Inspect ranking", exact: true }).first().click()
        await expect(page.getByRole("heading", { name: /Why ranked #/ })).toBeVisible()
        await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0)
        await page.getByRole("button", { name: "Run another epoch", exact: true }).click()
        await expect(page.getByRole("heading", { name: "Cast your demo vote" })).toBeVisible()
        await page.getByRole("button", { name: "Research and tooling" }).click()
        await expect(page.getByRole("button", { name: "Cast demo vote" })).toBeEnabled()
        expect(mutations).toHaveLength(4)
        await screenshot(page, join(requiredEnvironment("CORGI_REVIEWER_DEMO_ARTIFACT_DIR"), testInfo.project.name), `10-saved-receipt-${failure}-recovered`)
      } finally {
        await page.unrouteAll({ behavior: "wait" })
      }
    })
  })
}

test("production demo ignores failed saved receipt recovery after reset", async ({ page }, testInfo) => {
  await assertProductionUnchanged(async () => {
    const mutations: string[] = []
    page.on("request", (request) => {
      if (MUTATION_METHODS.has(request.method())) mutations.push(new URL(request.url()).pathname)
    })
    const old = await publishBrowserDemoForReceiptRecovery(page)
    let releaseReceipt!: () => void
    const heldReceipt = new Promise<void>((resolve) => { releaseReceipt = resolve })
    let receiptStarted = false
    await page.route(/\/api\/demo\/v4\/sessions\/[^/]+\/receipts\?/, async (route) => {
      const response = await route.fetch()
      expect(response.status()).toBe(200)
      receiptStarted = true
      await heldReceipt
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "SyntheticLateReceiptUnavailable", message: "Synthetic obsolete receipt failure" }) })
    }, { times: 1 })
    try {
      await page.reload()
      await expect.poll(() => receiptStarted).toBe(true)
      await page.getByRole("button", { name: "Start over" }).click()
      await expect.poll(() => page.evaluate((key) => sessionStorage.getItem(key), DEMO_RESUME_KEY)).toBeNull()
      const replacement = await createBrowserDemo(page)
      expect(replacement.sessionId).not.toBe(old.sessionId)
      const replacementHint = await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? "null"), DEMO_RESUME_KEY) as DemoSessionResume
      releaseReceipt()
      await page.unrouteAll({ behavior: "wait" })
      expect(await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? "null"), DEMO_RESUME_KEY)).toEqual(replacementHint)
      await expect(page.getByRole("heading", { name: "Cast your demo vote" })).toBeVisible()
      await expect(page.getByRole("heading", { name: /Why ranked #/ })).toHaveCount(0)
      await expect(page.getByRole("button", { name: "Restore demo session" })).toHaveCount(0)
      await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0)
      expect(replacementHint.sessionId).toBe(replacement.sessionId)
      expect(replacementHint.selection).toBeNull()
      expect(mutations).toHaveLength(5)
      await screenshot(page, join(requiredEnvironment("CORGI_REVIEWER_DEMO_ARTIFACT_DIR"), testInfo.project.name), "11-obsolete-receipt-failure-reset")
    } finally {
      releaseReceipt()
      await page.unrouteAll({ behavior: "wait" })
    }
  })
})
