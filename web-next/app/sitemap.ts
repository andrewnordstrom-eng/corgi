import type { MetadataRoute } from "next"

export const dynamic = "force-static"

const SITE_URL = "https://feed.corgi.network"

// Public marketing and transparency pages. Authenticated surfaces
// (admin, dashboard, settings, research-consent) are intentionally omitted
// and disallowed in robots.ts.
const PUBLIC_ROUTES: Array<{ path: string; priority: number }> = [
  { path: "/", priority: 1 },
  { path: "/demo/", priority: 0.9 },
  { path: "/feed/", priority: 0.9 },
  { path: "/how-it-works/", priority: 0.9 },
  { path: "/start/", priority: 0.8 },
  { path: "/about/", priority: 0.6 },
  { path: "/docs/", priority: 0.6 },
  { path: "/history/", priority: 0.5 },
  { path: "/proposals/", priority: 0.5 },
  { path: "/vote/", priority: 0.5 },
  { path: "/sign-in/", priority: 0.3 },
  { path: "/support/", priority: 0.3 },
  { path: "/tos/", priority: 0.2 },
  { path: "/privacy/", priority: 0.2 },
]

export default function sitemap(): MetadataRoute.Sitemap {
  return PUBLIC_ROUTES.map(({ path, priority }) => ({
    url: `${SITE_URL}${path}`,
    changeFrequency: "weekly",
    priority,
  }))
}
