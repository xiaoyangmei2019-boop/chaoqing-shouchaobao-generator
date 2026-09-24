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
    assert(json.prompt && json.prompt.includes('测试主题'), 'server builds prompt from submitted params');
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
  fetch(base + '/generations', { method: 'POST', headers, body: JSON.stringify({ params: { subject: '测试主题', age: 'grade3_6', person: 'with', titleMode: 'none', smallText: 'none', textBoxes: '0', titleText: '', size: '1:1.4' }, size: '2416x3424', image_size: '4k', aspect_ratio: '12:17' }) }),
  fetch(base + '/generations', { method: 'POST', headers, body: JSON.stringify({ params: { subject: '测试主题', age: 'grade3_6', person: 'with', titleMode: 'none', smallText: 'none', textBoxes: '0', titleText: '', size: '1:1.4' }, size: '2416x3424', image_size: '4k', aspect_ratio: '12:17' }) })
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

const form = new FormData(); form.append('task_type', 'lineart'); form.append('size', '1024x1024'); form.append('image', png, { filename: 'source.png', contentType: 'image/png', knownLength: png.length });
const edit = await (await fetch(base + '/edits', { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Idempotency-Key': randomUUID() }, body: form })).json();
for (let i = 0; i < 80; i++) {
  status = await (await fetch(base + '/' + edit.id)).json();
  if (status.status === 'succeeded') break;
  await new Promise(resolve => setTimeout(resolve, 25));
}
assert.equal(status.status, 'succeeded'); assert.equal(upstreamPosts, 2); assert.equal(editUploads, 1);
const metadata = (await Promise.all((await fsp.readdir(path.join(dataDir, 'tasks'))).map(name => fsp.readFile(path.join(dataDir, 'tasks', name), 'utf8')))).join('\n');
assert(!metadata.includes(secret), 'customer key is never persisted');

// 非法尺寸：返回 400，且不调用上游（100 不是 16 的倍数）
const badSizeForm = new FormData(); badSizeForm.append('task_type', 'lineart'); badSizeForm.append('size', '100x100'); badSizeForm.append('image', png, { filename: 'source.png', contentType: 'image/png', knownLength: png.length });
const beforeBadSize = upstreamPosts;
const badSizeRes = await fetch(base + '/edits', { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Idempotency-Key': randomUUID() }, body: badSizeForm });
assert.equal(badSizeRes.status, 400, '非法尺寸返回 400');
assert.equal(upstreamPosts, beforeBadSize, '非法尺寸不调用上游');

// 未知 task_type：返回 400，且不调用上游
const badTypeForm = new FormData(); badTypeForm.append('task_type', 'foobar'); badTypeForm.append('image', png, { filename: 'source.png', contentType: 'image/png', knownLength: png.length });
const beforeBadType = upstreamPosts;
const badTypeRes = await fetch(base + '/edits', { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Idempotency-Key': randomUUID() }, body: badTypeForm });
assert.equal(badTypeRes.status, 400, '未知 task_type 返回 400');
assert.equal(upstreamPosts, beforeBadType, '未知 task_type 不调用上游');

// 并发预占：MAX_ACTIVE_TOTAL=2 时同时提交 10 个任务，最多 2 个 202，其余 429
const concDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'image-task-conc-'));
const concurrencyApp = await createAsyncImageServer({ upstreamBase: `http://127.0.0.1:${upstreamPort}/v1`, dataDir: concDataDir, retentionMs: 60_000, maxActiveTotal: 2 });
await new Promise(resolve => concurrencyApp.server.listen(0, '127.0.0.1', resolve));
const concBase = `http://127.0.0.1:${concurrencyApp.server.address().port}/api/image-tasks`;
const submissions = await Promise.all(Array.from({ length: 10 }, (_, i) => fetch(concBase + '/generations', { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ params: { subject: '测试主题并发' + i, age: 'grade3_6', person: 'with', titleMode: 'none', smallText: 'none', textBoxes: '0', titleText: '', size: '1:1.4' }, size: '2416x3424', image_size: '4k', aspect_ratio: '12:17' }) })));
const accepted = submissions.filter(r => r.status === 202).length;
const rejected = submissions.filter(r => r.status === 429).length;
assert.equal(accepted, 2, 'MAX_ACTIVE_TOTAL=2 时只接受 2 个任务');
assert.equal(rejected, 8, '其余 8 个任务返回 429');
await new Promise(resolve => setTimeout(resolve, 300));
await concurrencyApp.close(); await fsp.rm(concDataDir, { recursive: true, force: true });

await app.close(); await new Promise(resolve => upstream.close(resolve)); await fsp.rm(dataDir, { recursive: true, force: true });
console.log('Async server tests passed: idempotency, polling result, edit upload, secret non-persistence, size/type validation, and concurrency slot reservation.');
