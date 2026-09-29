"use client"

import { useId, useState } from "react"
import { ChevronDown } from "lucide-react"
import type { PublicFeedSnapshot } from "@/lib/public-feed"
import { SIGNAL_COLORS } from "@/lib/signals"
import { joinLabels, summarizeFeedPolicy } from "./feed-policy-summary"

export function FeedPolicyContext({ snapshot }: { readonly snapshot: PublicFeedSnapshot }) {
  const [expanded, setExpanded] = useState(false)
  const headingId = useId()
  const detailsId = useId()
  const summary = summarizeFeedPolicy(snapshot)
  const leading = joinLabels(summary.leadingLabels)
  const leadingSentence = summary.leadingLabels.length === 1
    ? `${leading} counts most, so it is usually the strongest contribution on a post’s receipt.`
    : `${leading} count most, so one of them is usually the strongest contribution on a post’s receipt.`

  return (
    <section
      aria-labelledby={headingId}
      data-feed-policy-context
      className="mb-6 rounded-2xl border border-border/70 bg-card p-5 shadow-[0_2px_12px_rgba(46,38,32,0.06)] md:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={headingId} className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">
          How this feed is ranked
        </h2>
        <span className="rounded-full border border-primary/20 bg-primary/10 px-2.5 py-1 font-mono text-[10px] font-semibold text-primary-dark">
          Epoch {summary.epochId} · pilot policy
        </span>
      </div>

      <p className="mt-3 max-w-3xl text-sm leading-relaxed text-foreground/70">
        This feed is ranked by a pilot policy set during early testing, not yet by an open community vote. Every post gets five signal scores; each is multiplied by its weight below, and the results are added.
      </p>

      <div
        className="mt-4 flex h-2.5 overflow-hidden rounded-full bg-border/60"
        role="img"
        aria-label={`Active weights: ${summary.weights.map((entry) => `${entry.label} ${entry.percent}`).join(", ")}`}
      >
        {summary.weights.map((entry) => (
          <span key={entry.key} className="h-full" style={{ width: `${entry.share * 100}%`, backgroundColor: SIGNAL_COLORS[entry.key] }} />
        ))}
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-2" aria-label="Active weights">
        {summary.weights.map((entry) => (
          <li key={entry.key} className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-foreground/65">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: SIGNAL_COLORS[entry.key] }} aria-hidden="true" />
            {entry.label} <span className="font-mono tabular-nums text-foreground">{entry.percent}</span>
          </li>
        ))}
      </ul>

      <p className="mt-4 max-w-3xl text-sm leading-relaxed text-foreground/70">
        {leadingSentence} Select “Why this order” on any post to see its math.
      </p>

      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
        aria-controls={detailsId}
        className="-ml-2 mt-2 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-bold text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary motion-reduce:transition-none"
      >
        {expanded ? "Show less" : "How to read this"}
        <ChevronDown className={`h-3.5 w-3.5 transition-transform motion-reduce:transition-none ${expanded ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>

      {/* Toggle display by class: the `grid` utility would otherwise override the `hidden` attribute. */}
      <dl id={detailsId} className={`${expanded ? "grid" : "hidden"} mt-3 gap-4 border-t border-border/60 pt-4 sm:grid-cols-2`}>
        <div>
          <dt className="text-xs font-semibold text-foreground">Relevance</dt>
          <dd className="mt-1 text-xs leading-relaxed text-foreground/60">
            How well a post matches the topics this community prioritizes.
            {summary.keywordOnly ? " Topics are detected by keywords in the post text, so a passing mention can count as a match." : null}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-semibold text-foreground">Recency and engagement</dt>
          <dd className="mt-1 text-xs leading-relaxed text-foreground/60">
            Newer posts score higher, as do posts with more likes, reposts, and replies. Engagement uses a log scale, so one viral post can’t take over.
          </dd>
        </div>
        <div>
          <dt className="text-xs font-semibold text-foreground">Bridging and source diversity</dt>
          <dd className="mt-1 text-xs leading-relaxed text-foreground/60">
            Smaller nudges: toward posts engaged with by people who follow different accounts, and away from one author filling the feed.
          </dd>
        </div>
        <div>
          <dt className="text-xs font-semibold text-foreground">Who sets the weights</dt>
          <dd className="mt-1 text-xs leading-relaxed text-foreground/60">
            Approved pilot members vote in rounds, and results are reviewed before they apply. A new epoch starts whenever the weights change.
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs font-semibold text-foreground">Withheld rows</dt>
          <dd className="mt-1 text-xs leading-relaxed text-foreground/60">
            A post that fails a public visibility check is withheld here, but its position is kept so the published order isn’t rewritten.
          </dd>
        </div>
      </dl>
    </section>
  )
}
