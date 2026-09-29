"use client"

import { useState } from "react"
import Link from "next/link"
import { Header } from "@/components/header"
import { FooterSection } from "@/components/footer-section"
import { SignInDialog } from "@/components/sign-in-dialog"
import { Button } from "@/components/ui/button"

const reassurances = [
  {
    title: "Never your main password",
    body: "Corgi uses a Bluesky app password — a scoped credential you generate in Bluesky. Your real password never touches Corgi.",
  },
  {
    title: "Revoke anytime",
    body: "Remove the app password from your Bluesky settings and Corgi immediately loses access. No account deletion required.",
  },
  {
    title: "Read-only until you act",
    body: "You can explore the demo and inspect every receipt without signing in. Connect only when you want to vote.",
  },
]

export default function SignInPage() {
  const [open, setOpen] = useState(false)
  const [dialogMode, setDialogMode] = useState<"signin" | "waitlist">("waitlist")
  const openDialog = (mode: "signin" | "waitlist") => {
    setDialogMode(mode)
    setOpen(true)
  }

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Header />
      <main className="flex-1 flex items-center justify-center px-5 py-16 md:py-24">
        <div className="w-full max-w-xl text-center">
          <p className="text-[11px] font-mono uppercase tracking-[0.22em] text-foreground/55">Access</p>
          <h1 className="mt-3 font-display text-3xl md:text-4xl font-bold tracking-tight text-foreground leading-tight text-balance">
            Stay in touch with Corgi.
          </h1>
          <p className="mx-auto mt-4 max-w-md text-base leading-relaxed text-foreground/60">
            Leave your email if you&rsquo;re interested in using Corgi, building with it, or research collaboration.
            A Bluesky handle is optional. Pilot voting access is separate; the demo is open without an account.
          </p>

          <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
            <Button
              onClick={() => openDialog("waitlist")}
              className="bg-primary text-primary-foreground hover:bg-primary-dark rounded-full px-7 py-3 text-base font-medium shadow-[0_2px_8px_rgba(200,97,44,0.3)] transition-all focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              Register interest
            </Button>
            <button
              onClick={() => openDialog("signin")}
              className="rounded-full px-5 py-3 text-base font-medium text-foreground/70 hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              Already approved? Sign in
            </button>
          </div>

          <div className="mt-12 grid gap-3 text-left sm:grid-cols-3">
            {reassurances.map((item) => (
              <div key={item.title} className="rounded-2xl border border-border bg-card p-4 shadow-[0_2px_10px_rgba(46,38,32,0.05)]">
                <p className="text-sm font-semibold text-foreground">{item.title}</p>
                <p className="mt-1.5 text-xs leading-relaxed text-foreground/60">{item.body}</p>
              </div>
            ))}
          </div>

          <p className="mt-8 text-xs text-foreground/50">
            New to Corgi?{" "}
            <Link href="/start" className="text-primary hover:underline underline-offset-2">
              See how to add the feed in Bluesky
            </Link>
            .
          </p>
        </div>
      </main>
      <FooterSection />
      <SignInDialog open={open} onOpenChange={setOpen} initialMode={dialogMode} redirectOnSuccess="/dashboard" />
    </div>
  )
}
