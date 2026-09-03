import { describe, expect, it } from 'vitest';
import { composeFeedItems, parsePinnedAnnouncementUri } from '../src/feed/pinned-composition.js';

describe('pinned feed composition', () => {
  it('inserts a distinct announcement and preserves underlying ranked positions', () => {
    expect(composeFeedItems(['post-1', 'post-2', 'post-3'], 3, 'announcement')).toEqual([
      { postUri: 'announcement', position: 1, rankedPosition: null, placement: 'pinned_announcement' },
      { postUri: 'post-1', position: 2, rankedPosition: 1, placement: 'ranked' },
      { postUri: 'post-2', position: 3, rankedPosition: 2, placement: 'ranked' },
    ]);
  });

  it('marks an announcement already in the visible ranked slice without moving or duplicating it', () => {
    expect(composeFeedItems(['post-1', 'announcement', 'post-3'], 3, 'announcement')).toEqual([
      { postUri: 'post-1', position: 1, rankedPosition: 1, placement: 'ranked' },
      { postUri: 'announcement', position: 2, rankedPosition: 2, placement: 'pinned_announcement' },
      { postUri: 'post-3', position: 3, rankedPosition: 3, placement: 'ranked' },
    ]);
  });

  it('parses only announcement objects with a non-empty URI', () => {
    expect(parsePinnedAnnouncementUri('{"uri":"at://did:plc:test/app.bsky.feed.post/1"}'))
      .toBe('at://did:plc:test/app.bsky.feed.post/1');
    expect(parsePinnedAnnouncementUri('{"uri":""}')).toBeNull();
    expect(parsePinnedAnnouncementUri('{not-json')).toBeNull();
    expect(parsePinnedAnnouncementUri(null)).toBeNull();
  });
});
