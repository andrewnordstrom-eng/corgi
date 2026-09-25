"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { motion, useReducedMotion } from "framer-motion"
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  CircleDot,
  ExternalLink,
  Loader2,
  Pin,
  RefreshCw,
} from "lucide-react"
import { BlueskyPostCard, RANK_COL_CLASS, RankColumnHeader } from "@/components/feed/bluesky-feed"
import { Button } from "@/components/ui/button"
import { Container } from "@/components/ui/layout"
import { HeroGlow, HERO_TOP, PageHero } from "@/components/ui/page-hero"
import {
  PUBLIC_FEED_POLL_INTERVAL_MS,
  isSnapshotStale,
  loadPublicFeed,
  retainSelectedUri,
  strongestContribution,
} from "@/lib/public-feed"
import type {
  LoadedPublicFeed,
  PublicFeedItem,
  PublicFeedRow,
  PublicFeedSnapshot,
} from "@/lib/public-feed"
import { SIGNAL_COLORS, SIGNAL_KEYS, SIGNAL_LABELS, SIGNAL_SHORT_LABELS } from "@/lib/signals"

type LoadMode = "accept" | "notify"
type RequestPolicy = "dedupe" | "supersede"
type FailureKind = "unavailable" | "error"

interface FailureState {
  readonly kind: FailureKind
  readonly message: string
}

interface ActiveFeedRequest {
  readonly id: number
  readonly controller: AbortController
}

function formatScore(score: number): string {
  return score.toFixed(3)
}

function formatWeight(weight: number): string {
  return `${Math.round(weight * 100)}%`
}

function formatTimestamp(value: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) {
    return "time unavailable"
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp)
}

function formatPostTime(value: string | null): string {
  if (value === null) {
    return "now"
  }
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) {
    return "now"
  }
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000))
  if (elapsedMinutes < 1) return "now"
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`
  const elapsedHours = Math.floor(elapsedMinutes / 60)
  if (elapsedHours < 24) return `${elapsedHours}h`
  return `${Math.floor(elapsedHours / 24)}d`
}

function freshnessLabel(snapshot: PublicFeedSnapshot): string {
  if (snapshot.status === "last_known_good") {
    return "Last known good snapshot"
  }
  return isSnapshotStale(snapshot, Date.now()) ? "Refresh delayed" : "Current snapshot"
}

interface AdjacentRows {
  readonly above: PublicFeedRow | null
  readonly below: PublicFeedRow | null
}

function adjacentScoreText(current: PublicFeedItem, neighbor: PublicFeedRow | null, label: "Above" | "Below"): string {
  if (neighbor === null) {
    return `${label}: no adjacent row.`
  }
  if (neighbor.item.final_score === null) {
    return `${label}: position ${neighbor.item.position} is a scoreless pinned announcement.`
  }
  if (current.final_score === null) {
    return `${label}: position ${neighbor.item.position} has score ${formatScore(neighbor.item.final_score)}; a score difference is not applicable to this announcement.`
  }
  const difference = neighbor.item.final_score - current.final_score
  const comparison = difference === 0
    ? "the same score"
    : `${formatScore(Math.abs(difference))} ${difference > 0 ? "higher" : "lower"}`
  return `${label}: position ${neighbor.item.position} has score ${formatScore(neighbor.item.final_score)}, ${comparison} than this row.`
}

function SelectionInspector({
  row,
  adjacent,
  compact,
}: {
  readonly row: PublicFeedRow
  readonly adjacent: AdjacentRows
  readonly compact: boolean
}) {
  const headingId = `feed-explanation-${compact ? "mobile" : "desktop"}-${row.item.position}`
  if (row.item.placement === "pinned_announcement" && row.item.final_score === null) {
    return (
      <article
        id={headingId}
        className={compact ? "border-t border-border/60 bg-biscuit/15 p-4" : "rounded-2xl border border-border/70 bg-card p-5 shadow-[0_2px_12px_rgba(46,38,32,0.06)]"}
      >
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">Placement note</p>
        <h2 className="mt-2 font-display text-xl font-bold text-foreground">Pinned announcement</h2>
        <p className="mt-3 text-sm leading-relaxed text-foreground/65">
          This distinct announcement was intentionally inserted into the visible feed. It has no score, and its placement is not evidence that it outranked the scored posts below it.
        </p>
        <div className="mt-4 space-y-1 border-t border-border/60 pt-3 text-xs leading-relaxed text-foreground/60">
          <p>{adjacentScoreText(row.item, adjacent.above, "Above")}</p>
          <p>{adjacentScoreText(row.item, adjacent.below, "Below")}</p>
        </div>
      </article>
    )
  }

  const item = row.item
  const strongest = strongestContribution(item)
  const engagementDelta = item.engagement_only_position - item.ranked_position
  return (
    <article
      id={headingId}
      className={compact ? "border-t border-border/60 bg-biscuit/15 p-4" : "rounded-2xl border border-border/70 bg-card p-5 shadow-[0_2px_12px_rgba(46,38,32,0.06)]"}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">Why position {item.position}</p>
          <h2 className="mt-2 font-display text-xl font-bold text-foreground">Score {formatScore(item.final_score)}</h2>
        </div>
        <span className="rounded-full border border-primary/20 bg-primary/10 px-2.5 py-1 font-mono text-[10px] font-semibold text-primary-dark">
          {item.classification_method}
        </span>
      </div>

      {item.placement === "pinned_announcement" ? (
        <div className="mt-4 flex items-start gap-2 rounded-xl border border-primary/25 bg-primary/[0.07] p-3 text-xs leading-relaxed text-foreground/70">
          <Pin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
          This announcement was already in the ranked top 50. Corgi marked it as pinned without moving it or replacing its real score; its natural ranked position is {item.ranked_position}.
        </div>
      ) : null}

      <div className="mt-4 rounded-xl border border-border/60 bg-background/70 p-3">
        <p className="text-xs font-semibold text-foreground">Strongest contribution</p>
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-2 text-sm font-semibold text-foreground">
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: SIGNAL_COLORS[strongest.key] }} aria-hidden="true" />
            {strongest.label}
          </span>
          <span className="font-mono text-sm font-bold tabular-nums text-foreground">{formatScore(strongest.component.weighted)}</span>
        </div>
      </div>

      <dl className="mt-5 space-y-3">
        {SIGNAL_KEYS.map((key) => {
          const component = item.components[key]
          const width = Math.min(100, Math.max(2, Math.abs(component.weighted) * 100))
          return (
            <div key={key}>
              <div className="flex items-baseline justify-between gap-3 text-xs">
                <dt className="font-semibold text-foreground/75">{SIGNAL_LABELS[key]}</dt>
                <dd className="font-mono tabular-nums text-foreground/65">
                  {component.raw_score.toFixed(2)} × {formatWeight(component.weight)} = {formatScore(component.weighted)}
                </dd>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-border/60" aria-hidden="true">
                <div className="h-full rounded-full" style={{ width: `${width}%`, backgroundColor: SIGNAL_COLORS[key] }} />
              </div>
            </div>
          )
        })}
      </dl>

      <div className="mt-5 border-t border-border/60 pt-4 text-xs leading-relaxed text-foreground/60">
        <p>
          Base score <span className="font-mono font-semibold text-foreground">{formatScore(item.base_score)}</span>
          {item.publication_adjustment !== 1 ? (
            <> × publication adjustment <span className="font-mono font-semibold text-foreground">{item.publication_adjustment.toFixed(3)}</span></>
          ) : null}
          {" "}produced the final score.
        </p>
        <p className="mt-2 flex items-start gap-1.5">
          {engagementDelta > 0 ? <ArrowUp className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" /> : engagementDelta < 0 ? <ArrowDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground/50" aria-hidden="true" /> : <CircleDot className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground/50" aria-hidden="true" />}
          {engagementDelta === 0
            ? `The post has the same position in an engagement-only order.`
            : `Community weighting moved it ${Math.abs(engagementDelta)} ${Math.abs(engagementDelta) === 1 ? "place" : "places"} ${engagementDelta > 0 ? "up" : "down"} from an engagement-only order.`}
        </p>
        <div className="mt-3 space-y-1 border-t border-border/60 pt-3">
          <p>{adjacentScoreText(item, adjacent.above, "Above")}</p>
          <p>{adjacentScoreText(item, adjacent.below, "Below")}</p>
        </div>
      </div>
    </article>
  )
}

function ScoreRail({ item }: { readonly item: PublicFeedRow["item"] }) {
  if (item.placement === "pinned_announcement" && item.final_score === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1.5 px-1.5 text-center">
        <Pin className="h-4 w-4 text-primary" aria-hidden="true" />
        <span className="font-mono text-[9px] font-bold uppercase tracking-[0.12em] text-primary">Pinned</span>
      </div>
    )
  }
  const strongest = strongestContribution(item)
  return (
    <div className="flex h-full flex-col items-center justify-center px-1.5 text-center">
      <span className="font-display text-xl font-bold tabular-nums text-foreground">{item.position}</span>
      <span className="mt-0.5 font-mono text-[10px] font-semibold tabular-nums text-foreground/65">{formatScore(item.final_score)}</span>
      {item.placement === "pinned_announcement" ? <Pin className="mt-1 h-3 w-3 text-primary" aria-label="Pinned announcement at its scored position" /> : null}
      <span className="mt-1 inline-flex items-center gap-1 font-mono text-[8.5px] font-bold uppercase tracking-[0.08em] text-foreground/55">
        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: SIGNAL_COLORS[strongest.key] }} aria-hidden="true" />
        {SIGNAL_SHORT_LABELS[strongest.key]}
      </span>
    </div>
  )
}

function LiveFeedRow({
  row,
  adjacent,
  selected,
  mobileExpanded,
  onExplain,
}: {
  readonly row: PublicFeedRow
  readonly adjacent: AdjacentRows
  readonly selected: boolean
  readonly mobileExpanded: boolean
  readonly onExplain: (uri: string) => void
}) {
  const explanationId = `feed-explanation-mobile-${row.item.position}`
  return (
    <div className={selected ? "relative z-10 ring-2 ring-inset ring-primary/65" : ""}>
      <div className={`${RANK_COL_CLASS} bg-white`}>
        <div className="min-w-0">
          <BlueskyPostCard
            authorDisplayName={row.post.authorDisplayName}
            authorHandle={row.post.authorHandle}
            timeLabel={formatPostTime(row.post.indexedAt)}
            avatarUrl={row.post.authorAvatar}
            bskyUrl={row.post.bskyUrl}
            text={row.post.text}
            replyCount={row.post.replyCount}
            repostCount={row.post.repostCount}
            likeCount={row.post.likeCount}
            languages={row.post.languages}
            />

          <div className="flex items-center justify-between gap-3 border-t border-[#D9E3EE]/70 px-4 py-2">
            <a
              href={row.post.bskyUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs font-semibold text-[#42576C] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0085FF]"
            >
              Open on Bluesky <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </a>

            <button
              type="button"
              onClick={() => onExplain(row.item.post_uri)}
              aria-expanded={mobileExpanded}
              aria-controls={explanationId}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-bold text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary motion-reduce:transition-none lg:hidden"
            >
              Why this order
              <ChevronDown className={`h-3.5 w-3.5 transition-transform motion-reduce:transition-none ${mobileExpanded ? "rotate-180" : ""}`} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => onExplain(row.item.post_uri)}
              aria-pressed={selected}
              className="hidden rounded-md px-2 py-1 text-xs font-bold text-foreground hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary motion-reduce:transition-none lg:inline-flex"
            >
              Why this order
            </button>
          </div>
        </div>
        <div className="border-l border-border/60 bg-biscuit/25">
          <ScoreRail item={row.item} />
        </div>
      </div>
      {mobileExpanded ? <div className="lg:hidden"><SelectionInspector row={row} adjacent={adjacent} compact={true} /></div> : null}
    </div>
  )
}

function FeedSkeleton() {
  return (
    <div className="overflow-hidden rounded-[1.25rem] border border-[#D9E3EE] bg-white" aria-label="Loading live feed">
      <div className="h-20 animate-pulse border-b border-[#D9E3EE] bg-[#EDF3F8] motion-reduce:animate-none" />
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className={`${RANK_COL_CLASS} border-b border-[#D9E3EE] last:border-b-0`}>
          <div className="space-y-3 px-4 py-5">
            <div className="h-4 w-2/5 animate-pulse rounded bg-[#E1E8F0] motion-reduce:animate-none" />
            <div className="h-3 w-4/5 animate-pulse rounded bg-[#EDF3F8] motion-reduce:animate-none" />
            <div className="h-3 w-3/5 animate-pulse rounded bg-[#EDF3F8] motion-reduce:animate-none" />
          </div>
          <div className="border-l border-border/60 bg-biscuit/25" />
        </div>
      ))}
    </div>
  )
}

function FeedFailure({ failure, onRetry }: { readonly failure: FailureState; readonly onRetry: () => void }) {
  return (
    <div className="rounded-2xl border border-border/70 bg-card px-6 py-10 text-center">
      <AlertCircle className="mx-auto h-6 w-6 text-primary" aria-hidden="true" />
      <h2 className="mt-3 font-display text-2xl font-bold text-foreground">
        {failure.kind === "unavailable" ? "The public snapshot is unavailable" : "The feed could not be loaded"}
      </h2>
      <p className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-foreground/60">{failure.message}</p>
      <Button type="button" onClick={onRetry} className="mt-5">Try again</Button>
    </div>
  )
}

function PolicyWeights({ snapshot }: { readonly snapshot: PublicFeedSnapshot }) {
  return (
    <div className="border-t border-border/60 bg-biscuit/10 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-foreground/50">Active weights</span>
        {SIGNAL_KEYS.map((key) => (
          <span key={key} className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-foreground/65">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: SIGNAL_COLORS[key] }} aria-hidden="true" />
            {SIGNAL_LABELS[key]} {formatWeight(snapshot.active_weights[key])}
          </span>
        ))}
      </div>
    </div>
  )
}

export function PublicLiveFeed() {
  const [data, setData] = useState<LoadedPublicFeed | null>(null)
  const [pendingData, setPendingData] = useState<string | null>(null)
  const [selectedUri, setSelectedUri] = useState<string | null>(null)
  const [expandedMobileUri, setExpandedMobileUri] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [failure, setFailure] = useState<FailureState | null>(null)
  const [announcement, setAnnouncement] = useState("Loading the public live feed.")
  const dataRef = useRef<LoadedPublicFeed | null>(null)
  const selectedUriRef = useRef<string | null>(null)
  const activeRequestRef = useRef<ActiveFeedRequest | null>(null)
  const nextRequestIdRef = useRef(0)
  const reduceMotion = useReducedMotion() ?? false

  useEffect(() => {
    dataRef.current = data
  }, [data])
  useEffect(() => {
    selectedUriRef.current = selectedUri
  }, [selectedUri])

  const commitData = useCallback((nextData: LoadedPublicFeed, message: string) => {
    const nextSelectedUri = retainSelectedUri(selectedUriRef.current, nextData.rows)
    dataRef.current = nextData
    setData(nextData)
    selectedUriRef.current = nextSelectedUri
    setSelectedUri(nextSelectedUri)
    setExpandedMobileUri((current) => (
      current !== null && nextData.rows.some((row) => row.item.post_uri === current) ? current : null
    ))
    setPendingData(null)
    setFailure(null)
    setAnnouncement(message)
  }, [])

  const requestFeed = useCallback(async (mode: LoadMode, policy: RequestPolicy) => {
    const activeRequest = activeRequestRef.current
    if (activeRequest !== null) {
      if (policy === "dedupe") return
      activeRequest.controller.abort(new DOMException("Superseded by a newer feed request", "AbortError"))
    }

    const controller = new AbortController()
    const requestId = nextRequestIdRef.current + 1
    nextRequestIdRef.current = requestId
    activeRequestRef.current = { id: requestId, controller }
    const isCurrentRequest = (): boolean => activeRequestRef.current?.id === requestId
    const hasData = dataRef.current !== null
    if (hasData) setRefreshing(true)
    else setLoading(true)

    try {
      const result = await loadPublicFeed(
        controller.signal,
        dataRef.current,
        fetch,
        mode === "notify" ? dataRef.current : null,
      )
      if (!isCurrentRequest()) return

      const currentSnapshotId = dataRef.current?.snapshot.presentation_snapshot_id
      if (result.kind === "pending") {
        dataRef.current = result.data
        setData(result.data)
        setPendingData(result.pendingSnapshotId)
        setAnnouncement("A newer live feed snapshot is available. Choose Show latest to update the order.")
        return
      }
      commitData(
        result.data,
        currentSnapshotId === undefined
          ? `Loaded ${result.data.rows.length} published feed positions.`
          : result.kind === "not_modified"
            ? "Post visibility refreshed. The displayed ranking is unchanged."
            : "The live feed order has been updated.",
      )
    } catch {
      if (controller.signal.aborted || !isCurrentRequest()) return
      // Unknown eligibility cannot authorize retaining a previously public body.
      // Keep upstream response bodies and identifiers out of visible error state.
      dataRef.current = null
      selectedUriRef.current = null
      setData(null)
      setPendingData(null)
      setSelectedUri(null)
      setExpandedMobileUri(null)
      setFailure({ kind: "unavailable", message: "Current public feed visibility could not be verified. Try again shortly." })
      setAnnouncement("The public live feed is unavailable.")
    } finally {
      if (isCurrentRequest()) {
        activeRequestRef.current = null
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [commitData])

  useEffect(() => {
    void requestFeed("accept", "supersede")
    return () => {
      const activeRequest = activeRequestRef.current
      activeRequestRef.current = null
      activeRequest?.controller.abort(new DOMException("Feed view unmounted", "AbortError"))
    }
  }, [requestFeed])

  useEffect(() => {
    const checkWhenVisible = (): void => {
      if (document.visibilityState === "visible") {
        void requestFeed("notify", "dedupe")
      }
    }
    const intervalId = window.setInterval(checkWhenVisible, PUBLIC_FEED_POLL_INTERVAL_MS)
    window.addEventListener("focus", checkWhenVisible)
    document.addEventListener("visibilitychange", checkWhenVisible)
    return () => {
      window.clearInterval(intervalId)
      window.removeEventListener("focus", checkWhenVisible)
      document.removeEventListener("visibilitychange", checkWhenVisible)
    }
  }, [requestFeed])

  const selectedRow = useMemo(() => (
    data?.rows.find((row) => row.item.post_uri === selectedUri) ?? data?.rows[0] ?? null
  ), [data, selectedUri])
  const selectedAdjacent = useMemo<AdjacentRows>(() => {
    if (data === null || selectedRow === null) return { above: null, below: null }
    const index = data.rows.findIndex((row) => row.item.post_uri === selectedRow.item.post_uri)
    return {
      above: index > 0 ? data.rows[index - 1] ?? null : null,
      below: index >= 0 ? data.rows[index + 1] ?? null : null,
    }
  }, [data, selectedRow])

  const stale = data !== null && isSnapshotStale(data.snapshot, Date.now())

  const handleExplain = (uri: string): void => {
    setSelectedUri(uri)
    setExpandedMobileUri((current) => current === uri ? null : uri)
    setAnnouncement(`Showing the ranking explanation for ${uri}.`)
  }

  const acceptPending = (): void => {
    if (pendingData === null) return
    void requestFeed("accept", "supersede")
  }

  return (
    <main className="relative z-10">
      <p className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</p>
      <section className={`relative border-b border-border/60 pb-10 md:pb-12 ${HERO_TOP}`}>
        <HeroGlow />
        <Container className="relative">
          <PageHero
            size="lg"
            eyebrow="Public ranking record"
            title="See the live feed—and why it is in this order."
            subtitle="No Corgi account required. This page pairs the exact published order with its active community weights and score contributions."
          />
          <div className="mt-7 flex flex-wrap items-center gap-3 text-xs text-foreground/60">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-card px-3 py-1.5">
              <span className={`h-2 w-2 rounded-full ${stale ? "bg-amber-500" : "bg-[#4F8D7A]"}`} aria-hidden="true" />
              {data === null ? failure === null ? "Connecting to public snapshot" : "Public snapshot unavailable" : freshnessLabel(data.snapshot)}
            </span>
            {data !== null ? <span>Published {formatTimestamp(data.snapshot.published_at)} · Epoch {data.snapshot.epoch_id}</span> : null}
          </div>
        </Container>
      </section>

      <Container width="stage" className="py-8 md:py-12">
        {pendingData !== null ? (
          <div className="mb-5 flex flex-col gap-3 rounded-xl border border-primary/25 bg-primary/[0.07] px-4 py-3 sm:flex-row sm:items-center sm:justify-between" role="status">
            <p className="text-sm font-medium text-foreground">A newer published order is ready. Your current selection will be retained when possible.</p>
            <Button type="button" size="sm" onClick={acceptPending}>Show latest</Button>
          </div>
        ) : null}
        {stale ? (
          <div className="mb-5 rounded-xl border border-amber-400/40 bg-amber-50 px-4 py-3 text-sm text-amber-950" role="status">
            <strong>Stale snapshot.</strong> Corgi is showing {data?.snapshot.status === "last_known_good" ? "the last known good publication" : "a delayed publication"} while a current one is unavailable.
          </div>
        ) : null}

        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-foreground/50">Published feed snapshot</p>
            <h2 className="mt-1 font-display text-2xl font-bold text-foreground">Corgi Commons</h2>
            {data !== null ? (
              <p className="mt-1 text-xs text-foreground/55">Showing {data.rows.length} of {data.snapshot.total_published_items} published positions.</p>
            ) : null}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="Check for updates"
            data-refreshing={refreshing ? "true" : "false"}
            disabled={loading}
            onClick={() => void requestFeed("notify", "supersede")}
          >
            {refreshing ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
            {refreshing ? "Checking" : "Check for updates"}
          </Button>
        </div>

        {loading && data === null ? <FeedSkeleton /> : null}
        {!loading && data === null && failure !== null ? (
          <FeedFailure failure={failure} onRetry={() => void requestFeed("accept", "supersede")} />
        ) : null}
        {data !== null && data.rows.length === 0 ? (
          <div className="rounded-2xl border border-border/70 bg-card px-6 py-12 text-center">
            <h2 className="font-display text-2xl font-bold text-foreground">No published posts yet</h2>
            <p className="mx-auto mt-2 max-w-lg text-sm text-foreground/60">The snapshot is valid but empty. Check again after the next publication cycle.</p>
          </div>
        ) : null}

        {data !== null && data.rows.length > 0 ? (
          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
            <div className="overflow-hidden rounded-[1.25rem] border border-[#D9E3EE] bg-white shadow-[0_1px_3px_rgba(11,15,20,0.05)]">
              <div className={`${RANK_COL_CLASS} border-b border-[#D9E3EE]`}>
                <div className="px-4 py-3">
                  <p className="text-sm font-bold text-[#0B0F14]">Live published order</p>
                  <p className="mt-0.5 text-xs text-[#42576C]">Select “Why this order” to inspect the evidence.</p>
                </div>
                <RankColumnHeader label="Rank · score" sublabel={`Epoch ${data.snapshot.epoch_id}`} />
              </div>
              <PolicyWeights snapshot={data.snapshot} />
              <div className="divide-y divide-[#D9E3EE]">
                {data.rows.map((row, index) => {
                  const adjacent = {
                    above: index > 0 ? data.rows[index - 1] ?? null : null,
                    below: data.rows[index + 1] ?? null,
                  }
                  return (
                    <motion.div
                      key={row.item.post_uri}
                      layout="position"
                      transition={reduceMotion ? { duration: 0 } : { duration: 0.18, ease: "easeOut" }}
                      data-feed-row-uri={row.item.post_uri}
                      data-motion-duration={reduceMotion ? "0" : "0.18"}
                    >
                      <LiveFeedRow
                        row={row}
                        adjacent={adjacent}
                        selected={selectedRow?.item.post_uri === row.item.post_uri}
                        mobileExpanded={expandedMobileUri === row.item.post_uri}
                        onExplain={handleExplain}
                      />
                    </motion.div>
                  )
                })}
              </div>
            </div>
            <aside className="sticky top-20 hidden lg:block" aria-label="Selected post ranking explanation">
              {selectedRow !== null ? <SelectionInspector row={selectedRow} adjacent={selectedAdjacent} compact={false} /> : null}
              <p className="mt-3 px-1 text-xs leading-relaxed text-foreground/50">
                Scores explain Corgi’s published order; they are not claims about a post’s quality or truthfulness.
              </p>
            </aside>
          </div>
        ) : null}

        <section className="mt-10 grid gap-4 border-t border-border/60 pt-8 md:grid-cols-3" aria-labelledby="reading-the-order">
          <div>
            <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">How to read it</p>
            <h2 id="reading-the-order" className="mt-2 font-display text-2xl font-bold text-foreground">From policy to position</h2>
          </div>
          <p className="text-sm leading-relaxed text-foreground/60">
            Each signal’s raw value is multiplied by the active community weight. Those contributions form the base score, then any publication adjustment produces the final score.
          </p>
          <p className="text-sm leading-relaxed text-foreground/60">
            Ranked posts follow that published score order. A distinct inserted announcement is scoreless; one already in the ranked set keeps its real score and natural position. <Link href="/how-it-works" className="font-semibold text-primary underline-offset-4 hover:underline">Read the full method</Link>.
          </p>
        </section>
      </Container>
    </main>
  )
}
