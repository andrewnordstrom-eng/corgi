import type { Metadata } from "next"
import { FooterSection } from "@/components/footer-section"
import { Header } from "@/components/header"
import { PublicLiveFeed } from "@/components/feed/public-live-feed"

export const metadata: Metadata = {
  title: "Live feed ranking - See why Corgi posts are ordered",
  description:
    "Inspect the live Corgi Commons feed, its active community weights, and the score contributions behind every published position—no account required.",
  alternates: { canonical: "/feed/" },
  openGraph: {
    title: "Corgi live feed ranking",
    description: "See the published feed order and inspect why every post appears where it does.",
    url: "/feed/",
  },
}

export default function FeedPage() {
  return (
    <div className="min-h-screen overflow-x-hidden bg-background text-foreground">
      <Header />
      <PublicLiveFeed />
      <FooterSection />
    </div>
  )
}
