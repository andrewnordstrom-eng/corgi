"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { createPortal } from "react-dom"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { BrandLink } from "@/components/brand-link"
import { Button } from "@/components/ui/button"
import { SignInDialog } from "./sign-in-dialog"
import { cn } from "@/lib/utils"
import { CONTAINER_WIDTH, GUTTER } from "@/components/ui/layout"

// Shared keyboard focus ring for nav links/buttons (raw Link/button don't get one).
const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"

function isNavItemActive(pathname: string, href: string): boolean {
  return href !== "/#faq-section" && (pathname === href || pathname.startsWith(`${href}/`))
}

function useScroll(threshold: number) {
  const [scrolled, setScrolled] = useState(false)
  const onScroll = useCallback(() => {
    setScrolled(window.scrollY > threshold)
  }, [threshold])
  useEffect(() => {
    window.addEventListener("scroll", onScroll, { passive: true })
    onScroll()
    return () => window.removeEventListener("scroll", onScroll)
  }, [onScroll])
  return scrolled
}

function AnimatedMenuIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn("transition-transform duration-300 ease-in-out", open && "-rotate-45")}
    >
      <path
        className={cn(
          "transition-all duration-300 ease-in-out",
          open
            ? "[stroke-dasharray:20_300] [stroke-dashoffset:-32.42px]"
            : "[stroke-dasharray:12_63]"
        )}
        d="M27 10 13 10C10.8 10 9 8.2 9 6 9 3.5 10.8 2 13 2 15.2 2 17 3.8 17 6L17 26C17 28.2 18.8 30 21 30 23.2 30 25 28.2 25 26 25 23.8 23.2 22 21 22L7 22"
      />
      <path d="M7 16 27 16" />
    </svg>
  )
}

export function Header() {
  const pathname = usePathname()
  const [signInOpen, setSignInOpen] = useState(false)
  const [dialogMode, setDialogMode] = useState<"signin" | "waitlist">("signin")
  const openDialog = (mode: "signin" | "waitlist") => {
    setDialogMode(mode)
    setSignInOpen(true)
  }
  const [mobileOpen, setMobileOpen] = useState(false)
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null)
  const mobileMenuRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLElement>(null)
  const scrolled = useScroll(10)
  const isDemoPage = pathname === "/demo" || pathname.startsWith("/demo/")

  const navItems = [
    { name: "How it works", href: "/how-it-works" },
    { name: "Live feed", href: "/feed" },
    { name: "Demo", href: "/demo" },
    { name: "Get started", href: "/start" },
    { name: "FAQ", href: "/#faq-section" },
  ]

  // Body scroll lock
  useEffect(() => {
    document.body.style.overflow = mobileOpen ? "hidden" : ""
    return () => { document.body.style.overflow = "" }
  }, [mobileOpen])

  useEffect(() => {
    if (!mobileOpen) return

    mobileMenuRef.current?.querySelector<HTMLElement>("a, button")?.focus()

    const background = [headerRef.current, ...Array.from(document.querySelectorAll<HTMLElement>("main, footer"))]
      .filter((element): element is HTMLElement => element !== null)
    const priorState = background.map((element) => ({
      element,
      inert: element.inert,
      ariaHidden: element.getAttribute("aria-hidden"),
    }))
    for (const element of background) {
      element.inert = true
      element.setAttribute("aria-hidden", "true")
    }

    const handleMenuKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        setMobileOpen(false)
        window.setTimeout(() => mobileMenuButtonRef.current?.focus(), 0)
        return
      }
      if (event.key !== "Tab") return

      const focusable = Array.from(
        mobileMenuRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      )
      if (focusable.length === 0) {
        event.preventDefault()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (first === undefined || last === undefined) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener("keydown", handleMenuKey)
    return () => {
      document.removeEventListener("keydown", handleMenuKey)
      for (const { element, inert, ariaHidden } of priorState) {
        element.inert = inert
        if (ariaHidden === null) element.removeAttribute("aria-hidden")
        else element.setAttribute("aria-hidden", ariaHidden)
      }
    }
  }, [mobileOpen])

  const handleNavClick = () => {
    setMobileOpen(false)
  }

  return (
    <>
      <header
        ref={headerRef}
        className={cn(
          "sticky top-0 z-50 w-full border-b border-transparent transition-[background-color,border-color,backdrop-filter] duration-200",
          scrolled && "bg-background/90 supports-[backdrop-filter]:bg-background/75 backdrop-blur-md border-border"
        )}
      >
        {/* 3-column grid keeps the nav dead-center on the page regardless of the
            (unequal) logo vs. auth widths — justify-between would bias it left. */}
        <div className={cn("mx-auto w-full grid grid-cols-[1fr_auto_1fr] items-center h-14", CONTAINER_WIDTH.content, GUTTER)}>

          {/* Brand */}
          <div className="justify-self-start">
            <BrandLink href="/" ariaLabel="Corgi home" />
          </div>

          {/* Desktop nav */}
          <nav className="hidden md:flex items-center gap-0.5 justify-self-center" aria-label="Main navigation">
            {navItems.map((item) => {
              const active = isNavItemActive(pathname, item.href)

              return (
                <Link
                  key={item.name}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "px-4 py-1.5 rounded-full text-sm font-medium transition-colors",
                    FOCUS,
                    active
                      ? "bg-primary/10 text-primary"
                      : "text-foreground/60 hover:text-foreground hover:bg-accent/60",
                  )}
                >
                  {item.name}
                </Link>
              )
            })}
          </nav>

          {/* Right: desktop auth + mobile hamburger.
              col-start-3: when the desktop nav is display:none (mobile), this div
              becomes the grid's second item and would otherwise land in the center
              column — the hamburger belongs pinned to the right rail. */}
          <div className="col-start-3 justify-self-end flex items-center gap-2">
            <div className="hidden md:flex items-center gap-3">
              <button
                onClick={() => openDialog("signin")}
                className={cn("text-sm font-medium text-foreground/70 hover:text-foreground transition-colors rounded-md px-2 py-1", FOCUS)}
              >
                Sign in
              </button>
              <Button
                asChild={!isDemoPage}
                onClick={isDemoPage ? () => openDialog("waitlist") : undefined}
                className="bg-primary text-primary-foreground hover:bg-primary-dark rounded-full px-5 text-sm shadow-[0_2px_8px_rgba(200,97,44,0.28)] hover:shadow-[0_4px_14px_rgba(200,97,44,0.38)] transition-all"
              >
                {isDemoPage ? "Join the waitlist" : <Link href="/demo">Try demo</Link>}
              </Button>
            </div>

            {/* Mobile hamburger */}
            <button
              ref={mobileMenuButtonRef}
              onClick={() => setMobileOpen((v) => !v)}
              aria-label={mobileOpen ? "Close menu" : "Open menu"}
              aria-expanded={mobileOpen}
              aria-controls="landing-mobile-menu"
              className={cn("md:hidden flex items-center justify-center w-9 h-9 rounded-lg text-foreground/70 hover:text-foreground hover:bg-accent/60 transition-colors", FOCUS)}
            >
              <AnimatedMenuIcon open={mobileOpen} />
            </button>
          </div>
        </div>
      </header>

      {/* Mobile menu portal */}
      {typeof window !== "undefined" && mobileOpen && createPortal(
        <div
          ref={mobileMenuRef}
          id="landing-mobile-menu"
          role="dialog"
          aria-modal="true"
          aria-label="Main navigation"
          className="fixed inset-0 z-[60] md:hidden bg-background/95 supports-[backdrop-filter]:bg-background/80 backdrop-blur-lg flex flex-col overflow-hidden"
        >
          <div className={cn("mx-auto flex h-14 w-full items-center justify-between border-b border-border", CONTAINER_WIDTH.content, GUTTER)}>
            <div onClick={handleNavClick}>
              <BrandLink href="/" ariaLabel="Corgi home" />
            </div>
            <button
              type="button"
              onClick={() => {
                setMobileOpen(false)
                window.setTimeout(() => mobileMenuButtonRef.current?.focus(), 0)
              }}
              aria-label="Close menu"
              className={cn("flex h-9 w-9 items-center justify-center rounded-lg text-foreground/70 hover:bg-accent/60 hover:text-foreground", FOCUS)}
            >
              <AnimatedMenuIcon open />
            </button>
          </div>
          <div
            data-slot={mobileOpen ? "open" : "closed"}
            className="data-[slot=open]:animate-in data-[slot=open]:zoom-in-97 data-[slot=open]:ease-out data-[slot=open]:duration-200 flex flex-col justify-between h-full p-4"
          >
            <nav className="flex flex-col gap-1" aria-label="Mobile navigation">
              {navItems.map((item) => {
                const active = isNavItemActive(pathname, item.href)

                return (
                  <Link
                    key={item.name}
                    href={item.href}
                    onClick={handleNavClick}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "px-4 py-3 rounded-xl text-base font-medium transition-colors",
                      FOCUS,
                      active
                        ? "bg-primary/10 text-primary"
                        : "text-foreground/70 hover:text-foreground hover:bg-accent/60",
                    )}
                  >
                    {item.name}
                  </Link>
                )
              })}
            </nav>
            <div className="flex flex-col gap-2 pb-2">
              <button
                onClick={() => { setMobileOpen(false); openDialog("signin") }}
                className={cn("w-full px-4 py-3 rounded-xl text-sm font-medium text-foreground/70 hover:text-foreground hover:bg-accent/60 transition-colors text-left", FOCUS)}
              >
                Already approved? Sign in
              </button>
              <Button
                asChild={!isDemoPage}
                onClick={isDemoPage ? () => { setMobileOpen(false); openDialog("waitlist") } : undefined}
                className="w-full bg-primary text-primary-foreground hover:bg-primary-dark rounded-full text-sm shadow-[0_2px_8px_rgba(200,97,44,0.28)] transition-all"
              >
                {isDemoPage
                  ? "Join the waitlist"
                  : <Link href="/demo" onClick={handleNavClick}>Try demo</Link>}
              </Button>
              {!isDemoPage && (
                <button
                  onClick={() => { setMobileOpen(false); openDialog("waitlist") }}
                  className={cn("w-full px-4 py-3 rounded-xl text-sm font-medium text-foreground/70 hover:text-foreground hover:bg-accent/60 transition-colors text-left", FOCUS)}
                >
                  Join the waitlist
                </button>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}

      <SignInDialog open={signInOpen} onOpenChange={setSignInOpen} initialMode={dialogMode} redirectOnSuccess="/dashboard" />
    </>
  )
}
