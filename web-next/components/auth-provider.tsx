"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { usePathname } from "next/navigation"
import { authApi, type AuthenticatedSessionResponse } from "@/lib/api/client"
import { AuthRequestCoordinator } from "@/lib/auth-request"

/** Query key for the current session — invalidated after login/logout. */
export const SESSION_QUERY_KEY = ["auth", "session"] as const

interface AuthContextValue {
  /** The live session, or null when unauthenticated / still resolving. */
  session: AuthenticatedSessionResponse | null
  /** True only when the backend confirms an authenticated session. */
  isAuthenticated: boolean
  /** True while the very first session probe is in flight. */
  isLoading: boolean
  /** Log in with a Bluesky handle + app password. Rejects on failure (e.g. 401). */
  login: (handle: string, appPassword: string) => Promise<void>
  /** Abort a pending login when its dialog session is no longer active. */
  cancelLogin: () => void
  /** Clear the session cookie and reset auth state. */
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const pathname = usePathname()
  const loginRequests = useRef(new AuthRequestCoordinator())
  const sessionProbeEnabled = pathname !== "/feed" && !pathname.startsWith("/feed/")

  useEffect(() => () => loginRequests.current.cancel(), [])

  // Auth state is derived ONLY from the session endpoint. Anonymous callers
  // receive an explicit authenticated=false response without a failed request.
  const sessionQuery = useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: authApi.getSession,
    retry: false,
    // /feed is an intentionally anonymous transparency surface. It must not
    // probe auth merely to render public ranking evidence.
    enabled: sessionProbeEnabled,
  })

  // Deliberately NOT a useMutation: mutation variables are retained in the
  // mutation cache (and surfaced by devtools), which would keep the app
  // password in memory after login. A plain call leaves no credential residue.
  const login = useCallback(
    async (handle: string, appPassword: string) => {
      const signal = loginRequests.current.begin()
      try {
        await authApi.login(handle, appPassword, signal)
        if (loginRequests.current.isCurrent(signal)) {
          await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY })
        }
      } finally {
        loginRequests.current.complete(signal)
      }
    },
    [queryClient]
  )

  const cancelLogin = useCallback(() => {
    loginRequests.current.cancel()
  }, [])

  // Clear the ENTIRE query cache on logout, not just the session query —
  // authenticated data (my-vote ballot, etc.) must not leak into the next
  // user's session. Public data simply refetches.
  const logout = useCallback(async () => {
    await authApi.logout()
    queryClient.clear()
  }, [queryClient])

  // A disabled query may still expose data retained in the query cache. The
  // anonymous feed must not inherit that authenticated state.
  const sessionResponse = sessionProbeEnabled ? sessionQuery.data : undefined
  const session: AuthenticatedSessionResponse | null =
    sessionResponse?.authenticated === true ? sessionResponse : null
  const isAuthenticated = session !== null

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      isAuthenticated,
      isLoading: sessionProbeEnabled && sessionQuery.isLoading,
      login,
      cancelLogin,
      logout,
    }),
    [session, isAuthenticated, sessionProbeEnabled, sessionQuery.isLoading, login, cancelLogin, logout]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider")
  }
  return ctx
}
