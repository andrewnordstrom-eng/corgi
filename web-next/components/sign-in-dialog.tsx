"use client"

import { useEffect, useRef, useState } from "react"
import axios from "axios"
import Image from "next/image"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useAuth } from "@/components/auth-provider"
import { waitlistApi, interestApi } from "@/lib/api/client"
import { classifySignInFailure, isCurrentDialogRequest } from "@/lib/sign-in-request"

interface ContactInterestFormProps {
  onPilot: () => void
  onClose: () => void
}

function ContactInterestForm({ onPilot, onClose }: ContactInterestFormProps) {
  const [email, setEmail] = useState("")
  const [contactHandle, setContactHandle] = useState("")
  const [interests, setInterests] = useState<string[]>([])
  const [contactNote, setContactNote] = useState("")
  const [consent, setConsent] = useState(false)
  const [website, setWebsite] = useState("")
  const [state, setState] = useState<"idle" | "submitting" | "success">("idle")
  const [error, setError] = useState<string | null>(null)
  const pending = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (pending.current) return
    pending.current = true
    setState("submitting")
    setError(null)
    try {
      await interestApi.submit({ email, handle: contactHandle, interests, note: contactNote, contactConsent: consent, website })
      if (mounted.current) setState("success")
    } catch (err) {
      if (mounted.current) {
        setState("idle")
        setError(axios.isAxiosError(err) && err.response?.status === 429
          ? "Too many requests from this network. Please try again in ten minutes."
          : "We couldn't save your interest. Please try again.")
      }
    } finally {
      pending.current = false
    }
  }
  const fieldClass = "bg-background border-border rounded-xl h-11 px-4 text-sm focus-visible:ring-primary"
  return (
    <div className="max-h-[85dvh] overflow-y-auto px-6 py-8 sm:px-8">
      <DialogTitle className="font-display text-2xl font-bold tracking-tight">{state === "success" ? "Thanks for your interest." : "Stay in touch with Corgi"}</DialogTitle>
      <DialogDescription className="mt-2 text-sm leading-relaxed text-foreground/70">
        {state === "success" ? "Your interest is recorded. We may email you about the interests you selected. No account or voting access has been created."
          : "Interested in using Corgi, building with it, or research? Leave your email. A Bluesky account isn't required."}
      </DialogDescription>
      {state === "success" ? <Button onClick={onClose} className="mt-6 rounded-full">Done</Button> : (
        <form onSubmit={submit} className="mt-6 flex flex-col gap-4">
          <div className="grid gap-2"><Label htmlFor="interest-email">Email</Label><Input className={fieldClass} id="interest-email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={e => setEmail(e.target.value)} /></div>
          <div className="grid gap-2"><Label htmlFor="interest-handle">Bluesky handle <span className="font-normal text-foreground/65">(optional)</span></Label><Input className={fieldClass} id="interest-handle" placeholder="you.bsky.social" autoComplete="off" maxLength={254} value={contactHandle} onChange={e => setContactHandle(e.target.value)} /></div>
          <fieldset className="grid gap-2"><legend className="mb-2 text-sm font-medium">What interests you? Choose at least one.</legend>
            {[["use", "Using Corgi"], ["build", "Building with Corgi"], ["research", "Research collaboration"], ["updates", "Project updates"]].map(([value, label]) => (
              <label key={value} className="flex min-h-9 items-center gap-3 text-sm"><input type="checkbox" className="h-4 w-4 accent-primary" checked={interests.includes(value)} onChange={e => setInterests(previous => e.target.checked ? [...previous, value] : previous.filter(item => item !== value))} />{label}</label>
            ))}
          </fieldset>
          <div className="grid gap-2"><Label htmlFor="interest-note">What would you like to do? <span className="font-normal text-foreground/65">(optional)</span></Label><Textarea id="interest-note" maxLength={500} rows={3} value={contactNote} onChange={e => setContactNote(e.target.value)} /><p className="text-xs text-foreground/65">Up to 500 characters. Please don&rsquo;t include sensitive information.</p></div>
          <div hidden aria-hidden="true"><label htmlFor="interest-website">Website</label><input id="interest-website" name="website" tabIndex={-1} autoComplete="off" value={website} onChange={e => setWebsite(e.target.value)} /></div>
          <label className="flex items-start gap-3 text-sm leading-relaxed"><input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-primary" required checked={consent} onChange={e => setConsent(e.target.checked)} /><span>Corgi may email me about my selected interests. This is not consent to participate in research. <Link href="/privacy" className="underline underline-offset-2">Privacy policy</Link></span></label>
          {error && <p role="alert" className="text-sm text-status-error">{error}</p>}
          <Button type="submit" disabled={state === "submitting" || interests.length === 0 || !consent} className="h-11 rounded-full">{state === "submitting" ? "Saving…" : "Register interest"}</Button>
          <button type="button" onClick={onPilot} disabled={state === "submitting"} className="text-sm text-primary underline underline-offset-2">Looking for pilot voting access? Join the pilot waitlist.</button>
        </form>
      )}
    </div>
  )
}

type AccessMode = "signin" | "waitlist"

const NOTE_MAX = 500

interface SignInDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Which face the dialog opens on. Defaults to "signin" for back-compat. */
  initialMode?: AccessMode
  /**
   * When set, a successful sign-in navigates here (e.g. "/dashboard"). Omit to
   * stay in place — correct for in-task dialogs (vote/settings) where the user
   * should finish what they came to do. Waitlist submits never redirect.
   */
  redirectOnSuccess?: string
}

export function SignInDialog({ open, onOpenChange, initialMode = "signin", redirectOnSuccess }: SignInDialogProps) {
  const router = useRouter()
  const { login, cancelLogin } = useAuth()
  const [contactMode, setContactMode] = useState(true)
  const [mode, setMode] = useState<AccessMode>(initialMode)

  // Shared handle across both modes so switching carries it over.
  const [handle, setHandle] = useState("")

  // Sign-in state
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [signInLoading, setSignInLoading] = useState(false)
  const [signInError, setSignInError] = useState<string | null>(null)
  const [notApproved, setNotApproved] = useState(false)

  // Waitlist state
  const [note, setNote] = useState("")
  const [waitlistState, setWaitlistState] = useState<"idle" | "submitting" | "success" | "error">("idle")
  const [waitlistError, setWaitlistError] = useState<string | null>(null)

  const isMounted = useRef(true)
  const activeRequestToken = useRef(0)
  useEffect(() => {
    isMounted.current = true
    return () => {
      isMounted.current = false
      cancelLogin()
    }
  }, [cancelLogin])

  // Seed the mode the host asked for each time the dialog opens (the host sets
  // initialMode then opens), and reset all transient state on close so it
  // reopens clean. Deps are [open, initialMode] only, so a user's in-dialog
  // mode switch — which changes neither — is never clobbered.
  useEffect(() => {
    activeRequestToken.current += 1
    if (open) {
      setMode(initialMode)
      return
    }
    cancelLogin()
    setMode(initialMode)
    setContactMode(true)
    setHandle("")
    setPassword("")
    setShowPassword(false)
    setSignInLoading(false)
    setSignInError(null)
    setNotApproved(false)
    setNote("")
    setWaitlistState("idle")
    setWaitlistError(null)
  }, [open, initialMode, cancelLogin])

  const beginRequest = () => {
    activeRequestToken.current += 1
    return activeRequestToken.current
  }

  const isActiveRequest = (token: number) =>
    isCurrentDialogRequest(activeRequestToken.current, token, isMounted.current)

  const closeDialog = () => {
    activeRequestToken.current += 1
    cancelLogin()
    onOpenChange(false)
  }

  const goToWaitlist = () => {
    activeRequestToken.current += 1
    cancelLogin()
    setSignInLoading(false)
    setMode("waitlist")
    setContactMode(false)
    setWaitlistState("idle")
    setWaitlistError(null)
  }

  const goToSignin = () => {
    activeRequestToken.current += 1
    cancelLogin()
    setWaitlistState("idle")
    setMode("signin")
    setSignInError(null)
    setNotApproved(false)
  }

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault()
    setSignInError(null)
    setNotApproved(false)
    setSignInLoading(true)
    const requestToken = beginRequest()
    try {
      await login(handle, password)
      if (!isActiveRequest(requestToken)) return
      closeDialog()
      if (redirectOnSuccess) router.push(redirectOnSuccess)
    } catch (err) {
      if (!isActiveRequest(requestToken)) return
      const failure = classifySignInFailure(err)
      if (failure === "not-approved") {
        setNotApproved(true)
      } else if (failure === "bad-credentials") {
        setSignInError("Check your handle and app password.")
      } else {
        setSignInError("Couldn't sign in right now. Please try again.")
      }
    } finally {
      if (isActiveRequest(requestToken)) setSignInLoading(false)
    }
  }

  const handleWaitlist = async (e: React.FormEvent) => {
    e.preventDefault()
    setWaitlistError(null)
    setWaitlistState("submitting")
    const requestToken = beginRequest()
    try {
      await waitlistApi.join(handle, note)
      if (!isActiveRequest(requestToken)) return
      setWaitlistState("success")
    } catch (err) {
      if (!isActiveRequest(requestToken)) return
      setWaitlistState("error")
      if (axios.isAxiosError(err) && err.response?.status === 429) {
        setWaitlistError("Too many attempts — wait a minute and try again.")
      } else {
        setWaitlistError("Couldn't submit your request. Try again.")
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (!nextOpen) {
        activeRequestToken.current += 1
        cancelLogin()
      }
      onOpenChange(nextOpen)
    }}>
      <DialogContent className="bg-card border border-border shadow-xl rounded-2xl p-0 max-w-[440px] w-full overflow-hidden gap-0">

        {mode === "waitlist" && contactMode ? (
          <ContactInterestForm onPilot={() => setContactMode(false)} onClose={closeDialog} />
        ) : (<>
        {/* Header band */}
        <div className="px-8 pt-8 pb-6 flex flex-col items-center gap-3 border-b border-border">
          <Image src="/images/corgi-icon.svg" alt="Corgi" width={51} height={36} className="w-[51px] h-9" />
          <div className="space-y-1.5 text-center">
            <DialogTitle className="text-foreground font-display text-2xl font-bold tracking-tight leading-tight">
              {mode === "waitlist"
                ? (waitlistState === "success" ? "Request received" : "Join the Corgi waitlist")
                : "Sign in to vote"}
            </DialogTitle>
            <DialogDescription className="text-foreground/55 text-sm leading-relaxed max-w-[320px]">
              {mode === "waitlist"
                ? (waitlistState === "success"
                    ? "Your waitlist request is in."
                    : "Voting is in a limited pilot. Add your Bluesky handle and we'll get you in as we expand — the demo stays open to everyone.")
                : "Connect your Bluesky account to participate in feed governance. You'll need an app password from your Bluesky settings."}
            </DialogDescription>
          </div>
        </div>

        {mode === "waitlist" ? (
          waitlistState === "success" ? (
            /* Success replaces the form */
            <div className="px-8 py-8 flex flex-col items-center gap-3 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-success/12" aria-hidden="true">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                  <path d="M5 13l4 4L19 7" stroke="hsl(var(--status-success))" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <p className="text-foreground font-display text-xl font-bold">You&apos;re on the list.</p>
              <p className="text-foreground/60 text-sm leading-relaxed max-w-[320px]">
                We approve pilot accounts in batches. In the meantime, the demo and every transparency page are open to you now.
              </p>
              <div className="flex items-center gap-3 pt-1">
                <Link
                  href="/demo"
                  onClick={closeDialog}
                  className="text-primary text-sm font-semibold underline underline-offset-2 hover:text-primary-dark transition-colors"
                >
                  Explore the demo
                </Link>
                <span className="text-foreground/30" aria-hidden="true">·</span>
                <button
                  type="button"
                  onClick={closeDialog}
                  className="text-foreground/55 text-sm font-medium hover:text-foreground transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={handleWaitlist} className="px-8 py-6 flex flex-col gap-5">
              <div className="flex flex-col gap-2">
                <Label htmlFor="wl-handle" className="text-foreground/80 text-sm font-medium">
                  Bluesky handle
                </Label>
                <Input
                  id="wl-handle"
                  type="text"
                  placeholder="you.bsky.social"
                  value={handle}
                  onChange={(e) => setHandle(e.target.value)}
                  autoComplete="username"
                  className="bg-background border-border text-foreground placeholder:text-foreground/55 rounded-xl h-11 px-4 text-sm focus-visible:ring-primary focus-visible:ring-1 focus-visible:border-primary transition-colors"
                />
              </div>

              <div className="flex flex-col gap-2">
                <div className="flex items-baseline justify-between">
                  <Label htmlFor="wl-note" className="text-foreground/80 text-sm font-medium">
                    Anything we should know? <span className="text-foreground/45 font-normal">(optional)</span>
                  </Label>
                  <span className="text-foreground/40 text-xs font-mono">{note.length}/{NOTE_MAX}</span>
                </div>
                <Textarea
                  id="wl-note"
                  placeholder="Which community are you part of? What do you want the feed to do?"
                  value={note}
                  onChange={(e) => setNote(e.target.value.slice(0, NOTE_MAX))}
                  maxLength={NOTE_MAX}
                  rows={3}
                  className="bg-background border-border text-foreground placeholder:text-foreground/50 rounded-xl px-4 py-3 text-sm resize-none focus-visible:ring-primary focus-visible:ring-1 focus-visible:border-primary transition-colors"
                />
              </div>

              {waitlistState === "error" && waitlistError && (
                <p role="alert" className="text-status-error text-sm font-medium leading-relaxed -mt-1">
                  {waitlistError}
                </p>
              )}

              <Button
                type="submit"
                disabled={waitlistState === "submitting" || !handle.trim()}
                className="w-full h-11 bg-primary text-primary-foreground hover:bg-primary-dark rounded-xl font-semibold text-sm transition-colors shadow-sm disabled:opacity-50 mt-1"
              >
                {waitlistState === "submitting" ? "Submitting..." : "Join the waitlist"}
              </Button>

              <p className="text-center text-foreground/55 text-xs leading-relaxed">
                Already approved?{" "}
                <button type="button" onClick={goToSignin} className="text-primary font-medium underline underline-offset-2 hover:text-primary-dark transition-colors">
                  Sign in
                </button>
              </p>
            </form>
          )
        ) : (
          /* ── Sign-in mode ────────────────────────────────── */
          <form onSubmit={handleSignIn} className="px-8 py-6 flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <Label htmlFor="handle" className="text-foreground/80 text-sm font-medium">
                Bluesky handle
              </Label>
              <Input
                id="handle"
                type="text"
                placeholder="you.bsky.social"
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                autoComplete="username"
                className="bg-background border-border text-foreground placeholder:text-foreground/55 rounded-xl h-11 px-4 text-sm focus-visible:ring-primary focus-visible:ring-1 focus-visible:border-primary transition-colors"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="password" className="text-foreground/80 text-sm font-medium">
                App password
              </Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  placeholder="xxxx-xxxx-xxxx-xxxx"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  className="bg-background border-border text-foreground placeholder:text-foreground/55 rounded-xl h-11 px-4 pr-12 text-sm focus-visible:ring-primary focus-visible:ring-1 focus-visible:border-primary transition-colors"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-foreground/50 hover:text-foreground/70 transition-colors text-xs font-medium"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? "hide" : "show"}
                </button>
              </div>
              <p className="text-foreground/55 text-xs leading-relaxed">
                Create an app password in{" "}
                <a href="https://bsky.app/settings/app-passwords" target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2 hover:text-primary-dark transition-colors">
                  Bluesky Settings
                </a>
                . It looks like <span className="font-mono text-foreground/60">xxxx-xxxx-xxxx-xxxx</span>.
              </p>
            </div>

            {notApproved && (
              <div role="alert" className="rounded-xl bg-primary/[0.06] border border-primary/20 px-4 py-3 flex flex-col gap-1.5 -mt-1">
                <p className="text-foreground/85 text-sm font-semibold">Your account isn&apos;t approved yet.</p>
                <p className="text-foreground/60 text-xs leading-relaxed">
                  Corgi voting is in a limited pilot. Join the waitlist and we&apos;ll get you in as we expand.
                </p>
                <button
                  type="button"
                  onClick={goToWaitlist}
                  className="self-start mt-1 text-primary text-sm font-semibold underline underline-offset-2 hover:text-primary-dark transition-colors"
                >
                  Join the waitlist
                </button>
              </div>
            )}

            {signInError && (
              <p role="alert" className="text-status-error text-sm font-medium leading-relaxed -mt-1">
                {signInError}
              </p>
            )}

            <Button
              type="submit"
              disabled={signInLoading || !handle || !password}
              className="w-full h-11 bg-primary text-primary-foreground hover:bg-primary-dark rounded-xl font-semibold text-sm transition-colors shadow-sm disabled:opacity-50 mt-1"
            >
              {signInLoading ? "Signing in..." : "Sign in"}
            </Button>

            <p className="text-center text-foreground/55 text-xs leading-relaxed">
              Not approved yet?{" "}
              <button type="button" onClick={goToWaitlist} className="text-primary font-medium underline underline-offset-2 hover:text-primary-dark transition-colors">
                Join the waitlist
              </button>
            </p>

            <p className="text-center text-foreground/50 text-xs leading-relaxed">
              By signing in, you agree to our{" "}
              <Link href="/tos" className="text-foreground/60 underline underline-offset-2 hover:text-foreground transition-colors">
                Terms of Service
              </Link>{" "}
              and{" "}
              <Link href="/privacy" className="text-foreground/60 underline underline-offset-2 hover:text-foreground transition-colors">
                Privacy Policy
              </Link>
              .
            </p>
          </form>
        )}

        </>)}
      </DialogContent>
    </Dialog>
  )
}
