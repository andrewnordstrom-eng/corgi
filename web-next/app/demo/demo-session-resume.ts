export const DEMO_RESUME_KEY = "corgi.demo.resume.v1"

export interface DemoSessionResume {
  readonly version: 1
  readonly sessionId: string
  readonly expiresAt: string
  readonly selection: { readonly postUri: string; readonly epochId: string } | null
  readonly nextEpochId: string | null
  readonly mobileView: "feed" | "receipt"
}

export class DemoResumeHintError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DemoResumeHintError"
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value)
}

export function readDemoResume(storage: Storage, nowMs: number): DemoSessionResume | null {
  const text = storage.getItem(DEMO_RESUME_KEY)
  if (text === null) return null
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new DemoResumeHintError("The saved demo continuation is invalid. Start a new session.")
  }
  if (!record(value) || value.version !== 1 || !identifier(value.sessionId)
    || typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))
    || (value.mobileView !== "feed" && value.mobileView !== "receipt")
    || (value.nextEpochId !== null && !identifier(value.nextEpochId))
    || Object.keys(value).some((key) => !["version", "sessionId", "expiresAt", "selection", "nextEpochId", "mobileView"].includes(key))) {
    throw new DemoResumeHintError("The saved demo continuation is incompatible. Start a new session.")
  }
  const selection = value.selection
  if (selection !== null && (!record(selection) || !identifier(selection.epochId)
    || typeof selection.postUri !== "string" || selection.postUri.length > 2048
    || !/^at:\/\/[^\s/]+\/app\.bsky\.feed\.post\/[^\s/]+$/.test(selection.postUri)
    || Object.keys(selection).some((key) => key !== "postUri" && key !== "epochId"))) {
    throw new DemoResumeHintError("The saved demo receipt selection is invalid. Start a new session.")
  }
  if (Date.parse(value.expiresAt) <= nowMs) {
    throw new DemoResumeHintError("Your saved demo session has expired. Start a new session.")
  }
  return {
    version: 1,
    sessionId: value.sessionId,
    expiresAt: value.expiresAt,
    selection: selection === null ? null : { postUri: String(selection.postUri), epochId: String(selection.epochId) },
    nextEpochId: value.nextEpochId,
    mobileView: value.mobileView,
  }
}

export function writeDemoResume(storage: Storage, hint: DemoSessionResume | null): void {
  if (hint === null) storage.removeItem(DEMO_RESUME_KEY)
  else storage.setItem(DEMO_RESUME_KEY, JSON.stringify(hint))
}
