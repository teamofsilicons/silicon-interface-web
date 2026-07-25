export interface GifResult {
  id: string;
  title: string;
  pageUrl: string;
  previewUrl: string;
  stillUrl: string;
  width: number;
  height: number;
}

const API_BASE = "https://api.giphy.com/v1/gifs";
export const GIPHY_PAGE_SIZE = 24;

type GiphyImage = { url?: string; width?: string; height?: string };
type GiphyItem = {
  id?: string;
  title?: string;
  url?: string;
  images?: Record<string, GiphyImage | undefined>;
};

export function giphyConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_GIPHY_API_KEY?.trim());
}

export async function fetchGifs(
  query: string,
  signal?: AbortSignal,
  offset = 0,
): Promise<GifResult[]> {
  const apiKey = process.env.NEXT_PUBLIC_GIPHY_API_KEY?.trim();
  if (!apiKey) throw new Error("GIPHY is not configured");
  const trimmed = query.trim().slice(0, 50);
  const endpoint = trimmed ? `${API_BASE}/search` : `${API_BASE}/trending`;
  const params = new URLSearchParams({
    api_key: apiKey,
    limit: String(GIPHY_PAGE_SIZE),
    offset: String(Math.max(0, offset)),
    rating: "pg-13",
    bundle: "messaging_non_clips",
    remove_low_contrast: "true",
  });
  if (trimmed) params.set("q", trimmed);
  const response = await fetch(`${endpoint}?${params}`, { signal });
  if (!response.ok) throw new Error(`GIPHY request failed (${response.status})`);
  const payload = await response.json() as { data?: GiphyItem[] };
  return (payload.data ?? []).flatMap((item): GifResult[] => {
    const images = item.images ?? {};
    // The exact animated preview shown in the picker is also the rendition we
    // archive and send. Falling back to an original/downsized rendition here
    // made a click silently download and re-upload a much larger file than the
    // one the user had already seen.
    const preview = images.fixed_width_small ?? images.fixed_width;
    const still = images.fixed_width_small_still ?? images.fixed_width_still ?? preview;
    if (!item.id || !preview?.url) return [];
    return [{
      id: item.id,
      title: item.title?.trim() || "GIF",
      pageUrl: item.url || `https://giphy.com/gifs/${item.id}`,
      previewUrl: preview.url,
      stillUrl: still?.url || preview.url,
      width: Number(preview.width || 0),
      height: Number(preview.height || 0),
    }];
  });
}
