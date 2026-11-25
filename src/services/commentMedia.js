// Inspect known media containers only, never author profiles or arbitrary text URLs.
const mediaContainers = [
  'high_resolution_url', 'mid_resolution_url', 'low_resolution_url',
  'origin_url', 'crop_url', 'display_image', 'origin_url_list', 'image_url',
  'url_list', 'download_url_list', 'url', 'download_url'
];

function mediaUrls(value, depth = 0) {
  if (depth > 8 || !value) return [];
  if (typeof value === 'string') {
    try {
      const url = new URL(value);
      return ['https:', 'http:'].includes(url.protocol) ? [value] : [];
    } catch { return []; }
  }
  if (Array.isArray(value)) return value.flatMap(item => mediaUrls(item, depth + 1));
  if (typeof value !== 'object') return [];
  return mediaContainers.flatMap(key => mediaUrls(value[key], depth + 1));
}

function preferPortablePhotos(urls) {
  // Prefer explicit JPEG/PNG/WebP alternatives over CDN-negotiated .image URLs.
  const portable = url => /\.(jpe?g|png|webp)$/i.test(new URL(url).pathname) ? 0 : 1;
  return urls.sort((a, b) => portable(a) - portable(b));
}

export function detectCommentMedia(comment) {
  const result = (candidates, type, isAnimated = false) => {
    const urls = [...new Set(candidates)];
    return { hasMedia: urls.length > 0, url: urls[0] || null, urls, type, isAnimated, commentText: comment.text || '' };
  };
  const stickers = [comment.cmt_sticker_struct, comment.sticker, comment.sticker_info,
    comment.interaction_sticker, ...(Array.isArray(comment.stickers) ? comment.stickers : [])];
  for (const sticker of stickers) {
    if (!sticker) continue;
    const animated = [...mediaUrls(sticker.animated_url), ...mediaUrls(sticker.animate_url)];
    if (animated.length) return result(animated, 'sticker_animated', true);
    const still = [...mediaUrls(sticker.static_url), ...mediaUrls(sticker)];
    if (still.length) return result(still, 'sticker_static');
  }
  for (const list of [comment.images, comment.image_list]) {
    // Alternates must refer to the same photo, not a different attachment.
    for (const image of Array.isArray(list) ? list : list ? [list] : []) {
      const urls = preferPortablePhotos(mediaUrls(image));
      if (urls.length) return result(urls, 'photo');
    }
  }
  const indicated = stickers.some(Boolean) || comment.images?.length || comment.image_list?.length || [3, 17].includes(Number(comment.content_type));
  return result([], indicated ? 'unsupported_media' : 'media_unavailable');
}
