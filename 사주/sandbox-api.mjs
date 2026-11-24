import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const requestHeaders = ['accept', 'accept-language', 'authorization', 'content-type', 'cookie', 'guestuid', 'idempotency-key', 'origin', 'x-csrf-token'];
const responseHeaders = ['content-type', 'content-disposition', 'retry-after', 'www-authenticate'];
const apiPath = /^\/dragon(?:\/[A-Za-z0-9._~%+@-]+)+\/?$/;
const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);
const productionHosts = new Set(['yongyong.ai', 'www.yongyong.ai', 'api.publicvoid.im']);

export function sandboxOrigin(value) {
  if (!value) return null;
  const url = new URL(value);
  const isLocal = url.protocol === 'http:' && loopback.has(url.hostname);
  if ((url.protocol !== 'https:' && !isLocal) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash ||
      productionHosts.has(url.hostname.replace(/\.$/, ''))) {
    throw new Error('YONGYONG_SANDBOX_API에는 독립 테스트 API의 HTTPS 오리진 또는 루프백 주소를 지정하세요.');
  }
  return url.origin;
}

export function sandboxWebOrigins(value = '') {
  return [...new Set(value.split(/\s+/).filter(Boolean).map((address) => {
    const url = new URL(address);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' ||
        url.search || url.hash || productionHosts.has(url.hostname.replace(/\.$/, ''))) {
      throw new Error('YONGYONG_SANDBOX_WEB_ORIGINS에는 승인된 테스트 HTTPS 오리진만 지정하세요.');
    }
    return url.origin;
  }))];
}

function scopedCookie(cookie, prefix) {
  const [pair, ...attributes] = cookie.split(';');
  const retained = attributes.filter((attribute) => !/^\s*(domain|path)=/i.test(attribute));
  return [pair, ...retained, ' Path=' + prefix + '/dragon'].join(';');
}

export async function forwardSandbox(request, response, target, origin, local, prefix, json) {
  const method = request.method;
  if (!methods.has(method) || !apiPath.test(target.pathname)) {
    request.resume();
    return json(response, method, 404, { detail: '지원하는 테스트 API 경로가 아닙니다.' });
  }
  if (request.headers['sec-fetch-site'] === 'cross-site' ||
      (request.headers.origin && request.headers.origin !== local)) {
    request.resume();
    return json(response, method, 403, { detail: '로컬 복제본에서 보낸 요청만 허용합니다.' });
  }
  const headers = new Headers();
  for (const name of requestHeaders) {
    const value = request.headers[name];
    if (typeof value === 'string') headers.set(name, value);
  }
  const controller = new AbortController();
  const onClose = () => controller.abort();
  response.once('close', onClose);
  const url = new URL(target.pathname + target.search, origin);
  try {
    const options = {
      method,
      headers,
      redirect: 'manual',
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]),
    };
    if (method !== 'GET' && method !== 'HEAD') {
      options.body = request;
      options.duplex = 'half';
    }
    const upstream = await fetch(url, options);
    const outgoing = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    for (const name of responseHeaders) {
      const value = upstream.headers.get(name);
      if (value) outgoing[name] = value;
    }
    const location = upstream.headers.get('location');
    if (location) {
      const redirect = new URL(location, url);
      if (redirect.origin === origin && apiPath.test(redirect.pathname)) {
        outgoing.Location = local + prefix + redirect.pathname + redirect.search + redirect.hash;
      } else if (redirect.protocol === 'https:' && !redirect.username && !redirect.password) {
        outgoing.Location = redirect.href;
      }
    }
    const cookies = upstream.headers.getSetCookie();
    if (cookies.length) outgoing['Set-Cookie'] = cookies.map((cookie) => scopedCookie(cookie, prefix));
    // The captured client reads ilj, while the current public response uses ilju.
    if (target.pathname === '/dragon/daily-fortune/ilju' && method === 'GET' &&
        upstream.ok && outgoing['content-type']?.includes('application/json')) {
      const data = await upstream.json();
      if (typeof data?.ilju === 'string' && data.ilj === undefined) data.ilj = data.ilju;
      response.writeHead(upstream.status, outgoing).end(JSON.stringify(data));
      return;
    }
    response.writeHead(upstream.status, outgoing);
    if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), response);
    else response.end();
  } catch {
    if (response.headersSent) response.destroy();
    else if (!response.destroyed) json(response, method, 502, { detail: '테스트 API에 연결할 수 없습니다.' });
  } finally {
    response.off('close', onClose);
  }
}
