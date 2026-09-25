import { z } from 'zod';
import type {
  ShadowDemoDisplayPost,
  ShadowDemoPostMedia,
  ShadowDemoPublicPost,
} from './types.js';

// Bump when the public-view eligibility or hydration contract changes.
export const DEMO_VISIBILITY_POLICY_VERSION = '2026-09-23.current-display-reviewed-cid-v2';

const HIDDEN_LABELS = new Set(['!no-unauthenticated', '!hide', '!takedown']);
const ADULT_ONLY_LABELS = new Set(['porn', 'sexual', 'nudity', 'graphic-media']);
const POST_AT_URI_PATTERN = /^at:\/\/(did:[a-z0-9]+:[A-Za-z0-9._:-]+)\/app\.bsky\.feed\.post\/([A-Za-z0-9._~:@!$&'()*+,;=-]+)$/;

const AppViewLabelSchema = z.object({ val: z.string().optional() }).passthrough();
const AppViewAuthorSchema = z.object({
  did: z.string().optional(),
  handle: z.string().optional(),
  displayName: z.string().optional(),
  avatar: z.string().optional(),
  labels: z.array(AppViewLabelSchema).optional(),
}).passthrough();
const AppViewRecordSchema = z.object({
  text: z.string().optional(),
  createdAt: z.string().optional(),
  langs: z.array(z.string()).optional(),
}).passthrough();
const AppViewAspectRatioSchema = z.object({
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
}).passthrough();
const AppViewEmbedSchema: z.ZodTypeAny = z.object({
  $type: z.string().optional(),
  external: z.object({
    uri: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    thumb: z.string().optional(),
  }).passthrough().optional(),
  images: z.array(z.object({
    thumb: z.string().optional(),
    fullsize: z.string().optional(),
    alt: z.string().optional(),
    aspectRatio: AppViewAspectRatioSchema.optional(),
  }).passthrough()).optional(),
  thumbnail: z.string().optional(),
  aspectRatio: AppViewAspectRatioSchema.optional(),
  record: z.unknown().optional(),
  media: z.unknown().optional(),
}).passthrough();

const REVIEWER_SAFETY_PATTERN = /(?:\b(?:assholes?|bitches?|csam|cunts?|faggots?|fuck(?:ing|ed|er|s|you)?|motherfuckers?|nsfw|porn(?:ography|ographic)?|shit(?:ty|ting|s)?|sluts?|whores?)\b|hitler|puss(?:y|ies)|🔞)/i;
const UNAVAILABLE_QUOTE_VIEW_TYPES = new Set([
  'app.bsky.embed.record#viewBlocked',
  'app.bsky.embed.record#viewDetached',
  'app.bsky.embed.record#viewNotFound',
]);

export const AppViewPostSchema = z.object({
  uri: z.string().optional(),
  cid: z.string().optional(),
  author: AppViewAuthorSchema.optional(),
  record: AppViewRecordSchema.optional(),
  indexedAt: z.string().optional(),
  likeCount: z.unknown().optional(),
  repostCount: z.unknown().optional(),
  replyCount: z.unknown().optional(),
  quoteCount: z.unknown().optional(),
  labels: z.array(AppViewLabelSchema).optional(),
  embed: AppViewEmbedSchema.optional(),
}).passthrough();

const PublicAppViewPostSchema = AppViewPostSchema.extend({
  uri: z.string().regex(POST_AT_URI_PATTERN),
  cid: z.string().trim().min(1),
  author: AppViewAuthorSchema.extend({
    did: z.string().trim().min(1),
    handle: z.string().trim().min(1),
  }),
  record: AppViewRecordSchema.extend({
    text: z.string().trim().min(1),
    createdAt: z.string().trim().min(1),
  }),
  indexedAt: z.string().trim().min(1),
});

type AppViewLabel = z.infer<typeof AppViewLabelSchema>;
type AppViewAuthor = z.infer<typeof AppViewAuthorSchema>;

export type AppViewPost = z.infer<typeof AppViewPostSchema>;

export function hiddenReasonForPublicView(input: unknown): string | null {
  if (input === null || input === undefined) {
    return 'Post unavailable from Bluesky public AppView';
  }
  const parsedPost = AppViewPostSchema.safeParse(input);
  if (!parsedPost.success) {
    return 'Post metadata unavailable from Bluesky public AppView';
  }
  const post = parsedPost.data;
  const authority = typeof post.uri === 'string' ? POST_AT_URI_PATTERN.exec(post.uri)?.[1] : undefined;
  if (authority === undefined || post.author?.did !== authority) {
    return 'Post identity is inconsistent with its URI';
  }

  const labelValues = [
    ...labelValuesFrom(post.labels),
    ...labelValuesFrom(post.author?.labels),
    ...nestedLabelValues(post.embed),
  ];
  const hiddenLabel = labelValues.find((label) => HIDDEN_LABELS.has(label));
  if (hiddenLabel) {
    return `Hidden by Bluesky public-view label ${hiddenLabel}`;
  }

  const adultLabel = labelValues.find((label) => ADULT_ONLY_LABELS.has(label));
  if (adultLabel) {
    return `Hidden by Bluesky adult-content label ${adultLabel}`;
  }

  const record = post.record;
  const text =
    record && typeof record === 'object' && 'text' in record
      ? (record as { text?: unknown }).text
      : null;
  if (typeof text !== 'string' || text.trim().length === 0) {
    return 'Post text unavailable from Bluesky public AppView';
  }

  if (!PublicAppViewPostSchema.safeParse(post).success) {
    return 'Post metadata unavailable from Bluesky public AppView';
  }

  const displayName = post.author?.displayName ?? '';
  const handle = post.author?.handle ?? '';
  if (
    REVIEWER_SAFETY_PATTERN.test(text)
    || REVIEWER_SAFETY_PATTERN.test(displayName)
    || REVIEWER_SAFETY_PATTERN.test(handle)
  ) {
    return 'Withheld by reviewer-safety language gate';
  }

  return null;
}

export function publicPostFromAppView(input: unknown): ShadowDemoDisplayPost {
  const hiddenReason = hiddenReasonForPublicView(input);
  if (hiddenReason) {
    return {
      kind: 'hidden_post',
      reason: hiddenReason,
    };
  }

  const parsed = PublicAppViewPostSchema.safeParse(input);
  if (!parsed.success) {
    return hiddenDisplayPost('Post metadata unavailable from Bluesky public AppView');
  }
  const publicPost = parsed.data;
  return {
    kind: 'public_post',
    uri: publicPost.uri,
    cid: publicPost.cid,
    authorDid: publicPost.author.did,
    authorHandle: publicPost.author.handle,
    authorDisplayName: displayNameForAuthor(publicPost.author),
    authorAvatar: safeHttpsUrl(publicPost.author.avatar),
    text: publicPost.record.text,
    likeCount: finiteCount(publicPost.likeCount),
    repostCount: finiteCount(publicPost.repostCount),
    replyCount: finiteCount(publicPost.replyCount),
    quoteCount: finiteCount(publicPost.quoteCount),
    indexedAt: publicPost.indexedAt,
    createdAt: publicPost.record.createdAt,
    bskyUrl: bskyPostUrlFromAtUri(publicPost.uri),
    languages: publicPost.record.langs && publicPost.record.langs.length > 0
      ? publicPost.record.langs
      : ['und'],
    media: mediaFromAppView(publicPost.embed),
  } satisfies ShadowDemoPublicPost;
}

export function hiddenDisplayPost(reason: string): ShadowDemoDisplayPost {
  return {
    kind: 'hidden_post',
    reason,
  };
}

export function bskyPostUrlFromAtUri(uri: string): string {
  const match = POST_AT_URI_PATTERN.exec(uri);
  if (!match) {
    throw new Error(`Cannot build Bluesky URL for non-post AT-URI: ${uri}`);
  }
  return `https://bsky.app/profile/${match[1]}/post/${encodeURIComponent(match[2])}`;
}

function labelValuesFrom(labels: AppViewLabel[] | undefined): string[] {
  if (!labels) {
    return [];
  }
  return labels
    .map((label) => label.val)
    .filter((label): label is string => typeof label === 'string' && label.length > 0);
}

function displayNameForAuthor(author: AppViewAuthor | undefined): string {
  if (typeof author?.displayName === 'string' && author.displayName.trim().length > 0) {
    return author.displayName;
  }
  return author?.handle ?? '';
}

function finiteCount(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

function nestedLabelValues(input: unknown): string[] {
  if (input === null || typeof input !== 'object') {
    return [];
  }
  const values: string[] = [];
  const stack: unknown[] = [input];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || typeof current !== 'object' || seen.has(current)) {
      continue;
    }
    seen.add(current);
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    const record = current as Record<string, unknown>;
    if (Array.isArray(record.labels)) {
      for (const label of record.labels) {
        if (label && typeof label === 'object' && typeof (label as { val?: unknown }).val === 'string') {
          values.push((label as { val: string }).val);
        }
      }
    }
    stack.push(...Object.values(record));
  }
  return values;
}

function mediaFromAppView(embed: unknown): ShadowDemoPostMedia | null {
  const parsed = AppViewEmbedSchema.safeParse(embed);
  if (!parsed.success) {
    return null;
  }
  const root = parsed.data as Record<string, unknown>;
  const mediaRecord = root.media && typeof root.media === 'object'
    ? (root.media as Record<string, unknown>)
    : root;
  const images = Array.isArray(mediaRecord.images)
    ? mediaRecord.images.flatMap((candidate) => {
        if (!candidate || typeof candidate !== 'object') return [];
        const image = candidate as Record<string, unknown>;
        const thumb = safeHttpsUrl(image.thumb);
        const fullsize = safeHttpsUrl(image.fullsize);
        if (!thumb || !fullsize) return [];
        const ratio = image.aspectRatio && typeof image.aspectRatio === 'object'
          ? image.aspectRatio as Record<string, unknown>
          : null;
        return [{
          thumb,
          fullsize,
          alt: typeof image.alt === 'string' && !REVIEWER_SAFETY_PATTERN.test(image.alt) ? image.alt : '',
          width: typeof ratio?.width === 'number' ? ratio.width : null,
          height: typeof ratio?.height === 'number' ? ratio.height : null,
        }];
      })
    : [];
  const externalRecord = mediaRecord.external && typeof mediaRecord.external === 'object'
    ? mediaRecord.external as Record<string, unknown>
    : root.external && typeof root.external === 'object'
      ? root.external as Record<string, unknown>
      : null;
  const externalUri = safeHttpsUrl(externalRecord?.uri);
  const externalTitle = typeof externalRecord?.title === 'string' ? externalRecord.title : '';
  const externalDescription = typeof externalRecord?.description === 'string' ? externalRecord.description : '';
  const external = externalRecord
    && externalUri
    && !REVIEWER_SAFETY_PATTERN.test(externalTitle)
    && !REVIEWER_SAFETY_PATTERN.test(externalDescription)
    ? {
        uri: externalUri,
        title: externalTitle,
        description: externalDescription,
        thumb: safeHttpsUrl(externalRecord.thumb),
      }
    : null;
  const quote = quoteFromEmbed(root.record);
  const type = typeof mediaRecord.$type === 'string' ? mediaRecord.$type : typeof root.$type === 'string' ? root.$type : '';
  const ratio = mediaRecord.aspectRatio && typeof mediaRecord.aspectRatio === 'object'
    ? mediaRecord.aspectRatio as Record<string, unknown>
    : null;
  const video = type.includes('video')
    ? {
        thumbnail: safeHttpsUrl(mediaRecord.thumbnail),
        width: typeof ratio?.width === 'number' ? ratio.width : null,
        height: typeof ratio?.height === 'number' ? ratio.height : null,
      }
    : null;
  return images.length > 0 || external || quote || video ? { images, external, quote, video } : null;
}

function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function quoteFromEmbed(input: unknown): ShadowDemoPostMedia['quote'] {
  if (!input || typeof input !== 'object') return null;
  const wrapper = input as Record<string, unknown>;
  const view = wrapper.record && typeof wrapper.record === 'object'
    ? wrapper.record as Record<string, unknown>
    : wrapper;
  if (typeof view.$type === 'string' && UNAVAILABLE_QUOTE_VIEW_TYPES.has(view.$type)) {
    return null;
  }
  const author = view.author && typeof view.author === 'object' ? view.author as Record<string, unknown> : null;
  const value = view.value && typeof view.value === 'object' ? view.value as Record<string, unknown> : null;
  const authorHandle = typeof author?.handle === 'string' ? author.handle.trim() : '';
  if (
    !author
    || !value
    || typeof view.uri !== 'string'
    || !view.uri.startsWith('at://')
    || authorHandle.length === 0
    || typeof value.text !== 'string'
    || value.text.trim().length === 0
  ) {
    return null;
  }
  if (nestedLabelValues(view).some((label) => HIDDEN_LABELS.has(label) || ADULT_ONLY_LABELS.has(label))) {
    return null;
  }
  const authorDisplayName = typeof author.displayName === 'string' && author.displayName.trim()
    ? author.displayName
    : authorHandle;
  if (
    REVIEWER_SAFETY_PATTERN.test(value.text)
    || REVIEWER_SAFETY_PATTERN.test(authorDisplayName)
    || REVIEWER_SAFETY_PATTERN.test(authorHandle)
  ) {
    return null;
  }
  return {
    uri: view.uri,
    authorHandle,
    authorDisplayName,
    text: value.text,
  };
}
