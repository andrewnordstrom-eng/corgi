export const BLUESKY_APPVIEW_BASE_URL = "https://public.api.bsky.app"
export const BLUESKY_APPVIEW_MAX_POST_URIS = 25

export class BlueskyPublicDataError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BlueskyPublicDataError"
  }
}

export function buildPostHydrationUrl(postUris: readonly string[]): string {
  if (postUris.length > BLUESKY_APPVIEW_MAX_POST_URIS) {
    throw new BlueskyPublicDataError(
      `Bluesky AppView post hydration accepts at most ${BLUESKY_APPVIEW_MAX_POST_URIS} URIs, received ${postUris.length}`,
    )
  }
  const url = new URL("/xrpc/app.bsky.feed.getPosts", BLUESKY_APPVIEW_BASE_URL)

  for (const postUri of postUris) {
    url.searchParams.append("uris", postUri)
  }

  return url.toString()
}

export function bskyPostUrlFromAtUri(postUri: string): string {
  const match = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/.exec(postUri)

  if (match === null) {
    throw new BlueskyPublicDataError(`Unable to build Bluesky URL from post URI: ${postUri}`)
  }

  const repo = match[1]
  const rkey = match[2]
  if (repo === undefined || rkey === undefined) {
    throw new BlueskyPublicDataError(`Unable to parse Bluesky post URI: ${postUri}`)
  }

  return `https://bsky.app/profile/${repo}/post/${encodeURIComponent(rkey)}`
}
