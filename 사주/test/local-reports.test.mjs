import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createReportService, generateReport } from '../local-reports.mjs';

test('uses the inputs without copying names, birth dates, or free text into the report', () => {
  assert.equal(generateReport({ birth_date: '2024-02-30' }, '테스트'), null);
  const report = generateReport({
    birth_date: '1999-01-01', name: '개인 이름', question: '비밀 이직 고민',
  }, '연애사주');
  assert.match(report.sections[0].text, /일주는/);
  assert.match(report.sections.at(-1).text, /배우는 것/);
  assert.doesNotMatch(JSON.stringify(report), /1999-01-01|개인 이름|비밀/);
});

test('creates a persistent report and scopes it to the browser cookie', async (t) => {
  const directory = pathToFileURL(await mkdtemp(join(tmpdir(), 'yongyong-reports-test-')) + sep);
  const server = createServer((req, res) => {
    handler(req, res, new URL(req.url, base)).catch(() => res.writeHead(500).end());
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true });
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const buildHandler = () => createReportService(directory, base,
    (id) => id === 880058 ? { id, name: '연애사주' } : null,
    (res, _method, status, payload) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload)));
  let handler = buildHandler();
  const url = base + '/__local/reports';
  const created = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ bot_id: 880058, input_json: { birth_date: '1999-01-01' } }),
  });
  assert.equal(created.status, 201);
  const cookie = created.headers.get('set-cookie').split(';')[0];
  const result = await created.json();
  assert.equal(result.title, '연애사주');
  handler = buildHandler();
  assert.deepEqual(await (await fetch(url + '/' + result.id, { headers: { Cookie: cookie } })).json(), result);
  assert.equal((await fetch(url + '/' + result.id)).status, 404);
  assert.deepEqual(await (await fetch(url)).json(), []);
});
