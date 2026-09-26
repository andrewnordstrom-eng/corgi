"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { AnimatePresence, motion, useReducedMotion } from "framer-motion"
import { AlertCircle, FileSearch, ListOrdered, RotateCcw } from "lucide-react"
import { Header } from "@/components/header"
import { FooterSection } from "@/components/footer-section"
import { Container } from "@/components/ui/layout"
import { PageHero, HeroGlow, HERO_TOP } from "@/components/ui/page-hero"
import { CommunityPicker } from "@/components/demo/community-picker"
import { CorpusFeed } from "@/components/demo/corpus-feed"
import { VotePanel } from "@/components/demo/vote-panel"
import { AgentsPanel } from "@/components/demo/agents-panel"
import { ReceiptPanel } from "@/components/demo/receipt-panel"
import { FlowProgress } from "@/components/demo/flow-progress"
import { DemoDisclosure } from "@/components/demo/demo-disclosure"
import {
  LiveProofPanel,
  getDegradedCorpusWarning,
  getDemoCorpusPresentation,
  getReceiptSelectionAnnouncement,
} from "@/components/demo/live-proof-panel"
import { getDemoClient } from "./demo-client"
import { ShadowDemoHttpError } from "./http-shadow-demo-client"
import { DemoResumeHintError, readDemoResume, writeDemoResume } from "./demo-session-resume"
import type { DemoSessionResume } from "./demo-session-resume"
import { DemoRequestCoordinator } from "./demo-request-coordinator"
import type { DemoRequestContext } from "./demo-request-coordinator"
import { HERO, LABELS, STEP_PANELS } from "./shadow-demo-copy"
import type {
  ShadowDemoAgent,
  ShadowDemoAggregate,
  ShadowDemoCommunity,
  ShadowDemoCommunityId,
  ShadowDemoEpoch,
  ShadowDemoFeed,
  ShadowDemoPublicFeedItem,
  ShadowDemoReceipt,
  ShadowDemoSession,
  ShadowDemoTopicIntent,
  ShadowDemoVote,
  ShadowDemoWarning,
  ShadowDemoWeights,
} from "./shadow-demo-view-model"

function uid(): string {
  const secureCrypto: Crypto | undefined = typeof globalThis.crypto === "undefined" ? undefined : globalThis.crypto
  if (secureCrypto === undefined) {
    throw new Error("Secure randomness is unavailable in this browser.")
  }
  if (typeof secureCrypto.randomUUID === "function") {
    return secureCrypto.randomUUID()
  }
  const bytes = new Uint8Array(16)
  secureCrypto.getRandomValues(bytes)
  return `id-${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`
}

function stepIndex(phase: ShadowDemoSession["phase"] | null, hasReceipt: boolean): number {
  switch (phase) {
    case "corpus_ready":
      return 1
    case "reviewer_vote_cast":
      return 2
    case "agent_votes_cast":
      return 3
    case "epoch_transitioned":
    case "reranked":
      // Once a receipt is open the walkthrough is complete — index past the last
      // step so the "Receipt" circle fills in (done) instead of sitting as a
      // hollow ring that reads as unfinished.
      return hasReceipt ? 6 : 4
    default:
      return 0
  }
}

export default function DemoPage() {
  const [session, setSession] = useState<ShadowDemoSession | null>(null)
  const [community, setCommunity] = useState<ShadowDemoCommunity | null>(null)
  const [openEpochId, setOpenEpochId] = useState<string | null>(null)
  const [publishedEpoch, setPublishedEpoch] = useState<ShadowDemoEpoch | null>(null)
  const [baselineFeed, setBaselineFeed] = useState<ShadowDemoFeed | null>(null)
  const [feedAfter, setFeedAfter] = useState<ShadowDemoFeed | null>(null)
  const [agents, setAgents] = useState<readonly ShadowDemoAgent[]>([])
  const [agentVotes, setAgentVotes] = useState<readonly ShadowDemoVote[]>([])
  const [pendingAggregate, setPendingAggregate] = useState<ShadowDemoAggregate | null>(null)
  const [selectedUri, setSelectedUri] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<ShadowDemoReceipt | null>(null)
  const [mobileView, setMobileView] = useState<"feed" | "receipt">("feed")
  const [sessionWarnings, setSessionWarnings] = useState<readonly ShadowDemoWarning[]>([])
  const [receiptFocusRequest, setReceiptFocusRequest] = useState(0)
  const [receiptAnnouncement, setReceiptAnnouncement] = useState("")
  const [freePlayEnabled, setFreePlayEnabled] = useState(false)
  const [startingNextEpoch, setStartingNextEpoch] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestCoordinator = useRef(new DemoRequestCoordinator())
  const panelRef = useRef<HTMLDivElement>(null)
  const resumeHint = useRef<DemoSessionResume | null>(null)
  const [resumeSessionId, setResumeSessionId] = useState<string | null>(null)
  const [storageWarning, setStorageWarning] = useState<string | null>(null)

  const client = getDemoClient()
  const reduceMotion = useReducedMotion() ?? false
  const phase = startingNextEpoch ? "corpus_ready" : (session?.phase ?? null)
  const feed = feedAfter ?? baselineFeed
  const reranked = phase === "reranked" || phase === "epoch_transitioned"
  const corpusPresentation = feed === null ? null : getDemoCorpusPresentation(feed)
  const usesMechanicsFixture = corpusPresentation?.usesMechanicsFixture ?? false

  const persistResume = useCallback((hint: DemoSessionResume | null): void => {
    resumeHint.current = hint
    try {
      writeDemoResume(window.sessionStorage, hint)
      setStorageWarning(null)
    } catch {
      setStorageWarning("This browser could not save demo continuation. Keep this tab open; reload may require a new session.")
    }
  }, [])

  const resetSessionState = useCallback((): void => {
    setSession(null)
    setCommunity(null)
    setOpenEpochId(null)
    setPublishedEpoch(null)
    setBaselineFeed(null)
    setFeedAfter(null)
    setAgents([])
    setAgentVotes([])
    setPendingAggregate(null)
    setSelectedUri(null)
    setReceipt(null)
    setMobileView("feed")
    setStartingNextEpoch(false)
    setFreePlayEnabled(false)
    setSessionWarnings([])
    setReceiptAnnouncement("")
  }, [])

  const recoverSession = useCallback(async (sessionId: string, request: DemoRequestContext): Promise<void> => {
    let response
    try {
      response = await client.getSession(sessionId, request.signal)
    } catch (cause) {
      if (request.isCurrent() && cause instanceof ShadowDemoHttpError && (cause.status === 404 || cause.status === 410)) {
        if (resumeHint.current?.sessionId === sessionId) persistResume(null)
        resetSessionState()
        setResumeSessionId(null)
        throw new DemoResumeHintError("Your demo session has expired or is no longer available. Start a new session.")
      }
      throw cause
    }
    if (!request.isCurrent()) return
    const { payload } = response
    if (Date.parse(payload.session.expiresAt) <= Date.now()) {
      if (resumeHint.current?.sessionId === sessionId) persistResume(null)
      resetSessionState()
      setResumeSessionId(null)
      throw new DemoResumeHintError("Your demo session has expired. Start a new session.")
    }
    const saved = resumeHint.current?.sessionId === sessionId ? resumeHint.current : null
    const published = payload.session.phase === "reranked" || payload.session.phase === "epoch_transitioned"
    const nextRound = published && saved?.nextEpochId === payload.currentEpoch.id
    resetSessionState()
    setSessionWarnings(response.warnings)
    setSession(payload.session)
    setCommunity(payload.community)
    setOpenEpochId(payload.currentEpoch.id)
    setStartingNextEpoch(nextRound)
    setFreePlayEnabled(payload.currentEpoch.sequence > payload.session.guidedEpochs || (nextRound && payload.currentEpoch.sequence >= payload.session.guidedEpochs))
    if (published && !nextRound) {
      setFeedAfter(payload.feed)
      setPublishedEpoch(payload.currentEpoch)
    } else {
      setBaselineFeed(payload.feed)
    }
    if (!nextRound) {
      setAgents(payload.agents)
      setAgentVotes(payload.agentVotes)
      setPendingAggregate(payload.pendingAggregate)
    }
    const selected = published && !nextRound && saved?.selection?.epochId === payload.currentEpoch.id
      ? payload.feed.items.find((item): item is ShadowDemoPublicFeedItem => item.visibility === "public" && item.post.uri === saved.selection?.postUri)
      : undefined
    const hint: DemoSessionResume = {
      version: 1, sessionId, expiresAt: payload.session.expiresAt,
      selection: selected ? { postUri: selected.post.uri, epochId: payload.currentEpoch.id } : null,
      nextEpochId: nextRound ? payload.currentEpoch.id : null,
      mobileView: saved?.mobileView ?? "feed",
    }
    persistResume(hint)
    setMobileView(hint.mobileView)
    setResumeSessionId(null)
    if (saved?.selection !== null && saved?.selection !== undefined && selected === undefined && !nextRound) {
      setError("The saved receipt selection is no longer in this epoch. Select a visible post to inspect its receipt.")
    }
    if (selected) {
      setSelectedUri(selected.post.uri)
      setReceiptAnnouncement(getReceiptSelectionAnnouncement(selected.rank, false))
      setReceiptFocusRequest((current) => current + 1)
      try {
        const result = await client.getReceipt(sessionId, { epochId: payload.currentEpoch.id, postUri: selected.post.uri }, request.signal)
        if (!request.isCurrent()) return
        const restored = result.payload.receipt
        if (restored.postUri !== selected.post.uri || restored.epochId !== payload.currentEpoch.id
          || restored.visibleRank !== selected.rank || Math.abs(restored.totalScore - selected.score.total) > 1e-9) {
          throw new Error("Corgi refused a receipt that did not match the restored post, epoch, rank and score.")
        }
        setReceipt(restored)
        setReceiptAnnouncement(getReceiptSelectionAnnouncement(selected.rank, true))
      } catch (cause) {
        if (request.isCurrent()) {
          setSelectedUri(null)
          setReceipt(null)
          setReceiptAnnouncement("")
          setMobileView("feed")
          persistResume({ ...hint, selection: null, mobileView: "feed" })
        }
        throw cause
      }
    }
  }, [client, persistResume, resetSessionState])

  const retryResume = useCallback(async (sessionId: string): Promise<void> => {
    const request = requestCoordinator.current.start()
    setBusy(true)
    setError(null)
    setResumeSessionId(sessionId)
    try {
      await recoverSession(sessionId, request)
    } catch (cause) {
      if (request.isCurrent()) setError(cause instanceof Error ? cause.message : "Demo recovery failed. Retry or start a new session.")
    } finally {
      if (request.isCurrent()) setBusy(false)
    }
  }, [recoverSession])

  useEffect(() => {
    const coordinator = requestCoordinator.current
    try {
      const hint = readDemoResume(window.sessionStorage, Date.now())
      resumeHint.current = hint
      if (hint !== null) {
        setResumeSessionId(hint.sessionId)
        const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined
        if (navigation?.type === "reload" || navigation?.type === "back_forward") {
          void retryResume(hint.sessionId)
        }
      }
    } catch (cause) {
      if (cause instanceof DemoResumeHintError) {
        persistResume(null)
        setError(cause.message)
      } else {
        setStorageWarning("This browser could not read saved demo continuation. You can start a new session, but reload recovery may be unavailable.")
      }
    }
    return () => coordinator.cancel()
  }, [persistResume, retryResume])

  useEffect(() => {
    const panel = panelRef.current
    if (session === null || panel === null) return

    panel.focus({ preventScroll: true })
    panel.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "start",
    })
  }, [phase, reduceMotion, session])

  useEffect(() => {
    if (!reranked || mobileView !== "receipt" || selectedUri === null || receiptFocusRequest === 0) return
    const frame = window.requestAnimationFrame(() => {
      const panel = panelRef.current
      if (panel === null) return
      panel.focus({ preventScroll: true })
      panel.scrollIntoView({
        behavior: reduceMotion ? "auto" : "smooth",
        block: "start",
      })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [mobileView, receiptFocusRequest, reduceMotion, reranked, selectedUri])

  async function run(
    action: (request: DemoRequestContext) => Promise<void>,
    recoverSessionId: string | null,
  ): Promise<void> {
    const request = requestCoordinator.current.start()
    setBusy(true)
    setError(null)
    try {
      await action(request)
    } catch (cause) {
      if (request.isCurrent()) {
        const failureMessage = cause instanceof Error ? cause.message : "Something went wrong in the demo."
        if (recoverSessionId !== null) {
          try {
            setResumeSessionId(recoverSessionId)
            await recoverSession(recoverSessionId, request)
            if (request.isCurrent()) {
              setError(`${failureMessage} Corgi refreshed the authoritative session state before you continue.`)
            }
          } catch (recoveryFailure) {
            if (request.isCurrent()) {
              setError(recoveryFailure instanceof Error ? recoveryFailure.message : failureMessage)
            }
          }
        } else {
          setError(failureMessage)
        }
      }
    } finally {
      if (request.isCurrent()) {
        setBusy(false)
      }
    }
  }


  function clearRoundState(): void {
    setFeedAfter(null)
    setAgents([])
    setAgentVotes([])
    setPendingAggregate(null)
    setSelectedUri(null)
    setReceipt(null)
    setMobileView("feed")
  }

  function handleStart(communityId: ShadowDemoCommunityId): void {
    persistResume(null)
    setResumeSessionId(null)
    void run(async (request) => {
      const response = await client.createSession(
        { communityId, scenarioId: "guided_default", clientNonce: uid(), mode: "guided" },
        request.signal,
      )
      if (!request.isCurrent()) {
        return
      }
      const { payload } = response
      setSessionWarnings(response.warnings)
      setSession(payload.session)
      setCommunity(payload.community)
      setOpenEpochId(payload.currentEpoch.id)
      setBaselineFeed(payload.feed)
      setStartingNextEpoch(false)
      clearRoundState()
      setPublishedEpoch(null)
      setFreePlayEnabled(false)
      persistResume({ version: 1, sessionId: payload.session.id, expiresAt: payload.session.expiresAt, selection: null, nextEpochId: null, mobileView: "feed" })
    }, null)
  }

  function handleVote(weights: ShadowDemoWeights, topicIntent: ShadowDemoTopicIntent, excludeKeywords: readonly string[]): void {
    if (session === null || openEpochId === null) {
      return
    }
    void run(async (request) => {
      const response = await client.castVote(
        session.id,
        {
          idempotencyKey: `${session.id}:${openEpochId}:vote`,
          baseEpochId: openEpochId,
          voterLabel: LABELS.reviewerVoter,
          weights,
          topicIntent,
          ...(session.contentRulesEnabled === true && excludeKeywords.length > 0 ? { excludeKeywords } : {}),
        },
        request.signal,
      )
      if (!request.isCurrent()) {
        return
      }
      const { payload } = response
      setSessionWarnings(response.warnings)
      setSession(payload.session)
      setStartingNextEpoch(false)
      if (resumeHint.current?.sessionId === session.id) persistResume({ ...resumeHint.current, nextEpochId: null, selection: null })
    }, session.id)
  }

  function handleRunAgents(): void {
    if (session === null || openEpochId === null) {
      return
    }
    void run(async (request) => {
      const response = await client.runAgents(
        session.id,
        { idempotencyKey: `${session.id}:${openEpochId}:voters`, baseEpochId: openEpochId },
        request.signal,
      )
      if (!request.isCurrent()) {
        return
      }
      const { payload } = response
      setSessionWarnings(response.warnings)
      setAgents(payload.agents)
      setAgentVotes(payload.agentVotes)
      setPendingAggregate(payload.pendingAggregate)
      setSession(payload.session)
    }, session.id)
  }

  function handleAdvance(): void {
    if (session === null || openEpochId === null) {
      return
    }
    void run(async (request) => {
      const response = await client.advanceEpoch(
        session.id,
        { idempotencyKey: `${session.id}:${openEpochId}:advance`, fromEpochId: openEpochId },
        request.signal,
      )
      if (!request.isCurrent()) {
        return
      }
      const { payload } = response
      setSessionWarnings(response.warnings)
      setFeedAfter(payload.feedAfter)
      setPublishedEpoch(payload.currentEpoch)
      setOpenEpochId(payload.currentEpoch.id)
      setSession(payload.session)
      setSelectedUri(null)
      setReceipt(null)
      const top = payload.feedAfter.items.find((item): item is ShadowDemoPublicFeedItem => item.visibility === "public")
      if (top) {
        await loadReceipt(session.id, payload.currentEpoch.id, top.post.uri, request)
      }
    }, session.id)
  }

  async function loadReceipt(
    sessionId: string,
    epochId: string,
    postUri: string,
    request: DemoRequestContext,
  ): Promise<void> {
    const selectedRank = feed?.items.find(
      (item): item is ShadowDemoPublicFeedItem => item.visibility === "public" && item.post.uri === postUri,
    )?.rank ?? null
    if (resumeHint.current?.sessionId === sessionId) {
      persistResume({ ...resumeHint.current, selection: { postUri, epochId }, nextEpochId: null, mobileView: "receipt" })
    }
    setSelectedUri(postUri)
    setReceipt(null)
    setMobileView("receipt")
    setReceiptAnnouncement(getReceiptSelectionAnnouncement(selectedRank, false))
    setReceiptFocusRequest((current) => current + 1)
    const response = await client.getReceipt(sessionId, { epochId, postUri }, request.signal)
    if (!request.isCurrent()) {
      return
    }
    const { payload } = response
    setSessionWarnings(response.warnings)
    if (payload.receipt.postUri !== postUri || payload.receipt.epochId !== epochId) {
      throw new Error("Corgi refused a receipt that did not match the selected post and epoch.")
    }
    setReceipt(payload.receipt)
    setReceiptAnnouncement(getReceiptSelectionAnnouncement(selectedRank, true))
  }

  function handleSelect(postUri: string): void {
    if (!reranked || session === null || publishedEpoch === null) {
      return
    }
    void run((request) => loadReceipt(session.id, publishedEpoch.id, postUri, request), null)
  }

  function handleReset(): void {
    requestCoordinator.current.cancel()
    persistResume(null)
    setResumeSessionId(null)
    resetSessionState()
    setBusy(false)
    setError(null)
  }

  function changeMobileView(view: "feed" | "receipt"): void {
    setMobileView(view)
    if (resumeHint.current !== null) persistResume({ ...resumeHint.current, mobileView: view })
  }

  function handleAnotherEpoch(): void {
    if (session === null || feedAfter === null || publishedEpoch === null) {
      return
    }
    setStartingNextEpoch(true)
    if (publishedEpoch.sequence >= session.guidedEpochs) {
      setFreePlayEnabled(true)
    }
    setBaselineFeed(feedAfter)
    clearRoundState()
    if (resumeHint.current?.sessionId === session.id) {
      persistResume({ ...resumeHint.current, nextEpochId: publishedEpoch.id, selection: null, mobileView: "feed" })
    }
  }

  const selectedItem =
    feed?.items.find(
      (item): item is ShadowDemoPublicFeedItem => item.visibility === "public" && item.post.uri === selectedUri,
    ) ?? null
  const baselineTopicIntent = baselineFeed?.aggregate.topicIntent ?? { topicWeights: {} }
  const topicCatalog = session?.topicCatalog ?? []
  const withheldCount = feedAfter?.withheldPosts?.length ?? 0
  const baselineTopicSlugs = Object.keys(baselineTopicIntent.topicWeights)
  const topicCatalogComplete = topicCatalog.length === 26
    && new Set(topicCatalog.map((topic) => topic.slug)).size === 26
    && baselineTopicSlugs.length === 26
    && baselineTopicSlugs.every((slug) => topicCatalog.some((topic) => topic.slug === slug))

  // Which step panel the right column shows — also the AnimatePresence key, so
  // advancing fades one panel out and the next in (agents phase stays one key so
  // running votes doesn't re-trigger the entrance).
  const panelKey =
    phase === "corpus_ready"
      ? "vote"
      : phase === "reviewer_vote_cast" || phase === "agent_votes_cast"
        ? "agents"
        : reranked
          ? "receipt"
          : "none"

  const rightPanel =
    phase === "corpus_ready" && !topicCatalogComplete ? (
      <div role="alert" className="rounded-[1.5rem] border border-destructive/30 bg-destructive/5 px-5 py-6">
        <h2 className="font-display text-xl font-bold text-foreground">Policy controls unavailable</h2>
        <p className="mt-2 text-sm leading-relaxed text-foreground/65">
          Corgi could not verify the complete frozen 26-topic policy. Start a new session after the snapshot is repaired.
        </p>
      </div>
    ) : phase === "corpus_ready" ? (
      <VotePanel
        onSubmit={handleVote}
        busy={busy || resumeSessionId !== null}
        topicCatalog={topicCatalog}
        baselineTopicIntent={baselineTopicIntent}
        contentRulesEnabled={session?.contentRulesEnabled === true}
        suggestedExcludeKeywords={session?.suggestedExcludeKeywords ?? []}
        contentRules={baselineFeed?.aggregate.voteSummary.contentRules ?? null}
      />
    ) : phase === "reviewer_vote_cast" || phase === "agent_votes_cast" ? (
      <AgentsPanel
        agents={agents}
        agentVotes={agentVotes}
        aggregate={pendingAggregate}
        onRun={handleRunAgents}
        onAdvance={handleAdvance}
        busy={busy || resumeSessionId !== null}
        topicCatalog={topicCatalog}
        baselineTopicIntent={baselineTopicIntent}
      />
    ) : reranked ? (
      receipt !== null && selectedItem !== null && publishedEpoch !== null && session !== null ? (
        <ReceiptPanel
          receipt={receipt}
          authorDisplayName={selectedItem.post.authorDisplayName}
          postText={selectedItem.post.text}
          bskyUrl={selectedItem.post.bskyUrl}
          onAnotherEpoch={publishedEpoch.sequence < session.maxEpochs ? handleAnotherEpoch : null}
          onRestart={handleReset}
          currentEpoch={publishedEpoch.sequence}
          guidedEpochs={session.guidedEpochs}
          maxEpochs={session.maxEpochs}
          freePlayEnabled={freePlayEnabled}
        />
      ) : (
        <div className="rounded-[1.5rem] border border-border bg-card px-5 py-6">
          <h2 className="font-display text-xl font-bold text-foreground">{STEP_PANELS.reorder.heading}</h2>
          <p className="mt-2 text-sm leading-relaxed text-foreground/60">
            {selectedUri !== null && busy
              ? "Loading the matching post receipt…"
              : withheldCount > 0
                ? `The corpus is unchanged, but adopted community rules withheld ${withheldCount} post${withheldCount === 1 ? "" : "s"} and the remaining weights reordered the rest.`
                : STEP_PANELS.reorder.body}
          </p>
        </div>
      )
    ) : null

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <Header />
      <Container as="main" width="stage" className={`relative flex-1 pb-10 ${HERO_TOP}`}>
        <HeroGlow />
        <PageHero size="md" align="left" eyebrow={HERO.eyebrow} title={HERO.title} subtitle={HERO.subtitle} className="relative max-w-3xl" />

        <div className="mt-7 flex flex-col gap-3 border-y border-border/60 py-4">
          <FlowProgress currentIndex={stepIndex(phase, receipt !== null)} />
          {session !== null ? (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleReset}
                className="inline-flex w-fit items-center gap-1.5 rounded-full border border-border bg-background px-3.5 py-1.5 text-xs font-semibold text-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                {LABELS.reset}
              </button>
            </div>
          ) : null}
        </div>

        {storageWarning !== null ? <p role="status" className="mt-5 text-sm text-foreground/70">{storageWarning}</p> : null}
        {resumeSessionId !== null ? (
          <div role="status" className="mt-5 flex flex-wrap items-center gap-3 rounded-2xl border border-border px-4 py-3 text-sm">
            <span>{busy ? "Restoring your demo from the server…" : "A demo session can be restored. No votes or epoch changes will be repeated."}</span>
            <button type="button" disabled={busy} onClick={() => void retryResume(resumeSessionId)} className="rounded-full border border-border px-3 py-2 font-semibold">Restore demo session</button>
            <button type="button" onClick={handleReset} className="rounded-full border border-border px-3 py-2 font-semibold">Start a new session</button>
          </div>
        ) : null}
        {error !== null ? (
          <div role="alert" className="mt-5 flex items-start gap-2 rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </div>
        ) : null}

        <p className="sr-only" aria-live="polite">
          {busy ? "Updating the shadow demo." : session === null ? "Start a Corgi Commons demo session." : `Demo phase: ${phase}.`}
        </p>
        <p className="sr-only" aria-live="polite" aria-atomic="true">
          {receiptAnnouncement}
        </p>

        <div className="mt-7">
          <AnimatePresence mode="wait" initial={false}>
            {session === null || feed === null || community === null ? (
              <motion.div
                key="picker"
                initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
                transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
              >
                <CommunityPicker onStart={handleStart} busy={busy || resumeSessionId !== null} />
              </motion.div>
            ) : (
              <motion.div
                key="workbench"
                initial={reduceMotion ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3, ease: "easeOut" }}
                className="grid gap-6 xl:grid-cols-[minmax(0,1.05fr)_minmax(360px,0.85fr)]"
              >
                {reranked ? (
                  <div className="order-1 grid grid-cols-2 rounded-lg border border-border bg-biscuit/25 p-1 xl:hidden">
                    <button
                      type="button"
                      onClick={() => changeMobileView("feed")}
                      aria-pressed={mobileView === "feed"}
                      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-md px-3 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${mobileView === "feed" ? "bg-background text-foreground shadow-sm" : "text-foreground/60"}`}
                    >
                      <ListOrdered className="h-4 w-4" aria-hidden="true" />
                      Ranked feed
                    </button>
                    <button
                      type="button"
                      onClick={() => changeMobileView("receipt")}
                      aria-pressed={mobileView === "receipt"}
                      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-md px-3 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${mobileView === "receipt" ? "bg-background text-foreground shadow-sm" : "text-foreground/60"}`}
                    >
                      <FileSearch className="h-4 w-4" aria-hidden="true" />
                      Receipt
                    </button>
                  </div>
                ) : null}

                <div className={`order-2 flex flex-col gap-3 xl:order-1 ${reranked && mobileView === "receipt" ? "hidden xl:flex" : ""}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h2 className="text-lg font-bold text-foreground">Corgi Commons</h2>
                      <p className="text-xs text-foreground/55">
                        {corpusPresentation?.provenanceLine}
                      </p>
                      <p className="mt-1 text-[11px] font-medium text-primary/75">Shadow session · never changes the public feed</p>
                    </div>
                    <p className="text-[11px] font-mono text-foreground/55">
                      {corpusPresentation?.metricsLine}
                    </p>
                  </div>
                  {usesMechanicsFixture ? (
                    <div role="status" className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs leading-relaxed text-foreground/70">
                      <span className="font-semibold text-foreground">Mechanics fixture:</span>{" "}
                      {getDegradedCorpusWarning(sessionWarnings)}
                    </div>
                  ) : null}
                  <CorpusFeed
                    feed={feed}
                    communityName="Corgi Commons"
                    epochLabel={publishedEpoch ? `Epoch ${publishedEpoch.sequence}` : "Baseline"}
                    selectedUri={selectedUri}
                    onSelect={handleSelect}
                    showMovement={reranked}
                    selectable={reranked}
                  />
                </div>

                {/* Grid item stretches to the feed's height; the inner wrapper
                    sticks, so the short vote/agents panels follow the scroll
                    instead of stranding a void beside the tall feed. */}
                <div className={`order-1 xl:order-2 ${reranked && mobileView === "feed" ? "hidden xl:block" : ""}`}>
                  <div ref={panelRef} tabIndex={-1} aria-label={reranked ? "Ranking receipt" : undefined} className="scroll-mt-20 focus:outline-none xl:sticky xl:top-24">
                    <AnimatePresence mode="wait" initial={false}>
                      <motion.div
                        key={panelKey}
                        initial={reduceMotion ? false : { opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -10 }}
                        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                      >
                        {rightPanel}
                      </motion.div>
                    </AnimatePresence>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <LiveProofPanel provenance={session?.corpusProvenance ?? null} usesMechanicsFixture={usesMechanicsFixture} />
        <DemoDisclosure />
      </Container>
      <FooterSection />
    </div>
  )
}
