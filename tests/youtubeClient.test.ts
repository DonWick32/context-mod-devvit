import { describe, expect, it, vi } from 'vitest';
import { YouTubeClient, extractYouTubeVideoId } from '../src/runtime/youtubeClient';

describe('YouTube client', () => {
  it.each([
    ['https://www.youtube.com/watch?v=abc123xyz89', 'abc123xyz89'],
    ['https://youtu.be/abc123xyz89?t=10', 'abc123xyz89'],
    ['https://www.youtube.com/shorts/abc123xyz89', 'abc123xyz89'],
    ['https://www.youtube.com/embed/abc123xyz89', 'abc123xyz89'],
    ['https://www.youtube.com/live/abc123xyz89?feature=share', 'abc123xyz89'],
  ])('parses video id from %s', (url, expected) => {
    expect(extractYouTubeVideoId(url)).toBe(expected);
  });

  it('fetches and sorts top-level comments as external candidates', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        items: [
          {
            id: 'thread-low',
            snippet: {
              topLevelComment: {
                id: 'comment-low',
                snippet: {
                  textOriginal: 'same copied phrase',
                  publishedAt: '2026-05-20T00:00:00Z',
                  videoId: 'abc123xyz89',
                  authorDisplayName: 'Low',
                  likeCount: 3,
                },
              },
            },
          },
          {
            id: 'thread-high',
            snippet: {
              topLevelComment: {
                id: 'comment-high',
                snippet: {
                  textOriginal: 'same copied phrase with more likes',
                  publishedAt: '2026-05-21T00:00:00Z',
                  videoId: 'abc123xyz89',
                  authorDisplayName: 'High',
                  likeCount: 9,
                },
              },
            },
          },
        ],
      }),
    } as Response);

    const comments = await new YouTubeClient('test-key', fetcher).getVideoTopComments(
      'abc123xyz89',
      2
    );

    expect(fetcher).toHaveBeenCalledOnce();
    const requestedUrl = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(requestedUrl.hostname).toBe('youtube.googleapis.com');
    expect(requestedUrl.searchParams.get('videoId')).toBe('abc123xyz89');
    expect(requestedUrl.searchParams.get('key')).toBe('test-key');
    expect(comments).toEqual([
      expect.objectContaining({
        id: 'comment-high',
        likeCount: 9,
      }),
      expect.objectContaining({
        id: 'comment-low',
        likeCount: 3,
      }),
    ]);
  });
});
