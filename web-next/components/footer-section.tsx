import Link from "next/link"
import { Container } from "@/components/ui/layout"

// Shared keyboard focus ring for footer links (raw Link/a don't get one otherwise).
const FOCUS =
  "rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"

// The live Corgi community-gov feed on Bluesky.
const CORGI_FEED_URL = "https://bsky.app/profile/corgi-network.bsky.social/feed/community-gov"
const GITHUB_URL = "https://github.com/andrewnordstrom-eng/bluesky-community-feed"

const linkGroups = [
  {
    heading: "Product",
    links: [
      { label: "How it works", href: "/how-it-works" },
      { label: "Live feed", href: "/feed" },
      { label: "Live demo", href: "/demo" },
      { label: "Add the feed", href: "/start" },
      { label: "History", href: "/history" },
    ],
  },
  {
    heading: "Governance",
    links: [
      { label: "Vote", href: "/vote" },
      { label: "Proposals", href: "/proposals" },
      { label: "Join the waitlist", href: "/sign-in" },
    ],
  },
  {
    heading: "Project",
    links: [
      { label: "About", href: "/about" },
      { label: "Docs", href: "/docs" },
      { label: "FAQ", href: "/#faq-section" },
      { label: "Support", href: "/support" },
    ],
  },
] as const

export function FooterSection() {
  return (
    <footer className="w-full bg-background border-t border-border/70">
      <Container>
        {/* Main footer row */}
        <div className="flex flex-col md:flex-row justify-between items-start gap-8 md:gap-0 py-10 md:py-14">
          {/* Left: Logo + tagline */}
          <div className="flex flex-col justify-start items-start gap-5">
            <span className="text-foreground text-xl font-bold tracking-tight font-display">Corgi</span>
            <p className="text-foreground/60 text-sm font-normal leading-relaxed max-w-[220px]">
              Community-shaped feeds. Inspectable ranking.
            </p>
            <div className="flex justify-start items-center gap-3">
              <a
                href={CORGI_FEED_URL}
                aria-label="Corgi Commons on Bluesky"
                className={`text-foreground/55 hover:text-primary transition-colors text-xs font-medium ${FOCUS}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Corgi Commons
              </a>
              <span className="text-foreground/55" aria-hidden="true">·</span>
              <a
                href={GITHUB_URL}
                aria-label="Corgi on GitHub"
                className={`text-foreground/55 hover:text-primary transition-colors text-xs font-medium ${FOCUS}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                GitHub
              </a>
            </div>
          </div>

          {/* Right: Links */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-8 md:gap-12 w-full md:w-auto">
            {linkGroups.map((group) => (
              <div key={group.heading} className="flex flex-col gap-3">
                <h3 className="text-foreground/55 text-xs font-semibold tracking-wide uppercase">{group.heading}</h3>
                <div className="flex flex-col gap-1">
                  {/* py-1 grows each link's touch target without changing the visual rhythm (gap absorbs it) */}
                  {group.links.map((link) => (
                    <Link
                      key={link.label}
                      href={link.href}
                      className={`py-1 text-foreground/70 text-sm font-normal leading-5 hover:text-primary transition-colors ${FOCUS}`}
                    >
                      {link.label}
                    </Link>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Copyright bar */}
        <div className="border-t border-border/60 py-5 flex flex-col sm:flex-row items-center justify-between gap-3">
          <p className="text-foreground/50 text-xs font-normal">
            &copy; 2026 Corgi. Built on Bluesky. Open source.
          </p>
          <div className="flex items-center gap-4">
            <Link href="/tos" className={`text-foreground/60 hover:text-primary transition-colors text-xs font-medium ${FOCUS}`}>
              Terms
            </Link>
            <Link href="/privacy" className={`text-foreground/60 hover:text-primary transition-colors text-xs font-medium ${FOCUS}`}>
              Privacy
            </Link>
          </div>
        </div>
      </Container>
    </footer>
  )
}
