import assert from 'node:assert';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import fetch from 'node-fetch';
import FormData from 'form-data';
import { createAsyncImageServer } from './server.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const jpeg = await fsp.readFile(new URL('./fixtures/output-test.jpg', import.meta.url));
let upstreamPosts = 0, editUploads = 0;
const forwardedModels = [];
const upstream = http.createServer(async (req, res) => {
  if (req.method !== 'POST') { res.writeHead(404).end(); return; }
  upstreamPosts++;
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const requestBody = Buffer.concat(chunks);
  let jpegRequested = false;
  if (req.url.includes('/generations')) {
    const json = JSON.parse(requestBody.toString('utf8'));
    assert(['gpt-image-2', 'gpt-image-2-official', 'gpt-image-2.5-sunburst'].includes(json.model), 'only allowed models may be forwarded');
    forwardedModels.push(json.model);
    jpegRequested = json.output_format === 'jpeg';
    assert.equal(json.output_compression, jpegRequested ? 95 : undefined);
    assert.equal(json.quality, 'high');
    assert.equal(json.size, '2416x3424'); assert.equal(json.image_size, '4k'); assert.equal(json.aspect_ratio, '12:17');
    assert(json.prompt && json.prompt.includes('测试主题'), 'server builds prompt from submitted params');
  }
  if (req.url.includes('/edits')) {
    editUploads++; assert(requestBody.includes(Buffer.from('name="image"')));
    const multipart = requestBody.toString('latin1');
    const model = multipart.match(/name="model"\r\n\r\n([^\r\n]+)/)?.[1];
    assert(model, 'multipart model field is present');
    forwardedModels.push(model);
    jpegRequested = /name="output_format"\r\n\r\njpeg\r\n/.test(multipart);
    assert.equal(/name="output_compression"\r\n\r\n95\r\n/.test(multipart), jpegRequested);
  }
  await new Promise(resolve => setTimeout(resolve, 80));
  const body = JSON.stringify({ data: [{ b64_json: (jpegRequested ? jpeg : png).toString('base64') }], points_used: 3 });
  res.writeHead(200, { 'Content-Type': 'application/json', 'X-Oneapi-Request-Id': 'mock-upstream-request', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const upstreamPort = upstream.address().port, dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'image-task-test-'));
const adminSecret = 'test-admin-credential-only';
const app = await createAsyncImageServer({ adminKeyHash: createHash('sha256').update(adminSecret).digest('hex'), upstreamBase: `http://127.0.0.1:${upstreamPort}/v1`, dataDir, retentionMs: 60_000 });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}/api/image-tasks`, secret = 'test-secret-that-must-not-be-persisted';
const headers = { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() };

function rawPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: 'POST',
      headers: { ...headers, 'Content-Length': body.length }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, data, text });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

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
assert.equal(forwardedModels[0], 'gpt-image-2', 'old clients default to route one');

const form = new FormData(); form.append('task_type', 'lineart'); form.append('size', '1024x1024'); form.append('image', png, { filename: 'source.png', contentType: 'image/png', knownLength: png.length });
const edit = await (await fetch(base + '/edits', { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Idempotency-Key': randomUUID() }, body: form })).json();
for (let i = 0; i < 80; i++) {
  status = await (await fetch(base + '/' + edit.id)).json();
  if (status.status === 'succeeded') break;
  await new Promise(resolve => setTimeout(resolve, 25));
}
assert.equal(forwardedModels[forwardedModels.length - 1], 'gpt-image-2', 'PNG line art keeps the original model');
assert.equal(status.status, 'succeeded'); assert.equal(upstreamPosts, 2); assert.equal(editUploads, 1);
const metadata = (await Promise.all((await fsp.readdir(path.join(dataDir, 'tasks'))).map(name => fsp.readFile(path.join(dataDir, 'tasks', name), 'utf8')))).join('\n');
assert(!metadata.includes(secret), 'customer key is never persisted');

// 手机网络中断导致 multipart 缺少结束边界：返回可安全重试的 408，且不调用上游。
const truncatedBoundary = '----mobile-truncated-upload';
const truncatedBody = Buffer.from([
  `--${truncatedBoundary}`,
  'Content-Disposition: form-data; name="task_type"',
  '',
  'lineart'
].join('\r\n'));
const beforeTruncated = upstreamPosts, recoveredRequestId = randomUUID();
const truncatedResult = await rawPost(base + '/edits', {
  Authorization: `Bearer ${secret}`,
  'Idempotency-Key': recoveredRequestId,
  'Content-Type': `multipart/form-data; boundary=${truncatedBoundary}`
}, truncatedBody);
assert.equal(truncatedResult.status, 408, '上传被截断时返回 408');
assert.equal(truncatedResult.data?.retryable, true, '上传被截断时明确允许客户端安全补传');
assert.equal(upstreamPosts, beforeTruncated, '上传被截断时不创建上游计费请求');

// 部分手机 WebView 会使用 LF-only 的 multipart 头；完整表单应由兼容解析器接收。
const mobileBoundary = '----mobile-webview-lf-only';
const mobileBody = Buffer.concat([
  Buffer.from([
    `--${mobileBoundary}`,
    'Content-Disposition: form-data; name="task_type"',
    '',
    'lineart',
    `--${mobileBoundary}`,
    'Content-Disposition: form-data; name="size"',
    '',
    '1024x1024',
    `--${mobileBoundary}`,
    'Content-Disposition: form-data; name="image"; filename="mobile.png"',
    'Content-Type: image/png',
    '',
    ''
  ].join('\n')),
  png,
  Buffer.from(`\n--${mobileBoundary}--\n`)
]);
const mobileResult = await rawPost(base + '/edits', {
  Authorization: `Bearer ${secret}`,
  'Idempotency-Key': recoveredRequestId,
  'Content-Type': `multipart/form-data; boundary=${mobileBoundary}`
}, mobileBody);
assert.equal(mobileResult.status, 202, `手机兼容表单应被接受：${mobileResult.text}`);
for (let i = 0; i < 80; i++) {
  status = await (await fetch(base + '/' + mobileResult.data.id)).json();
  if (status.status === 'succeeded') break;
  await new Promise(resolve => setTimeout(resolve, 25));
}
assert.equal(status.status, 'succeeded', '手机兼容表单任务成功');
assert.equal(upstreamPosts, 3, '手机兼容表单只产生一次上游请求');
assert.equal(editUploads, 2, '手机兼容表单图片被正确转发');

// A lost response/replayed recovery must return the original task, without another charge.
const mobileReplay = await rawPost(base + '/edits', {
  Authorization: `Bearer ${secret}`,
  'Idempotency-Key': recoveredRequestId,
  'Content-Type': `multipart/form-data; boundary=${mobileBoundary}`
}, mobileBody);
assert.equal(mobileReplay.data.id, mobileResult.data.id);
assert.equal(upstreamPosts, 3, '补传后重复提交不能创建第二次上游请求');

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

// JPEG generation and editing preserve the returned bytes and Content-Type.
const jpgParams = { subject: '测试主题JPG', age: 'grade3_6', person: 'with', titleMode: 'none', smallText: 'none', textBoxes: '0', titleText: '', size: '1:1.4' };
for (const route of ['line1', 'line2']) for (const mode of ['generation', 'lineart', 'edit', 'reference']) {
  let body, requestHeaders = { Authorization: `Bearer ${secret}`, 'Idempotency-Key': randomUUID() };
  if (mode === 'generation') {
    requestHeaders['Content-Type'] = 'application/json';
    body = JSON.stringify({ route, params: jpgParams, output_format: 'jpeg', model: 'gpt-image-2.5-sunburst' });
  } else {
    body = new FormData(); body.append('route', route); body.append('model', mode === 'edit' ? 'gpt-image-2' : 'gpt-image-2.5-sunburst'); body.append('task_type', mode); body.append('output_format', 'jpeg');
    body.append('size', '1024x1024'); body.append('instruction', '保留画面');
    for (const [key, value] of Object.entries(jpgParams)) if (key !== 'size') body.append(key, value);
    body.append('image', jpeg, { filename: 'source.jpg', contentType: 'image/jpeg' });
  }
  const submittedResponse = await fetch(base + (mode === 'generation' ? '/generations' : '/edits'), { method: 'POST', headers: requestHeaders, body });
  assert.equal(submittedResponse.status, 202);
  const submitted = await submittedResponse.json();
  for (let i = 0; i < 80; i++) {
    status = await (await fetch(base + '/' + submitted.id)).json();
    if (status.status === 'succeeded' || status.status === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(status.status, 'succeeded', mode);
  assert.equal(forwardedModels[forwardedModels.length - 1], mode === 'edit' ? 'gpt-image-2.5-sunburst' : route === 'line2' ? 'gpt-image-2-official' : 'gpt-image-2', route + ':' + mode + ' uses its server-selected model regardless of the frontend model field');
  const result = await fetch(`http://127.0.0.1:${app.server.address().port}${status.resultUrl}`);
  assert.equal(result.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(await result.buffer(), jpeg);
}
const beforeBadFormat = upstreamPosts;
const badFormat = await fetch(base + '/generations', {
  method: 'POST', headers: { ...headers, 'Idempotency-Key': randomUUID() },
  body: JSON.stringify({ params: jpgParams, output_format: 'gif' })
});
assert.equal(badFormat.status, 400); assert.equal(upstreamPosts, beforeBadFormat);

// Reject unknown routes before making any billed upstream request.
const beforeInvalidRoute = upstreamPosts;
for (const type of ['generation', 'lineart']) {
  const body = type === 'generation' ? JSON.stringify({ params: jpgParams, route: 'unknown' }) : new FormData();
  if (type !== 'generation') {
    body.append('task_type', type); body.append('route', 'unknown');
    body.append('image', png, { filename: 'source.png', contentType: 'image/png' });
  }
  const res = await fetch(base + (type === 'generation' ? '/generations' : '/edits'), {
    method: 'POST', body, headers: { Authorization: `Bearer ${secret}`, 'Idempotency-Key': randomUUID(), ...(type === 'generation' ? { 'Content-Type': 'application/json' } : {}) }
  });
  assert.equal(res.status, 400);
}
assert.equal(upstreamPosts, beforeInvalidRoute);

// Admin capability is key-bound and ordinary credentials cannot forge a model override.
for (const [key, expected] of [[secret, false], [adminSecret, true], ['', false]]) {
  const access = await (await fetch(base + '/admin-access', { headers: { Authorization: `Bearer ${key}` } })).json();
  assert.equal(access.admin, expected);
  assert.equal(access.models.length, expected ? 3 : 0);
  assert.deepEqual(access.prices, expected ? { 'gpt-image-2': 0.3, 'gpt-image-2-official': 0.8, 'gpt-image-2.5-sunburst': 0.3 } : {});
  assert(!JSON.stringify(access).includes(adminSecret));
}
for (const mode of ['generation', 'lineart', 'reference', 'edit']) for (const model of ['gpt-image-2', 'gpt-image-2-official', 'gpt-image-2.5-sunburst']) {
  let body;
  const requestHeaders = { Authorization: `Bearer ${adminSecret}`, 'Idempotency-Key': randomUUID() };
  if (mode === 'generation') {
    requestHeaders['Content-Type'] = 'application/json'; body = JSON.stringify({ params: jpgParams, route: 'line1', admin_model: model });
  } else {
    body = new FormData(); body.append('task_type', mode); body.append('admin_model', model);
    body.append('instruction', '管理员修改测试'); body.append('size', '1024x1024');
    for (const [key, value] of Object.entries(jpgParams)) if (key !== 'size') body.append(key, value);
    body.append('image', png, { filename: 'source.png', contentType: 'image/png' });
  }
  const result = await fetch(base + (mode === 'generation' ? '/generations' : '/edits'), { method: 'POST', body, headers: requestHeaders });
  assert.equal(result.status, 202); const task = await result.json();
  for (let i = 0; i < 80; i++) {
    status = await (await fetch(base + '/' + task.id)).json();
    if (['succeeded', 'failed'].includes(status.status)) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(status.status, 'succeeded');
  assert.equal(forwardedModels[forwardedModels.length - 1], mode === 'edit' ? 'gpt-image-2.5-sunburst' : model);
}
const beforeUnauthorized = upstreamPosts;
for (const mode of ['generation', 'lineart']) {
  const requestHeaders = { Authorization: `Bearer ${secret}`, 'Idempotency-Key': randomUUID() };
  let body;
  if (mode === 'generation') {
    requestHeaders['Content-Type'] = 'application/json'; body = JSON.stringify({ params: jpgParams, admin_model: 'gpt-image-2.5-sunburst' });
  } else {
    body = new FormData(); body.append('task_type', mode); body.append('admin_model', 'gpt-image-2.5-sunburst');
    body.append('image', png, { filename: 'source.png', contentType: 'image/png' });
  }
  assert.equal((await fetch(base + (mode === 'generation' ? '/generations' : '/edits'), { method: 'POST', headers: requestHeaders, body })).status, 403);
}
const invalidAdminModel = await fetch(base + '/generations', { method: 'POST', headers: { ...headers, Authorization: `Bearer ${adminSecret}`, 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ params: jpgParams, admin_model: 'invalid-model' }) });
assert.equal(invalidAdminModel.status, 400); assert.equal(upstreamPosts, beforeUnauthorized);
const adminMetadata = (await Promise.all((await fsp.readdir(path.join(dataDir, 'tasks'))).map(name => fsp.readFile(path.join(dataDir, 'tasks', name), 'utf8')))).join('');
assert(!adminMetadata.includes(adminSecret), 'admin credential must not be persisted with tasks');

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
console.log('Async server tests passed: idempotency, polling result, edit upload, mobile multipart recovery, truncated upload safety, secret non-persistence, size/type/format validation, JPEG generation and editing, two-route selection and edit-only Sunburst model routing, administrator authorization and model overrides, and concurrency slot reservation.');
