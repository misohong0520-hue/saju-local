import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { dailyIlju } from '../daily-ilju.mjs';
import { forwardSandbox, sandboxOrigin } from '../sandbox-api.mjs';

async function serve(t, handler) {
  const server = createServer(handler).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return 'http://127.0.0.1:' + server.address().port;
}

function json(response, method, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(method === 'HEAD' ? undefined : JSON.stringify(body));
}

test('reproduces the public ilju response across Seoul midnight', () => {
  assert.deepEqual(dailyIlju(new Date('2026-11-23T15:00:00Z')), {
    date: '20261124', gan: '壬', ji: '寅', ilju: '임인', ilj: '임인',
  });
  assert.deepEqual(dailyIlju(new Date('2026-11-23T14:59:59Z')), {
    date: '20261123', gan: '辛', ji: '丑', ilju: '신축', ilj: '신축',
  });
});

test('limits API configuration to trusted sandbox origins', () => {
  assert.equal(sandboxOrigin('http://127.0.0.1:5000'), 'http://127.0.0.1:5000');
  assert.equal(sandboxOrigin('https://stage.example.com'), 'https://stage.example.com');
  for (const value of ['https://api.publicvoid.im', 'http://stage.example.com', 'https://stage.example.com/dragon']) {
    assert.throws(() => sandboxOrigin(value));
  }
});

test('forwards request bodies, status, SSE and scoped cookies to the original client', async (t) => {
  let calls = 0;
  const upstream = await serve(t, async (request, response) => {
    calls += 1;
    if (request.url === '/dragon/daily-fortune/ilju') {
      json(response, request.method, 200, { ilju: '을묘' });
      return;
    }
    if (request.url === '/dragon/redirect') {
      response.writeHead(307, { Location: '/dragon/reports/my/list' }).end();
      return;
    }
    if (request.url === '/dragon/stream') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end('data: complete\n\n');
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    response.setHeader('Set-Cookie', 'session=test; Domain=example.com; Path=/; HttpOnly; SameSite=Lax');
    json(response, request.method, 201, {
      url: request.url, method: request.method, guest: request.headers.guestuid, token: request.headers.authorization, body,
    });
  });
  const prefix = '/__asset/api.publicvoid.im';
  const local = await serve(t, (request, response) =>
    forwardSandbox(request, response, new URL(request.url.slice(prefix.length), upstream), upstream, local, prefix, json));
  const base = local + prefix;
  const created = await fetch(base + '/dragon/reports?locale=ko', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', GuestUid: 'test-guest', Authorization: 'Bearer test-token', Origin: local },
    body: '{"bot_id":880058}',
  });
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), {
    url: '/dragon/reports?locale=ko', method: 'POST', guest: 'test-guest', token: 'Bearer test-token', body: '{"bot_id":880058}',
  });
  assert.equal(created.headers.get('set-cookie'), 'session=test; HttpOnly; SameSite=Lax; Path=' + prefix + '/dragon');
  const stream = await fetch(base + '/dragon/stream');
  assert.deepEqual(await (await fetch(base + '/dragon/daily-fortune/ilju')).json(), { ilju: '을묘', ilj: '을묘' });
  assert.equal(stream.headers.get('content-type'), 'text/event-stream');
  assert.equal(await stream.text(), 'data: complete\n\n');
  const redirect = await fetch(base + '/dragon/redirect', { redirect: 'manual' });
  assert.equal(redirect.status, 307);
  assert.equal(redirect.headers.get('location'), base + '/dragon/reports/my/list');
  assert.equal((await fetch(base + '/dragon/reports', { headers: { Origin: 'https://unrelated.example' } })).status, 403);
  assert.equal(calls, 4);
});
