export type FeedPlacement = 'ranked' | 'pinned_announcement';

export interface ComposedFeedItem {
  postUri: string;
  position: number;
  rankedPosition: number | null;
  placement: FeedPlacement;
}

export function parsePinnedAnnouncementUri(serialized: string | null): string | null {
  if (serialized === null) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    return null;
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('uri' in parsed) ||
    typeof parsed.uri !== 'string' ||
    parsed.uri.length === 0
  ) {
    return null;
  }

  return parsed.uri;
}

export function composeFeedItems(
  rankedUris: readonly string[],
  limit: number,
  pinnedUri: string | null
): ComposedFeedItem[] {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`Feed composition limit must be a positive integer: ${limit}`);
  }

  const visibleRankedUris = rankedUris.slice(0, limit);
  const shouldPin = pinnedUri !== null && !visibleRankedUris.includes(pinnedUri);
  const rankedLimit = shouldPin ? Math.max(limit - 1, 0) : limit;
  const rankedItems = visibleRankedUris.slice(0, rankedLimit).map((postUri, index) => {
    const isExistingAnnouncement = pinnedUri !== null && postUri === pinnedUri;
    return {
      postUri,
      position: index + (shouldPin ? 2 : 1),
      rankedPosition: index + 1,
      placement: isExistingAnnouncement ? 'pinned_announcement' as const : 'ranked' as const,
    };
  });

  if (!shouldPin) {
    return rankedItems;
  }

  return [
    {
      postUri: pinnedUri,
      position: 1,
      rankedPosition: null,
      placement: 'pinned_announcement',
    },
    ...rankedItems,
  ];
}
