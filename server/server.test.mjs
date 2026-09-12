import assert from 'node:assert';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import fetch from 'node-fetch';
import FormData from 'form-data';
import { createAsyncImageServer } from './server.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
let upstreamPosts = 0, editUploads = 0;
const upstream = http.createServer(async (req, res) => {
  if (req.method !== 'POST') { res.writeHead(404).end(); return; }
  upstreamPosts++;
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const requestBody = Buffer.concat(chunks);
  assert(requestBody.includes(Buffer.from('gpt-image-2')), '2.0 production model is forwarded upstream');
  assert(!requestBody.includes(Buffer.from('gpt-image-2.5-sunburst')), '2.5 test model is not used by the production backend');
  if (req.url.includes('/generations')) {
    const json = JSON.parse(requestBody.toString('utf8'));
    assert.equal(json.size, '2416x3424'); assert.equal(json.image_size, '4k'); assert.equal(json.aspect_ratio, '12:17');
  }
  if (req.url.includes('/edits')) { editUploads++; assert(requestBody.includes(Buffer.from('name="image"'))); }
  await new Promise(resolve => setTimeout(resolve, 80));
  const body = JSON.stringify({ data: [{ b64_json: png.toString('base64') }], points_used: 3 });
  res.writeHead(200, { 'Content-Type': 'application/json', 'X-Oneapi-Request-Id': 'mock-upstream-request', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const upstreamPort = upstream.address().port, dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'image-task-test-'));
const app = await createAsyncImageServer({ upstreamBase: `http://127.0.0.1:${upstreamPort}/v1`, dataDir, retentionMs: 60_000 });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}/api/image-tasks`, secret = 'test-secret-that-must-not-be-persisted';
const headers = { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() };

const [firstResponse, duplicateResponse] = await Promise.all([
  fetch(base + '/generations', { method: 'POST', headers, body: JSON.stringify({ prompt: '测试主题', size: '2416x3424', image_size: '4k', aspect_ratio: '12:17' }) }),
  fetch(base + '/generations', { method: 'POST', headers, body: JSON.stringify({ prompt: '测试主题', size: '2416x3424', image_size: '4k', aspect_ratio: '12:17' }) })
]);
const first = await firstResponse.json(), duplicate = await duplicateResponse.json();
assert.equal(first.id, duplicate.id, 'same idempotency key returns the same task');
let status;
for (let i = 0; i < 80; i++) {
  status = await (await fetch(base + '/' + first.id)).json();
  if (status.status === 'succeeded') break;
  await new Promise(resolve => setTimeout(resolve, 25));
}
assert.equal(status.status, 'succeeded'); assert.equal(status.points, 3); assert.equal(status.upstreamRequestId, 'mock-upstream-request');
assert.deepEqual(await (await fetch(`http://127.0.0.1:${app.server.address().port}${status.resultUrl}`)).buffer(), png);
assert.equal(upstreamPosts, 1, 'duplicate browser submission makes one billed upstream POST');

const form = new FormData(); form.append('prompt', '提取线稿'); form.append('size', '1024x1024'); form.append('image', png, { filename: 'source.png', contentType: 'image/png', knownLength: png.length });
const edit = await (await fetch(base + '/edits', { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Idempotency-Key': randomUUID() }, body: form })).json();
for (let i = 0; i < 80; i++) {
  status = await (await fetch(base + '/' + edit.id)).json();
  if (status.status === 'succeeded') break;
  await new Promise(resolve => setTimeout(resolve, 25));
}
assert.equal(status.status, 'succeeded'); assert.equal(upstreamPosts, 2); assert.equal(editUploads, 1);
const metadata = (await Promise.all((await fsp.readdir(path.join(dataDir, 'tasks'))).map(name => fsp.readFile(path.join(dataDir, 'tasks', name), 'utf8')))).join('\n');
assert(!metadata.includes(secret), 'customer key is never persisted');

await app.close(); await new Promise(resolve => upstream.close(resolve)); await fsp.rm(dataDir, { recursive: true, force: true });
console.log('Async server tests passed: idempotency, polling result, edit upload, and secret non-persistence.');
