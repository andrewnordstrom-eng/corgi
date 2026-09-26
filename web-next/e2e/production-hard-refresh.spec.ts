import { expect, test, type APIRequestContext, type Page } from "@playwright/test"

interface PublicRoute {
  path: string
  heading: RegExp
}

interface BrowserErrors {
  console: string[]
  page: string[]
}

interface RouteFailure {
  path: string
  check: string
  actual: string
}

const PUBLIC_ROUTES: readonly PublicRoute[] = [
  { path: "/", heading: /Make Bluesky care about what your community cares about/i },
  { path: "/demo/", heading: /Re-rank a frozen Corgi Commons snapshot/i },
  { path: "/feed/", heading: /See the live feed—and why it is in this order/i },
  { path: "/how-it-works/", heading: /Watch the same posts become a different feed/i },
  { path: "/start/", heading: /Add the Corgi feed in Bluesky/i },
]

const HTML_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
const REQUIRED_HTML_SCRIPT_POLICY = "script-src 'self' 'unsafe-inline'"
const REQUIRED_HTML_FRAME_POLICY = "frame-src 'self' https://www.youtube-nocookie.com"
const REQUIRED_RATE_LIMIT_HEADROOM = 120

function collectBrowserErrors(page: Page): BrowserErrors {
  const errors: BrowserErrors = { console: [], page: [] }

  page.on("console", (message) => {
    if (message.type() === "error") {
      const location = message.location()
      const source = location.url === "" ? "unknown source" : `${location.url}:${location.lineNumber}`
      errors.console.push(`${message.text()} (${source})`)
    }
  })
  page.on("pageerror", (error) => {
    errors.page.push(error.message)
  })

  return errors
}

async function isRouteVisible(page: Page, route: PublicRoute): Promise<boolean> {
  const headingVisible = await page.getByRole("heading", { level: 1, name: route.heading }).isVisible()
  const mainVisible = await page.locator("main").isVisible()
  return headingVisible && mainVisible
}

async function verifyConditionalHeaders(
  request: APIRequestContext,
  route: PublicRoute,
): Promise<RouteFailure[]> {
  const failures: RouteFailure[] = []
  const initial = await request.get(route.path, {
    headers: { accept: HTML_ACCEPT },
  })

  if (initial.status() !== 200) {
    failures.push({ path: route.path, check: "initial HTTP status", actual: String(initial.status()) })
    return failures
  }

  const etag = initial.headers().etag
  const bodyLength = (await initial.body()).byteLength
  if (bodyLength === 0) {
    failures.push({ path: route.path, check: "initial response body", actual: "0 bytes" })
  }
  if (!initial.headers()["content-security-policy"]?.includes(REQUIRED_HTML_SCRIPT_POLICY)) {
    failures.push({
      path: route.path,
      check: "200 CSP",
      actual: initial.headers()["content-security-policy"] ?? "missing",
    })
  }
  if (!initial.headers()["content-security-policy"]?.includes(REQUIRED_HTML_FRAME_POLICY)) {
    failures.push({
      path: route.path,
      check: "200 iframe CSP",
      actual: initial.headers()["content-security-policy"] ?? "missing",
    })
  }

  if (etag === undefined) {
    failures.push({ path: route.path, check: "ETag", actual: "missing" })
    return failures
  }

  const conditional = await request.get(route.path, {
    headers: {
      accept: HTML_ACCEPT,
      "if-none-match": etag,
    },
  })

  if (conditional.status() !== 304) {
    failures.push({ path: route.path, check: "conditional HTTP status", actual: String(conditional.status()) })
  }
  if (!conditional.headers()["content-security-policy"]?.includes(REQUIRED_HTML_SCRIPT_POLICY)) {
    failures.push({
      path: route.path,
      check: "304 CSP",
      actual: conditional.headers()["content-security-policy"] ?? "missing",
    })
  }
  if (!conditional.headers()["content-security-policy"]?.includes(REQUIRED_HTML_FRAME_POLICY)) {
    failures.push({
      path: route.path,
      check: "304 iframe CSP",
      actual: conditional.headers()["content-security-policy"] ?? "missing",
    })
  }
  if (conditional.headers()["cache-control"] !== "no-cache") {
    failures.push({
      path: route.path,
      check: "304 cache policy",
      actual: conditional.headers()["cache-control"] ?? "missing",
    })
  }

  return failures
}

async function verifyStaticAssetHeaders(request: APIRequestContext): Promise<RouteFailure[]> {
  const failures: RouteFailure[] = []
  const home = await request.get("/", { headers: { accept: HTML_ACCEPT } })
  if (home.status() !== 200) {
    return [{ path: "/", check: "asset discovery status", actual: String(home.status()) }]
  }
  const html = await home.text()
  const assetPath = html.match(/\/_next\/static\/[^"']+\.js/)?.[0]
  if (assetPath === undefined) {
    return [{ path: "/", check: "hashed Next asset discovery", actual: "missing" }]
  }

  const asset = await request.get(assetPath)
  if (asset.status() !== 200) {
    failures.push({ path: assetPath, check: "asset HTTP status", actual: String(asset.status()) })
    return failures
  }
  if (asset.headers()["cache-control"] !== "public, max-age=31536000, immutable") {
    failures.push({
      path: assetPath,
      check: "asset 200 cache policy",
      actual: asset.headers()["cache-control"] ?? "missing",
    })
  }
  const etag = asset.headers().etag
  if (etag === undefined) {
    failures.push({ path: assetPath, check: "asset ETag", actual: "missing" })
    return failures
  }

  const conditional = await request.get(assetPath, {
    headers: { accept: HTML_ACCEPT, "if-none-match": etag },
  })
  if (conditional.status() !== 304) {
    failures.push({ path: assetPath, check: "asset conditional HTTP status", actual: String(conditional.status()) })
  }
  if (conditional.headers()["cache-control"] !== "public, max-age=31536000, immutable") {
    failures.push({
      path: assetPath,
      check: "asset 304 cache policy",
      actual: conditional.headers()["cache-control"] ?? "missing",
    })
  }
  if (conditional.headers()["content-security-policy"]?.includes(REQUIRED_HTML_SCRIPT_POLICY)) {
    failures.push({
      path: assetPath,
      check: "asset 304 CSP isolation",
      actual: conditional.headers()["content-security-policy"] ?? "missing",
    })
  }
  return failures
}

async function waitForRateLimitHeadroom(request: APIRequestContext): Promise<void> {
  const response = await request.head("/health")
  const remaining = Number(response.headers()["x-ratelimit-remaining"])
  const resetSeconds = Number(response.headers()["x-ratelimit-reset"])
  if (!Number.isFinite(remaining) || !Number.isFinite(resetSeconds)) {
    const hostname = new URL(response.url()).hostname
    if (hostname === "127.0.0.1" || hostname === "localhost") {
      return
    }
    throw new Error("Production health response did not include numeric rate-limit headers")
  }
  if (remaining >= REQUIRED_RATE_LIMIT_HEADROOM) {
    return
  }

  const waitMilliseconds = Math.min((resetSeconds + 1) * 1_000, 60_000)
  await new Promise<void>((resolve) => {
    setTimeout(resolve, waitMilliseconds)
  })
}

test("public routes survive revalidation and cache-bypassing refresh", async ({ page, request }, testInfo) => {
  await waitForRateLimitHeadroom(request)
  const browserErrors = collectBrowserErrors(page)
  const failures: RouteFailure[] = []

  for (const [routeIndex, route] of PUBLIC_ROUTES.entries()) {
    const initial = await page.goto(route.path, { waitUntil: "domcontentloaded" })
    if (initial?.status() !== 200) {
      failures.push({ path: route.path, check: "initial browser status", actual: String(initial?.status()) })
      continue
    }
    if (!(await isRouteVisible(page, route))) {
      failures.push({ path: route.path, check: "initial render", actual: "main heading not visible" })
    }

    await page.reload({ waitUntil: "domcontentloaded" })
    if (!(await isRouteVisible(page, route))) {
      failures.push({ path: route.path, check: "ordinary revalidation", actual: "main heading not visible" })
    }

    const cacheBypassPath = `${route.path}?corgi-hard-refresh-smoke=${routeIndex}`
    const cacheBypass = await page.goto(cacheBypassPath, { waitUntil: "domcontentloaded" })
    if (cacheBypass?.status() !== 200) {
      failures.push({ path: route.path, check: "cache-bypassing status", actual: String(cacheBypass?.status()) })
    } else if (!(await isRouteVisible(page, route))) {
      failures.push({ path: route.path, check: "cache-bypassing render", actual: "main heading not visible" })
    }

    if (testInfo.project.name === "desktop-chrome") {
      failures.push(...(await verifyConditionalHeaders(request, route)))
    }
  }

  if (testInfo.project.name === "desktop-chrome") {
    failures.push(...(await verifyStaticAssetHeaders(request)))
  }

  expect(failures, "production route failures").toEqual([])
  expect(browserErrors.console, "browser console errors").toEqual([])
  expect(browserErrors.page, "uncaught page errors").toEqual([])
})
