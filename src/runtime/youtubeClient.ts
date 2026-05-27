export type YouTubeVideoInfo = {
  channelId: string;
  channelTitle: string;
  publishedAt: string;
};

export type YouTubeTopComment = {
  id: string;
  text: string;
  publishedAt: string;
  author: string;
  likeCount: number;
  videoId: string;
};

type YouTubeVideoListResponse = {
  items?: {
    snippet?: {
      channelId?: string;
      channelTitle?: string;
      publishedAt?: string;
    };
  }[];
  error?: {
    message?: string;
  };
};

type YouTubeCommentThreadListResponse = {
  items?: {
    id?: string;
    snippet?: {
      topLevelComment?: {
        id?: string;
        snippet?: {
          textDisplay?: string;
          textOriginal?: string;
          publishedAt?: string;
          authorDisplayName?: string;
          likeCount?: number;
          videoId?: string;
        };
      };
    };
  }[];
  error?: {
    message?: string;
  };
};

const clampMaxResults = (maxItems: number): number =>
  Math.max(1, Math.min(100, Math.floor(maxItems)));

const createYouTubeApiUrl = (
  path: 'videos' | 'commentThreads',
  params: Record<string, string | number>
): string => {
  const url = new URL(`https://youtube.googleapis.com/youtube/v3/${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
};

export class YouTubeClient {
  private apiKey: string;
  private fetcher: typeof fetch;

  constructor(apiKey: string, fetcher: typeof fetch = fetch) {
    this.apiKey = apiKey;
    this.fetcher = fetcher;
  }

  async getVideoInfo(videoId: string): Promise<YouTubeVideoInfo | undefined> {
    try {
      const response = await this.fetcher(
        createYouTubeApiUrl('videos', {
          part: 'snippet',
          id: videoId,
          key: this.apiKey,
        })
      );
      const data = (await response.json()) as YouTubeVideoListResponse;
      if (!response.ok) {
        console.error(
          `YouTube API error: ${
            data.error?.message ?? `${response.status} ${response.statusText}`
          }`
        );
        return undefined;
      }
      const item = data.items?.[0];
      if (
        item?.snippet?.channelId === undefined ||
        item.snippet.channelTitle === undefined ||
        item.snippet.publishedAt === undefined
      ) {
        return undefined;
      }

      return {
        channelId: item.snippet.channelId,
        channelTitle: item.snippet.channelTitle,
        publishedAt: item.snippet.publishedAt,
      };
    } catch (error) {
      console.error(`YouTube API fetch error: ${error}`);
      return undefined;
    }
  }

  async getVideoTopComments(
    videoId: string,
    maxItems = 50
  ): Promise<YouTubeTopComment[] | undefined> {
    try {
      const response = await this.fetcher(
        createYouTubeApiUrl('commentThreads', {
          part: 'snippet',
          videoId,
          maxResults: clampMaxResults(maxItems),
          textFormat: 'plainText',
          order: 'relevance',
          key: this.apiKey,
        })
      );
      const data = (await response.json()) as YouTubeCommentThreadListResponse;
      if (!response.ok) {
        console.error(
          `YouTube API commentThreads error: ${
            data.error?.message ?? `${response.status} ${response.statusText}`
          }`
        );
        return undefined;
      }
      if (!Array.isArray(data.items)) {
        return undefined;
      }

      const externalCandidates = data.items.flatMap((item): YouTubeTopComment[] => {
        const topLevelComment = item.snippet?.topLevelComment?.snippet;
        const id = item.snippet?.topLevelComment?.id ?? item.id;
        const text = topLevelComment?.textOriginal ?? topLevelComment?.textDisplay;
        if (id === undefined || text === undefined || text.trim().length === 0) {
          return [];
        }
        return [
          {
            id,
            text,
            publishedAt:
              topLevelComment?.publishedAt ?? new Date().toISOString(),
            author: topLevelComment?.authorDisplayName ?? 'Unknown',
            likeCount: topLevelComment?.likeCount ?? 0,
            videoId: topLevelComment?.videoId ?? videoId,
          },
        ];
      });
      return externalCandidates.sort((left, right) => right.likeCount - left.likeCount);
    } catch (error) {
      console.error(`YouTube API fetch comments error: ${error}`);
      return undefined;
    }
  }
}

const parseYtIdentifier = (rawUrl: string): string | undefined => {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    const match = rawUrl.match(
      /(?:youtu\.be\/|youtube\.com\/(?:embed\/|live\/|shorts\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{6,})/i
    );
    return match?.[1];
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'youtu.be') {
    return url.pathname.split('/').filter(Boolean)[0];
  }

  if (host !== 'youtube.com' && !host.endsWith('.youtube.com')) {
    return undefined;
  }

  const watchId = url.searchParams.get('v');
  if (watchId !== null && watchId.trim().length > 0) {
    return watchId.trim();
  }

  const parts = url.pathname.split('/').filter(Boolean);
  const prefix = parts[0]?.toLowerCase();
  if (prefix === 'embed' || prefix === 'live' || prefix === 'shorts' || prefix === 'v') {
    return parts[1];
  }

  return undefined;
};

export const extractYouTubeVideoId = (url: string | undefined): string | undefined => {
  if (!url) return undefined;
  return parseYtIdentifier(url);
};
