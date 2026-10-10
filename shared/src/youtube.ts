const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
]);

export function isYouTubeVideoId(value: string): boolean {
  return VIDEO_ID_PATTERN.test(value);
}

export function extractYouTubeVideoId(input: string): string | null {
  const value = input.trim();
  if (isYouTubeVideoId(value)) return value;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    return null;

  let candidate: string | null = null;
  if (url.hostname === "youtu.be") {
    const pathSegments = url.pathname.split("/").filter(Boolean);
    if (pathSegments.length === 1) candidate = pathSegments[0];
  } else if (YOUTUBE_HOSTS.has(url.hostname)) {
    if (url.pathname === "/watch" || url.pathname === "/watch/") {
      candidate = url.searchParams.get("v");
    } else {
      const pathSegments = url.pathname.split("/").filter(Boolean);
      if (
        pathSegments.length === 2 &&
        ["embed", "shorts", "live"].includes(pathSegments[0])
      ) {
        candidate = pathSegments[1];
      }
    }
  }

  return candidate && isYouTubeVideoId(candidate) ? candidate : null;
}
