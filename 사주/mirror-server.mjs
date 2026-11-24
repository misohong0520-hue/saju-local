import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { allowedHosts, api, imageSource, keyFor, mediaHosts, source } from './mirror-policy.mjs';
import { forwardSandbox, sandboxOrigin, sandboxWebOrigins } from './sandbox-api.mjs';
import { dailyIlju } from './daily-ilju.mjs';
import { createReportService } from './local-reports.mjs';
import { localReportPage } from './local-report-page.mjs';

const port = Number(process.env.PORT ?? 4173);
const local = 'http://127.0.0.1:' + port;
const folder = new URL('./mirror-data/', import.meta.url);
const { entries, missing } = JSON.parse(await readFile(new URL('index.json', folder), 'utf8'));
const guests = new Map();
const sandbox = sandboxOrigin(process.env.YONGYONG_SANDBOX_API);
if (sandbox === local) throw new Error('테스트 API는 복제본과 다른 포트에서 실행해야 합니다.');
const sandboxWeb = sandbox ? sandboxWebOrigins(process.env.YONGYONG_SANDBOX_WEB_ORIGINS) : [];
const vendorSources = sandboxWeb.length ? ' ' + sandboxWeb.join(' ') : '';
const contentPolicy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:" + vendorSources,
  "style-src 'self' 'unsafe-inline'" + vendorSources,
  "font-src 'self' data:" + vendorSources,
  "img-src 'self' data: blob:" + vendorSources,
  "media-src 'self' data: blob:",
  "connect-src 'self'" + vendorSources,
  "frame-src 'self'" + vendorSources,
  "form-action 'self'" + vendorSources,
  "frame-ancestors 'none'",
  "base-uri 'self'",
].join('; ');
const rewritableHosts = [...mediaHosts, new URL(api).host].map((host) => host.replaceAll('.', '\\.')).join('|');
const origins = new RegExp('https://(' + rewritableHosts + ')(?=[/"\\x27\\s?#]|$)', 'g');
const ownOrigin = /https:\/\/yongyong\.ai(?=[/"'\s?#]|$)/g;
const mirrorPath = '/__asset/';
const apiPrefix = mirrorPath + new URL(api).host;
const textTypes = /(?:text\/html|text\/css|(?:java|ecma)script|application\/json|application\/(?:vnd\.apple|x)-mpegurl)/i;
const reportScript = '<link rel="stylesheet" href="/__local/report.css"><script defer src="/__local/report.js"></script>';
const reportAssets = new Map([
  ['/__local/report.css', ['local-report.css', 'text/css']],
  ['/__local/report.js', ['local-report.js', 'text/javascript']],
]);

async function botInfo(id) {
  if (!Number.isSafeInteger(id)) return null;
  const entry = entries[api + '/dragon/bots/' + id];
  return entry ? JSON.parse(await readFile(new URL('files/' + entry.file, folder), 'utf8')) : null;
}
const reportService = createReportService(folder, local, botInfo, json);

function upstream(url) {
  if (!url.pathname.startsWith(mirrorPath)) return new URL(url.pathname + url.search, source);
  const [host, ...path] = url.pathname.slice(mirrorPath.length).split('/');
  if (!allowedHosts.has(host)) return null;
  return new URL('https://' + host + '/' + path.join('/') + url.search);
}

function resolveEntry(url) {
  const original = imageSource(url);
  const decoded = original.origin === local || original.pathname.startsWith(mirrorPath)
    ? upstream(original)
    : original;
  if (!decoded) return null;
  const key = keyFor(decoded);
  return entries[key] ?? entries[decoded.origin + decoded.pathname];
}

function localized(text) {
  return text.replace(ownOrigin, local).replace(origins, (_origin, host) => local + mirrorPath + host);
}

function json(response, method, status, data) {
  const body = JSON.stringify(data);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(method === 'HEAD' ? undefined : body);
}

function guestReply(method, path, response) {
  if ((method === 'GET' || method === 'HEAD') && path === '/dragon/daily-fortune/ilju') {
    json(response, method, 200, dailyIlju());
    return true;
  }
  if (method === 'POST' && path === '/dragon/guests/register') {
    const guest = { guest_uid: randomUUID() };
    guests.set(guest.guest_uid, guest);
    json(response, method, 200, guest);
    return true;
  }
  if (method === 'GET' && /^\/dragon\/guests\/[a-f\d-]{36}$/.test(path)) {
    const guest = guests.get(path.split('/').at(-1));
    json(response, method, guest ? 200 : 404, guest ?? { detail: '게스트를 찾을 수 없습니다.' });
    return true;
  }
  if (method === 'POST' && ['/dragon/experiments/assignments', '/dragon/events/batch'].includes(path)) {
    response.req.resume();
    json(response, method, 200, {});
    return true;
  }
  if (method === 'POST' && path === '/dragon/fortune-events') {
    response.req.resume();
    json(response, method, 200, { accepted: [] });
    return true;
  }
  if (method === 'GET' && ['/dragon/reports/my/list', '/dragon/chat/chatrooms/my/list'].includes(path)) {
    json(response, method, 200, []);
    return true;
  }
  if (method === 'GET' && path === '/dragon/saju-profiles' && !response.req.headers.authorization) {
    const guest = guests.has(response.req.headers.guestuid);
    json(response, method, guest ? 200 : 400, guest ? [] : { detail: '인증 정보가 필요합니다.' });
    return true;
  }
  return false;
}

function rangeBounds(header, bytes) {
  const range = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  if (!range || (!range[1] && !range[2])) return null;
  const start = range[1] ? Number(range[1]) : Math.max(0, bytes - Number(range[2]));
  const end = range[1] && range[2] ? Math.min(bytes - 1, Number(range[2])) : bytes - 1;
  return start <= end ? { start, end } : null;
}

async function sendEntry(request, response, entry) {
  if (!/^[a-f\d]{64}$/.test(entry.file)) throw new Error('Invalid snapshot file name');
  const file = new URL('files/' + entry.file, folder);
  const headers = {
    'Content-Type': entry.type,
    'Cache-Control': entry.type.includes('text/html') ? 'no-store' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  };
  if (textTypes.test(entry.type)) {
    let text = localized(await readFile(file, 'utf8'));
    if (!sandbox && entry.type.includes('text/html')) text = text.replace('</head>', reportScript + '</head>');
    const body = Buffer.from(text);
    headers['Content-Length'] = body.length;
    if (entry.type.includes('text/html')) headers['Content-Security-Policy'] = contentPolicy;
    response.writeHead(200, headers).end(request.method === 'HEAD' ? undefined : body);
    return;
  }
  const bounds = rangeBounds(request.headers.range, entry.bytes);
  if (request.headers.range && !bounds) {
    response.writeHead(416, { 'Content-Range': 'bytes */' + entry.bytes }).end();
    return;
  }
  headers['Accept-Ranges'] = 'bytes';
  headers['Content-Length'] = bounds ? bounds.end - bounds.start + 1 : entry.bytes;
  if (bounds) headers['Content-Range'] = 'bytes ' + bounds.start + '-' + bounds.end + '/' + entry.bytes;
  response.writeHead(bounds ? 206 : 200, headers);
  if (request.method === 'HEAD') return response.end();
  createReadStream(file, bounds ?? {}).on('error', () => response.destroy()).pipe(response);
}

async function route(request, response) {
  if (!request.url?.startsWith('/') || request.url.startsWith('//')) {
    response.writeHead(400).end();
    return;
  }
  const url = new URL(request.url, local);
  const method = request.method;
  if (/^\/__local\/reports(?:\/[a-f0-9-]{36})?$/.test(url.pathname)) {
    return reportService(request, response, url);
  }
  if (method === 'GET' && reportAssets.has(url.pathname)) {
    const [file, type] = reportAssets.get(url.pathname);
    response.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'X-Content-Type-Options': 'nosniff' })
      .end(await readFile(new URL('./public/' + file, import.meta.url)));
    return;
  }
  if (method === 'GET' && /^\/local-reports(?:\/(?:new|[a-f0-9-]{36}))?$/.test(url.pathname)) {
    const creation = url.pathname === '/local-reports/new';
    const bot = creation ? await botInfo(Number(url.searchParams.get('bot'))) : null;
    if (creation && !bot) return json(response, method, 404, { detail: '이 상품의 로컬 리포트를 찾을 수 없습니다.' });
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': contentPolicy,
      'Cache-Control': 'no-store' }).end(localReportPage(bot, url.pathname === '/local-reports'));
    return;
  }
  if (method === 'GET' && url.pathname === '/__mirror/status') {
    json(response, method, 200, { source, responses: Object.keys(entries).length, unavailable: missing.length,
      apiMode: sandbox ? 'sandbox' : 'offline' });
    return;
  }
  const target = upstream(url);
  if (!target) return json(response, method, 404, { detail: '저장된 자산이 없습니다.' });
  if (target.origin === api && sandbox) return forwardSandbox(request, response, target, sandbox, local, apiPrefix, json);
  if (target.origin === api && guestReply(method, target.pathname, response)) return;
  if (method !== 'GET' && method !== 'HEAD') {
    request.resume();
    json(response, method, 405, { detail: '이 로컬 복제본에는 운영 서비스 요청이 연결되어 있지 않습니다.' });
    return;
  }
  const entry = resolveEntry(target);
  if (entry) return sendEntry(request, response, entry);
  if (process.env.MIRROR_DEBUG === '1') console.log('Missing snapshot:', target.origin + target.pathname);
  if (target.origin === api) {
    json(response, method, 503, { detail: '이 로컬 복제본에는 이 기능에 필요한 백엔드가 연결되어 있지 않습니다.' });
    return;
  }
  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('저장된 페이지 또는 자산이 없습니다.');
}

createServer((request, response) => {
  route(request, response).catch((error) => {
    console.error(error.message);
    if (response.headersSent) response.destroy();
    else response.writeHead(500).end();
  });
}).listen(port, '127.0.0.1', () => console.log('용용사주 로컬 복제본 · ' + local));
