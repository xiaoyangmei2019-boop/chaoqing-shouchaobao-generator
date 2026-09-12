import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import fetch from 'node-fetch';
import FormData from 'form-data';
import Busboy from 'busboy';
import AbortController from 'abort-controller';

const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { ...jsonHeaders, 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function safeMessage(error) { return String(error?.message || error || '未知错误').slice(0, 1200); }
function requestOrigin(req) {
  const protocol = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  return `${protocol}://${req.headers.host}`;
}
function clientIp(req) { return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim(); }
function bearer(req) {
  const value = String(req.headers.authorization || '');
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}
function detectImage(buffer, hinted = '') {
  if (buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { mime: 'image/png', ext: 'png' };
  if (buffer[0] === 255 && buffer[1] === 216) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  if (hinted.includes('jpeg')) return { mime: 'image/jpeg', ext: 'jpg' };
  if (hinted.includes('webp')) return { mime: 'image/webp', ext: 'webp' };
  return { mime: 'image/png', ext: 'png' };
}
function findImagePayload(value, depth = 0) {
  if (!value || depth > 9) return null;
  if (typeof value === 'object') {
    if (value.b64_json || value.b64 || value.image_url || value.url) return value;
    for (const child of Object.values(value)) { const found = findImagePayload(child, depth + 1); if (found) return found; }
  }
  return null;
}
async function readJson(req, limit) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('请求内容过大'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('JSON格式无效'), { statusCode: 400 }); }
}
async function requestFormData(req, limit) {
  const length = Number(req.headers['content-length'] || 0);
  if (length > limit) throw Object.assign(new Error('上传图片总大小超过限制'), { statusCode: 413 });
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('上传图片总大小超过限制'), { statusCode: 413 });
    chunks.push(chunk);
  }
  // Node 14 has no global Request/FormData and no Readable.toWeb(). Parse the
  // already size-bounded multipart body with Busboy, then forward fresh form
  // data with the Node 14 compatible form-data package.
  return await new Promise((resolve, reject) => {
    let parser;
    try { parser = Busboy({ headers: req.headers, limits: { files: 10, fields: 50, fileSize: limit } }); }
    catch { reject(Object.assign(new Error('图片表单格式无效'), { statusCode: 400 })); return; }
    const fields = new Map(), files = []; let parseError = null;
    parser.on('field', (name, value) => fields.set(name, value));
    parser.on('file', (name, stream, info) => {
      const parts = [];
      stream.on('data', chunk => parts.push(chunk));
      stream.on('limit', () => { parseError = Object.assign(new Error('上传图片总大小超过限制'), { statusCode: 413 }); });
      stream.on('end', () => files.push({ name, buffer: Buffer.concat(parts), filename: info.filename || 'image.png', mimeType: info.mimeType || 'application/octet-stream' }));
    });
    parser.on('filesLimit', () => { parseError = Object.assign(new Error('图片数量不能超过10张'), { statusCode: 400 }); });
    parser.on('error', () => reject(Object.assign(new Error('图片表单格式无效'), { statusCode: 400 })));
    parser.on('finish', () => parseError ? reject(parseError) : resolve({ fields, files }));
    parser.end(Buffer.concat(chunks));
  });
}
function publicTask(task) {
  return {
    id: task.id,
    clientRequestId: task.clientRequestId,
    type: task.type,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    upstreamRequestId: task.upstreamRequestId || null,
    points: task.points || 0,
    error: task.error || null,
    resultUrl: task.status === 'succeeded' ? `/api/image-tasks/${task.id}/result` : null
  };
}

export async function createAsyncImageServer(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.IMAGE_TASK_DATA_DIR || path.join(here, 'data'));
  const taskDir = path.join(dataDir, 'tasks'), resultDir = path.join(dataDir, 'results');
  const upstreamBase = String(options.upstreamBase || process.env.UPSTREAM_IMAGE_BASE || 'https://vip.aittco.com/v1').replace(/\/$/, '');
  const upstreamModel = String(options.upstreamModel || process.env.UPSTREAM_IMAGE_MODEL || 'gpt-image-2');
  const allowedOrigin = String(options.allowedOrigin || process.env.FRONTEND_ORIGIN || '').replace(/\/$/, '');
  const retentionMs = Number(options.retentionMs || process.env.TASK_RETENTION_MS || 24 * 60 * 60 * 1000);
  const maxActivePerIp = Number(options.maxActivePerIp || process.env.MAX_ACTIVE_PER_IP || 4);
  const maxActiveTotal = Number(options.maxActiveTotal || process.env.MAX_ACTIVE_TOTAL || 12);
  const maxUploadBytes = Number(options.maxUploadBytes || process.env.MAX_UPLOAD_BYTES || 64 * 1024 * 1024);
  const tasks = new Map(), byClientRequest = new Map(), activeByIp = new Map(), submissionLocks = new Map();
  let activeTotal = 0;
  await Promise.all([fsp.mkdir(taskDir, { recursive: true }), fsp.mkdir(resultDir, { recursive: true })]);

  async function persist(task) {
    const target = path.join(taskDir, `${task.id}.json`), temp = target + '.tmp';
    const safe = { ...task }; delete safe.resultBuffer; delete safe.apiKey;
    await fsp.writeFile(temp, JSON.stringify(safe), { mode: 0o600 });
    await fsp.rename(temp, target);
  }
  async function load() {
    for (const name of await fsp.readdir(taskDir).catch(() => [])) {
      if (!name.endsWith('.json')) continue;
      try {
        const task = JSON.parse(await fsp.readFile(path.join(taskDir, name), 'utf8'));
        if (!task?.id || !task.clientRequestId) continue;
        if (task.status === 'queued' || task.status === 'running') {
          task.status = 'failed'; task.updatedAt = Date.now();
          task.error = '异步服务器在任务执行期间重启，无法确认上游结果。请先核对中转扣费记录，不要立即重复提交。';
          await persist(task);
        }
        tasks.set(task.id, task); byClientRequest.set(task.clientRequestId, task.id);
      } catch (error) { console.warn('忽略损坏的任务记录：', name, safeMessage(error)); }
    }
  }
  await load();

  async function downloadResult(url) {
    let last;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const response = await fetch(url, { redirect: 'follow' });
        if (!response.ok) throw new Error(`图片下载HTTP ${response.status}`);
        const buffer = await response.buffer();
        if (!buffer.length) throw new Error('图片下载结果为空');
        return { buffer, contentType: response.headers.get('content-type') || '' };
      } catch (error) { last = error; await sleep(800 * (attempt + 1)); }
    }
    throw new Error(`上游已生成图片，但服务器下载结果失败：${safeMessage(last)}`);
  }
  async function decodeUpstream(response, task) {
    task.upstreamRequestId = response.headers.get('x-oneapi-request-id') || response.headers.get('x-request-id') || '';
    const type = String(response.headers.get('content-type') || '').toLowerCase();
    if (type.startsWith('image/')) {
      if (!response.ok) throw new Error(`上游返回HTTP ${response.status}`);
      return { buffer: await response.buffer(), contentType: type };
    }
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    if (!response.ok) throw new Error(data?.error?.message || data?.message || text.slice(0, 500) || `上游返回HTTP ${response.status}`);
    if (!data) throw new Error('上游返回的JSON不完整或无法解析');
    task.points = Number(data.points_used ?? data.credits_used ?? 0) || 0;
    const image = findImagePayload(data);
    if (!image) throw new Error('上游返回成功，但没有找到图片数据');
    const raw = image.b64_json || image.b64;
    if (raw) {
      const clean = String(raw).replace(/^data:image\/[^;,]+;base64,/i, '');
      const buffer = Buffer.from(clean, 'base64');
      if (!buffer.length) throw new Error('上游返回的Base64图片为空');
      return { buffer, contentType: '' };
    }
    return downloadResult(image.url || image.image_url);
  }
  async function callUpstream(task, apiKey, request) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20 * 60 * 1000);
    try {
      const response = await fetch(upstreamBase + (task.type === 'generation' ? '/images/generations' : '/images/edits'), {
        method: 'POST',
        headers: task.type === 'generation' ? { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` } : { ...request.getHeaders(), Authorization: `Bearer ${apiKey}` },
        body: task.type === 'generation' ? JSON.stringify(request) : request,
        signal: controller.signal
      });
      return await decodeUpstream(response, task);
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('上游生图超过20分钟，后台已停止等待；请核对中转记录');
      throw error;
    } finally { clearTimeout(timer); }
  }
  async function execute(task, apiKey, upstreamRequest, ip) {
    task.status = 'running'; task.updatedAt = Date.now(); await persist(task);
    try {
      // The billed upstream POST is deliberately executed exactly once.
      const result = await callUpstream(task, apiKey, upstreamRequest);
      const image = detectImage(result.buffer, result.contentType);
      const file = `${task.id}.${image.ext}`;
      await fsp.writeFile(path.join(resultDir, file), result.buffer, { mode: 0o600 });
      task.status = 'succeeded'; task.resultFile = file; task.mimeType = image.mime; task.bytes = result.buffer.length; task.error = '';
    } catch (error) {
      task.status = 'failed'; task.error = safeMessage(error);
    } finally {
      task.updatedAt = Date.now(); await persist(task);
      activeTotal = Math.max(0, activeTotal - 1);
      activeByIp.set(ip, Math.max(0, (activeByIp.get(ip) || 1) - 1));
    }
  }
  async function accept(req, res, type) {
    const apiKey = bearer(req), idempotency = String(req.headers['idempotency-key'] || '').trim();
    if (!apiKey) return sendJson(res, 401, { error: '缺少客户密钥' });
    if (!/^[A-Za-z0-9_.:-]{8,160}$/.test(idempotency)) return sendJson(res, 400, { error: '缺少有效的任务幂等编号' });
    const previous = submissionLocks.get(idempotency);
    if (previous) await previous;
    let existingId = byClientRequest.get(idempotency);
    if (existingId && tasks.has(existingId)) return sendJson(res, 200, publicTask(tasks.get(existingId)));
    let releaseLock;
    const lock = new Promise(resolve => { releaseLock = resolve; });
    submissionLocks.set(idempotency, lock);
    try {
      existingId = byClientRequest.get(idempotency);
      if (existingId && tasks.has(existingId)) return sendJson(res, 200, publicTask(tasks.get(existingId)));
      const ip = clientIp(req);
      if (activeTotal >= maxActiveTotal || (activeByIp.get(ip) || 0) >= maxActivePerIp) return sendJson(res, 429, { error: '后台同时处理的任务过多，请稍后再试' });

      let upstreamRequest;
      if (type === 'generation') {
        const body = await readJson(req, 2 * 1024 * 1024);
        if (!String(body.prompt || '').trim()) return sendJson(res, 400, { error: '提示词不能为空' });
        const aspectRatio = body.aspect_ratio === '17:12' ? '17:12' : '12:17';
        upstreamRequest = {
          model: upstreamModel,
          prompt: String(body.prompt).slice(0, 100000),
          size: aspectRatio === '17:12' ? '3424x2416' : '2416x3424',
          image_size: '4k',
          aspect_ratio: aspectRatio,
          quality: 'high', output_format: 'png', moderation: 'auto', n: 1, response_format: 'b64_json'
        };
      } else {
        const incoming = await requestFormData(req, maxUploadBytes), outgoing = new FormData();
        const prompt = String(incoming.fields.get('prompt') || '').trim();
        if (!prompt) return sendJson(res, 400, { error: '图片修改提示词不能为空' });
        outgoing.append('model', upstreamModel); outgoing.append('prompt', prompt.slice(0, 100000));
        outgoing.append('size', String(incoming.fields.get('size') || '2416x3424'));
        const aspectRatio = String(incoming.fields.get('aspect_ratio') || '');
        if (['12:17','17:12'].includes(aspectRatio)) { outgoing.append('image_size', '4k'); outgoing.append('aspect_ratio', aspectRatio); }
        outgoing.append('quality', 'high'); outgoing.append('output_format', 'png'); outgoing.append('n', '1'); outgoing.append('response_format', 'b64_json');
        let images = 0;
        for (const file of incoming.files) {
          if (!['image','image[]'].includes(file.name)) continue;
          if (!String(file.mimeType || '').startsWith('image/')) return sendJson(res, 400, { error: '只允许上传图片文件' });
          outgoing.append(file.name, file.buffer, { filename: file.filename || `image-${images + 1}.png`, contentType: file.mimeType, knownLength: file.buffer.length }); images++;
        }
        if (!images || images > 10) return sendJson(res, 400, { error: '图片数量必须为1至10张' });
        upstreamRequest = outgoing;
      }

      const now = Date.now(), task = { id: randomUUID(), clientRequestId: idempotency, type, status: 'queued', createdAt: now, updatedAt: now, points: 0, upstreamRequestId: '', error: '' };
      tasks.set(task.id, task); byClientRequest.set(idempotency, task.id);
      await persist(task);
      activeTotal++; activeByIp.set(ip, (activeByIp.get(ip) || 0) + 1);
      sendJson(res, 202, publicTask(task));
      setImmediate(() => execute(task, apiKey, upstreamRequest, ip).catch(error => console.error('任务执行异常：', task.id, safeMessage(error))));
    } finally {
      if (submissionLocks.get(idempotency) === lock) submissionLocks.delete(idempotency);
      releaseLock();
    }
  }
  async function cleanup() {
    const cutoff = Date.now() - retentionMs;
    for (const task of tasks.values()) {
      if (task.updatedAt >= cutoff || task.status === 'queued' || task.status === 'running') continue;
      tasks.delete(task.id); byClientRequest.delete(task.clientRequestId);
      await Promise.all([
        fsp.unlink(path.join(taskDir, `${task.id}.json`)).catch(() => {}),
        task.resultFile ? fsp.unlink(path.join(resultDir, task.resultFile)).catch(() => {}) : Promise.resolve()
      ]);
    }
  }
  const cleanupTimer = setInterval(() => cleanup().catch(console.warn), 60 * 60 * 1000); cleanupTimer.unref();

  const server = http.createServer(async (req, res) => {
    try {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      const origin = String(req.headers.origin || '').replace(/\/$/, ''), expectedOrigin = allowedOrigin || requestOrigin(req);
      if (origin && origin !== expectedOrigin) return sendJson(res, 403, { error: '不允许的网页来源' });
      const url = new URL(req.url, requestOrigin(req));
      if (req.method === 'GET' && url.pathname === '/api/image-tasks/health') return sendJson(res, 200, { ok: true, active: activeTotal });
      if (req.method === 'POST' && url.pathname === '/api/image-tasks/generations') return await accept(req, res, 'generation');
      if (req.method === 'POST' && url.pathname === '/api/image-tasks/edits') return await accept(req, res, 'edit');
      const match = url.pathname.match(/^\/api\/image-tasks\/([0-9a-f-]{36})(\/result)?$/i);
      if (req.method === 'GET' && match) {
        const task = tasks.get(match[1]);
        if (!task) return sendJson(res, 404, { error: '任务不存在或已过期' });
        if (!match[2]) return sendJson(res, 200, publicTask(task));
        if (task.status !== 'succeeded' || !task.resultFile) return sendJson(res, 409, { error: '图片结果尚未就绪', status: task.status });
        const file = path.join(resultDir, task.resultFile), stat = await fsp.stat(file);
        res.writeHead(200, { 'Content-Type': task.mimeType || 'image/png', 'Content-Length': stat.size, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
        fs.createReadStream(file).pipe(res); return;
      }
      sendJson(res, 404, { error: '接口不存在' });
    } catch (error) { sendJson(res, error?.statusCode || 500, { error: safeMessage(error) }); }
  });
  server.on('close', () => clearInterval(cleanupTimer));
  return { server, tasks, close: () => new Promise(resolve => server.close(resolve)) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3366), host = process.env.HOST || '127.0.0.1';
  const app = await createAsyncImageServer();
  app.server.listen(port, host, () => console.log(`异步图片任务服务已启动：http://${host}:${port}`));
}
