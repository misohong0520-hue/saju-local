export const source = 'https://yongyong.ai';
export const api = 'https://api.publicvoid.im';
export const mediaHosts = new Set([
  'media.yongyong.ai', 'cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com',
]);
export const allowedHosts = new Set(['yongyong.ai', 'api.publicvoid.im', ...mediaHosts]);
export const publicPage = /^(?:\/|\/(?:fortune|box|mypage|cs|terms|privacy|login|signup|signup2|checkout|payment|payments|manse|today|saju|reports|chatrooms|coupons|gifts|invite|event)(?:\/[a-z0-9-]+)*|\/bot\/\d+\/(?:intro|form|result|loading)|\/philosophy\/\d+(?:\/(?:intro|form))?)\/?$/;
const staticExtension = /\.(?:css|[cm]?js|jpe?g|png|webp|svg|avif|gif|ico|woff2?|ttf|otf|mp4|webm|mov|wav|mp3|m4a|m3u8|ts|lottie|json)$/i;
const publicApi = /^\/dragon\/(?:reviews\/public|bots(?:\/\d+)?|packages|free-events|store-review-event|daily-fortune\/(?:stats|ilju)|heart\/v2\/offers\/\d+)$/;

export function classify(url) {
  if (url.protocol !== 'https:' || url.username || url.password || !allowedHosts.has(url.host)) return null;
  if (url.origin === api) return publicApi.test(url.pathname) ? 'api' : null;
  if (url.origin === source) {
    if (publicPage.test(url.pathname)) return 'page';
    if (staticExtension.test(url.pathname)) return 'asset';
    return null;
  }
  return mediaHosts.has(url.host) ? 'asset' : null;
}

export function keyFor(url, kind = classify(url)) {
  if (kind === 'page') return url.origin + (url.pathname.replace(/\/$/, '') || '/');
  if (url.origin === source && url.pathname.startsWith('/_next/static/')) return url.origin + url.pathname;
  return url.href.split('#')[0];
}

export function imageSource(url) {
  if (url.origin !== source || url.pathname !== '/_next/image') return url;
  const image = url.searchParams.get('url');
  return image ? new URL(image, source) : url;
}
