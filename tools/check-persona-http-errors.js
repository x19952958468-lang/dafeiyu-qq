import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createLoginServer } from '../src/bilibili/server.js';

async function fixture(t) {
  const calls = [], logs = [];
  const companion = Object.fromEntries(['status', 'friends', 'configure', 'createQr', 'pollQr', 'runNow'].map(name => [name, async () => { calls.push(name); return {}; }]));
  const personaEditor = Object.fromEntries(['state', 'save', 'backup'].map(name => [name, () => { calls.push('persona.' + name); return {}; }]));
  const server = createLoginServer({ companion, personaEditor, port: 0, log: text => logs.push(text) });
  const address = await server.start();
  t.after(() => server.stop());
  return { address, calls, logs };
}
function rawRequest(port, request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const chunks = [];
    socket.setTimeout(2000, () => socket.destroy(new Error('Probe timed out')));
    socket.on('connect', () => socket.write(request));
    socket.on('data', value => chunks.push(value));
    socket.on('error', reject);
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}
function parse(response) {
  const split = response.indexOf('\r\n\r\n');
  assert.ok(split > 0);
  const headers = response.slice(0, split), body = response.slice(split + 4);
  assert.match(headers, /Content-Type: application\/json; charset=utf-8/i);
  assert.equal(Number(headers.match(/Content-Length: (\d+)/i)[1]), Buffer.byteLength(body));
  return { headers, body: JSON.parse(body) };
}

test('malformed HTTP framing yields explanatory JSON without reaching persona save', async t => {
  const f = await fixture(t);
  const response = await rawRequest(f.address.port, `POST /api/persona HTTP/1.1\r\nHost: 127.0.0.1:${f.address.port}\r\nContent-Length: 2\r\nContent-Length: 3\r\nX-Private: DO_NOT_LOG_ME\r\n\r\n{}`);
  const result = parse(response);
  assert.match(result.headers, /^HTTP\/1.1 400 /);
  assert.equal(result.body.uncertain, true);
  assert.match(result.body.error, /保留草稿/);
  assert.deepEqual(f.calls, []);
  assert.ok(!f.logs.join('\n').includes('DO_NOT_LOG_ME'));
  assert.ok(!response.includes('DO_NOT_LOG_ME'));
  assert.ok(f.logs.some(line => line.includes('status=400')));
  assert.equal((await fetch(f.address.url + '/api/status')).status, 200);
});

test('oversized headers return JSON 431 rather than an empty body', async t => {
  const f = await fixture(t);
  const response = await rawRequest(f.address.port, `POST /api/persona HTTP/1.1\r\nHost: 127.0.0.1:${f.address.port}\r\nCookie: ${'s'.repeat(18000)}\r\nContent-Length: 2\r\n\r\n{}`);
  const result = parse(response);
  assert.match(result.headers, /^HTTP\/1.1 431 /);
  assert.equal(result.body.code, 'HPE_HEADER_OVERFLOW');
  assert.match(result.body.error, /请求头过大/);
  assert.deepEqual(f.calls, []);
  assert.ok(!f.logs.join('\n').includes('ssssssss'));
  assert.equal((await fetch(f.address.url + '/api/status')).status, 200);
});
