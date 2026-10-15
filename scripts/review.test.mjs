import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const root = new URL('../', import.meta.url);
const api = fs.readFileSync(new URL('src/api.js', root), 'utf8');
const classify = vm.runInNewContext(api.slice(api.indexOf('function classifyError(')) + '\nclassifyError');
for (const [message, type] of [
  ['insufficient balance', 'balance'], ['HTTP 429', 'busy'], ['HTTP 503', 'server'],
  ['invalid api key', 'key'], ['model not found', 'model'], ['content_policy', 'content'],
  ['403 密钥无权限或余额不足', 'balance'], ['原图已清理或无法读取', 'unknown'],
  ['请填写客户密钥', 'unknown'], ['图片宽度为 1500', 'unknown'],
  ['无法连接自己的异步后台：timeout。幂等编号保护', 'unknown'],
  ['生图请求发生超时；当前客户端 timeout=0，正常情况下不会主动超时', 'unknown'],
  ['图片已在后台生成，但浏览器无法下载返回图片（HTTP 503）', 'unknown']
]) {
  const result = classify(message);
  assert.equal(result.type, type, message);
  if (type === 'unknown') assert.equal(result.detail, message);
}
const server = fs.readFileSync(new URL('server/server.mjs', root), 'utf8');
const parse = vm.runInNewContext(server.slice(server.indexOf('function uploadFormError('), server.indexOf('async function requestFormData(')) + '\nparseCompleteMultipartFallback', { Buffer });
const boundary = 'test-boundary';
const payload = Buffer.from('binary--test-boundaryX\n--test-boundaryX\nend');
for (const newline of ['\n', '\r\n']) {
  const body = Buffer.concat([
    Buffer.from(`--${boundary}${newline}Content-Disposition: form-data; name="image"; filename="a.png"\r\nContent-Type: image/png\n\n`),
    payload, Buffer.from(`${newline}--${boundary}--${newline}`)
  ]);
  const result = parse(body, `multipart/form-data; boundary="${boundary}"`, 4096);
  assert.equal(result.files.length, 1);
  assert.deepEqual(result.files[0].buffer, payload);
}
assert.throws(() => parse(Buffer.from(`--${boundary}\ninvalid--${boundary}--`), `multipart/form-data; boundary=${boundary}`, 4096), error => error.statusCode === 408);
const oversized = Buffer.from(`--${boundary}\nContent-Disposition: form-data; name="field"\n\n${'x'.repeat(1024 * 1024 + 1)}\n--${boundary}--\n`);
assert.throws(() => parse(oversized, `multipart/form-data; boundary=${boundary}`, oversized.length), error => error.statusCode === 400);
console.log('Review regression tests passed: error classification, mixed multipart headers, binary boundaries, truncated uploads, field limits.');
