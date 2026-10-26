/** URL of a collection media file, authorised by the signed token from /api/review/*. */
export function mediaUrl(file: string, token: string): string {
  return `${window.location.origin}/api/media-file/${encodeURIComponent(file)}?t=${encodeURIComponent(token)}`;
}
