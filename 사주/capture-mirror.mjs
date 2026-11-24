import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { api, classify, imageSource, keyFor, source } from './mirror-policy.mjs';

const folder = 'mirror-data';
const blobs = join(folder, 'files');
const manifestPath = join(folder, 'index.json');
const profile = JSON.parse(await readFile(new URL('./mirror-observed.json', import.meta.url), 'utf8'));
const entries = Object.create(null);
const queued = new Set();
const queue = [];
const missing = [];
const maxAssetBytes = 32 * 1024 * 1024;
const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

try {
  Object.assign(entries, JSON.parse(await readFile(manifestPath, 'utf8')).entries);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await mkdir(blobs, { recursive: true });

function normalize(value) {
  return value.trim().replaceAll('&amp;', '&').replace(/\\u0026/gi, '&').replace(/\\\//g, '/')
    .replace(/(?:&quot;|&#x27;|&)+$/, '');
}

function add(value, base = source) {
  let url;
  try {
    url = imageSource(new URL(normalize(value), base));
  } catch {
    return;
  }
  const kind = classify(url);
  if (!kind) return;
  const key = keyFor(url, kind);
  if (queued.has(key)) return;
  queued.add(key);
  queue.push({ url: new URL(key), key, kind });
}

function discover(html, url, isPage) {
  if (isPage) {
    for (const match of html.matchAll(/\b(?:src|href|poster|data-src)\s*=\s*["']([^"']+)["']/gi)) {
      add(match[1], url);
    }
    for (const match of html.matchAll(/\b(?:srcset|imagesrcset)\s*=\s*["']([^"']+)["']/gi)) {
      for (const item of match[1].split(/,\s+/)) add(item.trim().split(/\s+/)[0], url);
    }
  }
  for (const match of html.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) add(match[1], url);
  for (const match of html.matchAll(/https:\/\/(?:media\.yongyong\.ai|cdn\.jsdelivr\.net|fonts\.(?:googleapis|gstatic)\.com)\/[^<>"'\\\s()]+/g)) {
    add(match[0], url);
  }
  for (const match of html.matchAll(/["'](\/[\w./%+@-]+\.(?:webp|avif|jpe?g|png|svg|gif|woff2?|mp4|webm))["']/gi)) {
    add(match[1], source);
  }
  for (const match of html.matchAll(/(?:^|["'])\/?_next\/static\/[^"'<>\s,\\]+\.(?:js|css)/g)) {
    add('/' + match[0].replace(/^["'/]+/, ''), source);
  }
  if (isPage) {
    for (const match of html.matchAll(/(?:\\?["'])((?:\/bot\/\d+\/(?:form|intro)|\/philosophy\/\d+)(?:\/(?:intro|form))?)(?=[?\\'"])/g)) {
      add(match[1], source);
    }
  }
}

async function readLimited(response) {
  const size = Number(response.headers.get('content-length'));
  if (size > maxAssetBytes) {
    await response.body?.cancel();
    throw new Error('asset exceeds 32 MiB');
  }
  const parts = [];
  let bytes = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxAssetBytes) throw new Error('asset exceeds 32 MiB');
      parts.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(parts, bytes);
}

async function fetchAsset(url, kind) {
  for (let redirects = 0; redirects < 4; redirects += 1) {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
      headers: {
        'User-Agent': userAgent,
        'Accept-Language': 'ko-KR,ko;q=0.9',
        Accept: kind === 'page' ? 'text/html,application/xhtml+xml' : '*/*',
      },
    });
    const redirect = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !redirect) return response;
    await response.body?.cancel();
    url = new URL(redirect, url);
    if (!classify(url)) throw new Error('redirect outside public capture scope');
  }
  throw new Error('too many redirects');
}

async function capture({ url, key, kind }) {
  try {
    let entry = entries[key];
    let body;
    if (entry) {
      if (kind === 'page' || /(?:css|javascript)/.test(entry.type)) body = await readFile(join(blobs, entry.file));
    } else {
      const response = await fetchAsset(url, kind);
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('HTTP ' + response.status);
      }
      const type = response.headers.get('content-type') ?? 'application/octet-stream';
      if (kind === 'asset' && type.includes('text/html')) {
        await response.body?.cancel();
        throw new Error('asset returned HTML');
      }
      body = await readLimited(response);
      const file = createHash('sha256').update(body).digest('hex');
      await writeFile(join(blobs, file), body);
      entry = entries[key] = { file, type, bytes: body.length };
    }
    if (body && (kind === 'page' || /(?:css|javascript)/.test(entry.type))) {
      discover(body.toString('utf8'), url, kind === 'page');
    }
  } catch (error) {
    missing.push({ url: key, reason: error.message });
  }
}

for (const page of profile.pages) {
  add(page);
  const match = /^\/bot\/(\d+)\/intro$/.exec(page);
  if (match) {
    add('/bot/' + match[1] + '/form');
    add(api + '/dragon/bots/' + match[1]);
  }
}
for (const asset of profile.assets) add(asset);
for (const value of process.argv.slice(2)) {
  if (value.startsWith('@')) {
    for (const candidate of JSON.parse(await readFile(value.slice(1), 'utf8'))) add(candidate);
  } else {
    add(value);
  }
}
add(api + '/dragon/reviews/public?min_rating=5&limit=200');

for (let offset = 0; offset < queue.length;) {
  const batch = queue.slice(offset, offset + 10);
  await Promise.all(batch.map(capture));
  offset += batch.length;
  if (offset % 1000 === 0) console.log('Checked', offset, 'of', queue.length, 'discovered URLs');
}

const sorted = Object.fromEntries(Object.entries(entries).sort(([left], [right]) => left.localeCompare(right)));
await writeFile(manifestPath, JSON.stringify({ source, entries: sorted, missing }, null, 2) + '\n');
console.log('Saved', Object.keys(entries).length, 'responses and recorded', missing.length, 'unavailable URLs.');
