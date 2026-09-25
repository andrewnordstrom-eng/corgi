const HIDDEN_PUBLIC_LABELS: ReadonlySet<string> = new Set([
  '!no-unauthenticated', '!hide', '!takedown', '!warn',
  'porn', 'sexual', 'nudity', 'graphic-media', 'gore', 'self-harm', 'sexual-figurative',
]);
const UNAVAILABLE_EMBED_TYPES: ReadonlySet<string> = new Set([
  'app.bsky.embed.record#viewBlocked',
  'app.bsky.embed.record#viewDetached',
  'app.bsky.embed.record#viewNotFound',
]);
const MAX_VISIBILITY_DEPTH = 12;
const MAX_VISIBILITY_NODES = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One anonymous public-view policy; deliberately excludes demo-only language rules. */
export function publicPostVisibilityReason(value: unknown): string | null {
  if (!isRecord(value) || typeof value.uri !== 'string' ||
      !isRecord(value.author) || typeof value.author.did !== 'string' ||
      value.author.did.trim().length === 0 || typeof value.author.handle !== 'string' ||
      value.author.handle.trim().length === 0 || !isRecord(value.record) ||
      typeof value.record.text !== 'string' || value.record.text.trim().length === 0) {
    return 'Post unavailable from Bluesky public view';
  }

  const uriAuthority = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/[^/]+$/.exec(value.uri)?.[1];
  if (uriAuthority === undefined || uriAuthority !== value.author.did) {
    return 'Post identity is inconsistent with its URI';
  }

  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    visited += 1;
    if (visited > MAX_VISIBILITY_NODES || current.depth > MAX_VISIBILITY_DEPTH) {
      return 'Post visibility metadata exceeds validation bounds';
    }
    if (Array.isArray(current.value)) {
      for (const item of current.value) pending.push({ value: item, depth: current.depth + 1 });
      continue;
    }
    if (!isRecord(current.value)) continue;
    const node = current.value;
    if (typeof node.$type === 'string' && UNAVAILABLE_EMBED_TYPES.has(node.$type)) {
      return 'Post contains an unavailable embedded record';
    }
    if ('labels' in node) {
      const labels = Array.isArray(node.labels)
        ? node.labels
        : isRecord(node.labels) && Array.isArray(node.labels.values)
          ? node.labels.values
          : null;
      if (labels === null) return 'Post visibility labels are invalid';
      for (const label of labels) {
        if (!isRecord(label) || typeof label.val !== 'string') {
          return 'Post visibility labels are invalid';
        }
        if (HIDDEN_PUBLIC_LABELS.has(label.val.trim().toLowerCase())) {
          return 'Post hidden by Bluesky public-view policy';
        }
      }
    }
    for (const nested of Object.values(node)) {
      if (typeof nested === 'object' && nested !== null) {
        pending.push({ value: nested, depth: current.depth + 1 });
      }
    }
  }
  return null;
}
