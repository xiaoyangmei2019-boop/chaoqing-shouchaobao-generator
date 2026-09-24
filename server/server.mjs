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

// ===== 私有固定提示词（只在服务端保存，不再下发到前端）=====
const HIDDEN_STYLE = [
  '动漫马克笔手绘风，儿童主题画风格，高饱和度鲜艳明亮配色。必须先用黑色勾线笔起稿，人物、文字和所有主体都有清晰明显黑色轮廓线与内部细节线。线条有自然抖动和粗细变化，不机械平滑，有明显手绘痕迹。不要水彩感，不要厚涂感，不要无轮廓插画风，不要贴纸风，不要矢量扁平设计感。在线稿基础用马克笔平涂上色，色块分明，颜色高饱和度鲜艳明亮，可见有轻微马克笔触和少量叠色痕迹，避免电脑矢量图般过度机械平滑，但画面必须保持画面元素边缘清晰。',
  '造型可爱，保留轻微不对称和自然变形，局部比例可以适当夸张，轮廓略歪但结构清晰，不要工业化标准造型。画面紧凑饱满，主体突出，使用少量大造型相关元素进行点缀，不使用零散细碎小元素。主体元素之间有前后穿插、遮挡和叠压关系，层次丰富，避免平铺堆砌，让画面丰富但不杂乱。可弱化真实地面与天空，可用浅蓝和浅色形成包裹主体的背景层次感。',
  '如果有人物出现，必须是中国人物形象，表情阳光生动，具有儿童动漫插画气质。'
];
const AGE_RULES = {
  grade1_2: '低龄儿童绘画风格，Q版比例夸张，人物头大身小，造型简单可爱，主体清晰，色彩鲜艳，减少复杂细节',
  grade3_6: '儿童动漫插画风，Q版可爱但不过度幼龄化，结构完整，细节适中，空间层次清楚，具有一定设计感',
  junior: '少年插画风，比例自然，造型更加成熟，空间关系合理，构图有设计感，细节丰富，具有艺术表现力'
};
const TITLE_RULES = {
  round: '标题使用粗体马克笔手写艺术字，标题字不要太大，并与画面元素形成自然遮挡关系，注意文字能遮挡画面元素，画面元素不要遮挡文字。笔画厚实饱满，夸张变形，潦草可爱，手写感强，不要印刷字体、矢量感、打印质感、过直过匀线条、过度规整对称和设计稿式精确。',
  hard: '标题文字采用儿童主题画手绘艺术字风格，标题字不要太大，并与画面元素形成自然遮挡关系，注意文字能遮挡画面元素，画面元素不要遮挡文字。字体粗壮厚实，饱满有力，转折处明显，有方折和尖角感，外轮廓有清晰黑色粗描边，内部使用高饱和度颜色平涂填充，具有自然手绘痕迹和轻微不规则感，不要圆润卡通字体、标准印刷字体、电脑矢量字体。'
};
const LINE_ART_PROMPT = '请根据原图生成简化的动漫风格黑白线稿，不是完整照搬，而是进行干净清晰的线稿化重绘。保留原图的整体构图、主体位置、人物动态、主要物体外形和基本识别特征，保持原图比例。只保留大轮廓、关键结构和必要内部线条，主动省略花纹、纹理、装饰线和不必要小细节，整体简洁清爽，留白充足，适合儿童涂色、SVG转换或绘图仪输出。人物只保留外轮廓、五官、发型、主要发饰、大块服装结构和少量褶皱线。场景和物体只保留主要外轮廓、基本结构和少量内部线条。如有文字：保留的文字改为镂空描边线稿字；删除的文字只删除字形本身，注意只删除小字，不能删除大标题，不删除文字底框、标题牌、文本框、分隔线、卷轴结构和原有版式，框内留白。线条要求纯黑色线条、纯白色背景、无灰度、无阴影、无颜色、无渐变、无杂线、无脏边。全图不得出现任何实心黑色填充，所有封闭区域内部保持白色。';

// 根据用户选项 + 主题拼接完整提示词。前端只提交原始参数，不再接触任何风格词。
function buildPrompt(p, hasReferences = false) {
  const parts = [
    `主体：${p.subject}。`,
    AGE_RULES[p.age] || '',
    HIDDEN_STYLE.join('\n')
  ];
  parts.push(p.person === 'with' ? '画面中必须出现中国人物形象，表情阳光生动。' : '画面中不能出现人物。');
  if (p.titleMode !== 'none') parts.push(`标题文字：${p.titleText || '根据主题自动生成简短中文标题'}。${TITLE_RULES[p.titleMode] || ''}`);
  else parts.push('画面不要标题。');
  if (p.smallText === 'none') parts.push('除了指定标题外，不要出现任何中文、英文、拼音、数字、小字、标志、水印或乱码。');
  if (+p.textBoxes) parts.push(`画面中包含${p.textBoxes}个留白清晰、与构图融合的文本框。`);
  parts.push(p.size === '1.4:1' ? '画布必须采用标准A4横版比例进行构图，重要内容完整保留在画布安全区域内。' : '画布必须采用标准A4竖版比例进行构图，重要内容完整保留在画布安全区域内。');
  parts.push('整体氛围明亮、童趣、生动，主体突出，画面完整。');
  if (hasReferences) parts.push('引用参考图中的元素进行设计。');
  return parts.join('\n');
}

// ===== 前端参数白名单：浏览器传来的参数不可信，逐一校验，非法直接 400，避免绕过页面直接调接口 =====
const ALLOWED = Object.freeze({
  age: new Set(['grade1_2', 'grade3_6', 'junior']),
  person: new Set(['with', 'without']),
  titleMode: new Set(['none', 'round', 'hard']),
  smallText: new Set(['none', 'allow']),
  textBoxes: new Set(['0', '1', '2', '3', '4']),
  size: new Set(['1:1.4', '1.4:1'])
});
const badParam = message => Object.assign(new Error(message), { statusCode: 400 });
function validateParams(params) {
  const subject = String(params.subject || '').trim();
  if (!subject) throw badParam('主题内容不能为空');
  if (subject.length > 500) throw badParam('主题内容不能超过500字');
  const age = String(params.age || 'grade3_6');
  if (!ALLOWED.age.has(age)) throw badParam('年龄风格参数非法');
  const person = String(params.person || 'with');
  if (!ALLOWED.person.has(person)) throw badParam('人物设置参数非法');
  const titleMode = String(params.titleMode || 'none');
  if (!ALLOWED.titleMode.has(titleMode)) throw badParam('标题类型参数非法');
  const smallText = String(params.smallText || 'none');
  if (!ALLOWED.smallText.has(smallText)) throw badParam('小字设置参数非法');
  const textBoxes = String(params.textBoxes || '0');
  if (!ALLOWED.textBoxes.has(textBoxes)) throw badParam('文本框数量参数非法');
  const titleText = String(params.titleText || '').trim();
  if (titleText.length > 30) throw badParam('标题文字不能超过30字');
  const size = String(params.size || '1:1.4');
  if (!ALLOWED.size.has(size)) throw badParam('图片方向参数非法');
  return { subject, age, person, titleMode, smallText, textBoxes, titleText, size };
}
// 校验图片尺寸：必须为 宽x高、正整数、16 倍数，且总像素在允许范围内。非法直接 400，不调用上游。
function validateSize(value) {
  const m = /^(\d+)x(\d+)$/.exec(String(value || '').trim());
  if (!m) throw badParam('尺寸格式必须为 宽x高');
  const width = Number(m[1]), height = Number(m[2]);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 16 || height < 16) throw badParam('尺寸宽高必须是正整数');
  if (width % 16 !== 0 || height % 16 !== 0) throw badParam('尺寸宽高必须是16的倍数');
  const pixels = width * height;
  if (pixels < 655360 || pixels > 8294400) throw badParam('尺寸总像素超出允许范围（655360～8294400）');
  return `${width}x${height}`;
}

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
  throw new Error('无法识别的图片格式，图片数据可能已损坏');
}
// 严格校验上游返回的 Base64：非法字符、长度、解码结果都必须通过，避免损坏数据被误存为图片文件。
function strictBase64ToBuffer(input) {
  const clean = String(input).replace(/^data:[^;,]+;base64,/i, '').replace(/\s+/g, '');
  if (!clean) throw new Error('图片Base64为空');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new Error('图片Base64包含非法字符');
  if (clean.length % 4 === 1) throw new Error('图片Base64长度异常');
  const padded = clean + '='.repeat((4 - clean.length % 4) % 4);
  const buffer = Buffer.from(padded, 'base64');
  if (!buffer.length) throw new Error('图片Base64解码失败');
  return buffer;
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
      const buffer = strictBase64ToBuffer(raw);
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
      task.updatedAt = Date.now();
      // 状态保存失败也不能影响名额释放，否则后台会永久处于满载状态。
      try { await persist(task); } catch (error) { console.warn('任务状态保存失败：', task.id, safeMessage(error)); }
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
    let releaseLock, ip = '', slotTaken = false;
    const lock = new Promise(resolve => { releaseLock = resolve; });
    submissionLocks.set(idempotency, lock);
    try {
      existingId = byClientRequest.get(idempotency);
      if (existingId && tasks.has(existingId)) return sendJson(res, 200, publicTask(tasks.get(existingId)));
      ip = clientIp(req);
      if (activeTotal >= maxActiveTotal || (activeByIp.get(ip) || 0) >= maxActivePerIp) return sendJson(res, 429, { error: '后台同时处理的任务过多，请稍后再试' });
      // 并发检查通过后立即预占名额，防止多个请求在读取/解析阶段同时绕过限制；若后续失败，在 finally 中释放。
      activeTotal++;
      activeByIp.set(ip, (activeByIp.get(ip) || 0) + 1);
      slotTaken = true;

      let upstreamRequest;
      if (type === 'generation') {
        const body = await readJson(req, 2 * 1024 * 1024);
        const params = validateParams(body.params || {});
        const aspectRatio = params.size === '1.4:1' ? '17:12' : '12:17';
        upstreamRequest = {
          model: upstreamModel,
          prompt: buildPrompt(params, false).slice(0, 100000),
          size: aspectRatio === '17:12' ? '3424x2416' : '2416x3424',
          image_size: '4k',
          aspect_ratio: aspectRatio,
          quality: 'high', output_format: 'png', moderation: 'auto', n: 1, response_format: 'b64_json'
        };
      } else {
        const incoming = await requestFormData(req, maxUploadBytes), outgoing = new FormData();
        const taskType = String(incoming.fields.get('task_type') || '');
        if (!['lineart', 'edit', 'reference'].includes(taskType)) return sendJson(res, 400, { error: '未知的任务类型' });
        let prompt;
        if (taskType === 'lineart') {
          prompt = LINE_ART_PROMPT;
        } else if (taskType === 'reference') {
          const params = validateParams({
            subject: String(incoming.fields.get('subject') || ''),
            age: String(incoming.fields.get('age') || 'grade3_6'),
            person: String(incoming.fields.get('person') || 'with'),
            titleMode: String(incoming.fields.get('titleMode') || 'none'),
            smallText: String(incoming.fields.get('smallText') || 'none'),
            textBoxes: String(incoming.fields.get('textBoxes') || '0'),
            titleText: String(incoming.fields.get('titleText') || ''),
            size: String(incoming.fields.get('aspect_ratio') || '') === '17:12' ? '1.4:1' : '1:1.4'
          });
          prompt = buildPrompt(params, true);
        } else {
          const instruction = String(incoming.fields.get('instruction') || '').trim();
          if (!instruction) return sendJson(res, 400, { error: '图片修改要求不能为空' });
          if (instruction.length > 500) return sendJson(res, 400, { error: '图片修改要求不能超过500字' });
          prompt = `请根据原图进行修改。严格保持原图的画面比例、整体构图和未要求修改的内容，只执行以下修改要求：\n${instruction}`;
        }
        outgoing.append('model', upstreamModel); outgoing.append('prompt', prompt.slice(0, 100000));
        outgoing.append('size', validateSize(incoming.fields.get('size') || '2416x3424'));
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
      slotTaken = false; // 名额已转移给 execute 的 finally 释放
      sendJson(res, 202, publicTask(task));
      setImmediate(() => execute(task, apiKey, upstreamRequest, ip).catch(error => console.error('任务执行异常：', task.id, safeMessage(error))));
    } finally {
      if (slotTaken) {
        activeTotal = Math.max(0, activeTotal - 1);
        activeByIp.set(ip, Math.max(0, (activeByIp.get(ip) || 1) - 1));
      }
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
