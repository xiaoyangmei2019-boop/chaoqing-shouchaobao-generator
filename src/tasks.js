// A shared task lifecycle keeps four entry points consistent and makes a future server adapter local.
const runningTasks = new Map(), retryLocks = new Set(), localLocks = new Set();
const newId = () => crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random();
const PRINT_RATIO = 17 / 12;
// Match the gateway's own 4K custom-ratio calculation. 12:17 / 17:12 are
// accepted integer ratios close to A4; both pixel dimensions are multiples of
// 16 and remain below the upstream 8,294,400-pixel limit.
const PRINT_REQUEST_SIZE = Object.freeze({ '1:1.4': '2416x3424', '1.4:1': '3424x2416' });
const PRINT_API_RATIO = Object.freeze({ '1:1.4': '12:17', '1.4:1': '17:12' });
function taskAspect(size, fallback = null) { return Number(fallback) > 0 ? Number(fallback) : size === '1.4:1' ? PRINT_RATIO : 1 / PRINT_RATIO; }
function updateTaskCount() { activeJobs = runningTasks.size; els.generate.lastElementChild.textContent = activeJobs ? `继续生成（${activeJobs}张处理中）` : '生成儿童插画'; }
const TASK_LABELS = {
  generation: ['正在绘制插画','图片生成失败','high'], reference: ['正在引用参考图生成','参考图生成失败','参考图/high'],
  lineart: ['正在提取线稿','线稿提取失败','线稿'], edit: ['正在修改图片','图片修改失败','图片修改']
};
function taskSubject(task) { return task.source ? (task.source.subject || '插画') + (task.type === 'lineart' ? ' · 黑白线稿' : ' · 已修改') : task.params.subject; }
function validKey() { if (getSettings().apiKey) return true; openSettings('api'); toast('请先填写并保存客户密钥'); return false; }
async function hydrateTask(task) {
  const hydrated = { ...task, params: task.params ? { ...task.params } : null, references: [] };
  if (task.source) hydrated.source = { ...task.source, blob: await GalleryStore.original(task.source) };
  for (const ref of task.references || []) hydrated.references.push({ ...ref, blob: await GalleryStore.original(ref) });
  return hydrated;
}
async function requestTask(task, s, onServerTask = null) {
  let response, sourceDimensions = null, outputDimensions = null, asyncPath = '', bodyFactory = null, asyncHeaders = {};
  if (task.type === 'generation') {
    const p = task.params;
    const payload = { model: s.model, prompt: buildPrompt(p), size: PRINT_REQUEST_SIZE[p.size] || PRINT_REQUEST_SIZE['1:1.4'], image_size: '4k', aspect_ratio: PRINT_API_RATIO[p.size] || PRINT_API_RATIO['1:1.4'], quality: 'high', output_format: 'png', moderation: 'auto', n: 1, response_format: 'b64_json' };
    asyncPath = 'generations'; asyncHeaders = { 'Content-Type': 'application/json' }; bodyFactory = () => JSON.stringify(payload);
    if (!s.taskApiBase) response = await fetchApi(s.apiBase.replace(/\/$/, '') + s.apiPath, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.apiKey }, body: JSON.stringify(payload) });
  } else {
    let size, prompt, aspectRatio = '', imageParts = [];
    if (task.type === 'reference') {
      const p = task.params;
      if (!task.references.length) throw new Error('原参考图缺失，无法按原任务重新生成');
      size = PRINT_REQUEST_SIZE[p.size] || PRINT_REQUEST_SIZE['1:1.4']; aspectRatio = PRINT_API_RATIO[p.size] || PRINT_API_RATIO['1:1.4']; prompt = buildPrompt(p, true);
      imageParts = task.references.map((ref, index) => ['image[]', ref.blob, 'reference-' + (index + 1) + '.' + referenceExtension(ref.blob)]);
    } else {
      sourceDimensions = await blobDimensions(task.source.blob);
      const requestSize = lineArtRequestSize(sourceDimensions);
      size = requestSize.size;
      outputDimensions = sourceDimensions;
      prompt = task.type === 'lineart' ? LINE_ART_PROMPT : `请根据原图进行修改。严格保持原图的画面比例、整体构图和未要求修改的内容，只执行以下修改要求：\n${task.instruction}`;
      imageParts = [['image', task.source.blob, 'source.' + referenceExtension(task.source.blob)]];
    }
    bodyFactory = () => { const form = new FormData(); for (const part of imageParts) form.append(...part); form.append('model', s.model); form.append('prompt', prompt); form.append('size', size); if (aspectRatio) { form.append('image_size', '4k'); form.append('aspect_ratio', aspectRatio); } form.append('quality', 'high'); form.append('output_format', 'png'); form.append('n', '1'); form.append('response_format', 'b64_json'); return form; };
    asyncPath = 'edits';
    if (!s.taskApiBase) response = await fetchApi(s.apiBase.replace(/\/$/, '') + '/images/edits', { method: 'POST', headers: { Authorization: 'Bearer ' + s.apiKey }, body: bodyFactory() });
  }
  if (s.taskApiBase) {
    const submitted = await submitAsyncImageTask(s.taskApiBase.replace(/\/$/, ''), asyncPath, bodyFactory, asyncHeaders, s.apiKey, task.clientRequestId);
    task.serverTaskId = submitted.id;
    if (onServerTask) await onServerTask(submitted.id);
    let result = await pollAsyncImageTask(s.taskApiBase.replace(/\/$/, ''), submitted.id), blob = result.blob;
    if (outputDimensions) blob = (await normalizeLineArtOutput(blob, outputDimensions)).blob;
    return { blob, points: result.points || s.points, serverTaskId: submitted.id };
  }
  const data = await parseApiResponse(response);
  if (!response.ok) throw new Error(data?.error?.message || data?.message || `生成失败（HTTP ${response.status}）`);
  let blob = data.directBlob || await imageBlob(data);
  if (outputDimensions) blob = (await normalizeLineArtOutput(blob, outputDimensions)).blob;
  return { blob, points: Number(data?.points_used ?? data?.credits_used ?? s.points) || 0 };
}
async function runTask(spec, failedRecord = null) {
  if (!validKey()) return;
  await galleryReady;
  const id = failedRecord?.id || newId();
  if (runningTasks.has(id)) return;
  const task = { ...spec, clientRequestId: spec.clientRequestId || newId(), params: spec.params ? { ...spec.params } : null, references: (spec.references || []).map(ref => ({ ...ref })) };
  const labels = TASK_LABELS[task.type];
  if (!labels) return toast('无法识别这个任务');
  const time = new Date().toLocaleString('zh-CN', { hour12: false });
  const size = task.source?.size || task.params?.size || '1:1.4';
  const aspectRatio = taskAspect(size, task.source?.aspectRatio);
  const releaseAssets = GalleryStore.retain([task.source, ...task.references]);
  runningTasks.set(id, { id, type: task.type }); updateTaskCount();
  const loading = loadingCard(size, labels[0], aspectRatio, failedRecord ? galleryCards.get(String(id)) : null, Boolean(getSettings().taskApiBase));
  loading.dataset.taskId = id; loading.dataset.itemId = String(id); galleryCards.set(String(id), loading);
  let current = task, output, saved;
  try {
    if (getSettings().taskApiBase) {
      const pending = { id, createdAt: failedRecord?.createdAt || Date.now(), time, subject: taskSubject(task), size, aspectRatio, quality: labels[2], kind: 'pending', pendingType: task.type, pendingTitle: labels[0], clientRequestId: task.clientRequestId, serverTaskId: task.serverTaskId || '', state: task.params || task.source?.state || null };
      saved = await GalleryStore.save(pending, task);
      for (const evicted of saved.evicted) removeGalleryRecord(evicted);
    }
    current = await hydrateTask(task);
    output = await requestTask(current, getSettings(), async serverTaskId => {
      current.serverTaskId = serverTaskId;
      const pending = { id, createdAt: failedRecord?.createdAt || Date.now(), time, subject: taskSubject(current), size, aspectRatio, quality: labels[2], kind: 'pending', pendingType: current.type, pendingTitle: labels[0], clientRequestId: current.clientRequestId, serverTaskId, state: current.params || current.source?.state || null };
      const updated = await GalleryStore.save(pending, current); for (const evicted of updated.evicted) removeGalleryRecord(evicted);
    });
    const item = { id, createdAt: Date.now(), time, subject: taskSubject(current), size, quality: 'high', state: current.params || current.source?.state || null, kind: current.type, sourceId: current.source?.id, editInstruction: current.instruction || '', blob: output.blob };
    // Keep the source image and instruction behind a completed edit result so
    // “重新生成” can reopen the editor without immediately billing a new task.
    saved = await GalleryStore.save(item, current.type === 'edit' ? current : null);
    placeCard(createCompletedCard(saved.item), loading, saved.evicted);
    addLog({ time, subject: item.subject, size, quality: labels[2], points: output.points, success: true, taskId: id });
  } catch (error) {
    const reason = String(error?.message || '未知错误');
    const item = { id, createdAt: Date.now(), time, kind: 'failed', failureType: current.type, failureTitle: labels[1], error: reason, subject: taskSubject(current), size, aspectRatio, quality: '失败', state: current.params || current.source?.state || null, attempt: (failedRecord?.attempt || 0) + 1 };
    if (error?.uncertain) current.clientRequestId = current.clientRequestId || task.clientRequestId; else delete current.clientRequestId;
    saved = await GalleryStore.save(item, current);
    placeCard(createFailedCard(saved.item), loading, saved.evicted);
    addLog({ time, subject: item.subject, size, quality: labels[2], points: 0, success: false, error: reason, taskId: id });
    playTaskSound(false);
    toast(saved.cached ? reason : reason + '；浏览器缓存不足，此失败记录暂未保存');
    return;
  } finally { releaseAssets(); runningTasks.delete(id); updateTaskCount(); }
  playTaskSound(true);
  // Download/cache problems must never resubmit a successful, already billed model task.
  await download({ ...saved.item, blob: output.blob });
  toast(saved.cached ? '生成成功，图片已自动下载' : '图片已生成并下载，但浏览器缓存不足');
}
async function resumePendingTasks() {
  if (!getSettings().taskApiBase || !getSettings().apiKey) return;
  await galleryReady;
  const pending = (await GalleryStore.list()).filter(item => item.kind === 'pending');
  for (const item of pending) {
    if (runningTasks.has(String(item.id))) continue;
    try {
      const snapshot = await GalleryStore.retry(item.id);
      if (!snapshot || !TASK_LABELS[snapshot.type]) throw new Error('后台任务的本地参数已经缺失');
      snapshot.clientRequestId = item.clientRequestId; snapshot.serverTaskId = item.serverTaskId;
      runTask(snapshot, item);
    } catch (error) { console.warn('恢复异步任务失败', error); }
  }
}
async function generate() {
  const p = params(); if (!p.subject) return toast('请先填写主题内容');
  if (!validKey()) return;
  const references = referenceSnapshot(); rememberTheme(p);
  return runTask({ type: references.length ? 'reference' : 'generation', params: p, references });
}
function extractLineArt(item) { return runTask({ type: 'lineart', source: item }); }
async function editImage(item, instruction) {
  if (!instruction) return toast('请先输入图片修改内容');
  if (!validKey()) return;
  const source = { ...item };
  imageEditDrafts.delete(String(item.id)); closeImageEditor();
  return runTask({ type: 'edit', source, instruction });
}
async function retryFailedTask(item) {
  const id = String(item.id);
  if (retryLocks.has(id) || runningTasks.has(id) || !validKey()) return;
  // Lock before the first await; keep the saved failure until success replaces it atomically.
  retryLocks.add(id);
  try {
    const task = await GalleryStore.retry(id);
    if (!task || !TASK_LABELS[task.type]) throw new Error('原任务数据缺失，无法重新生成');
    if (['lineart','edit'].includes(task.type) && !task.source?.assetId) throw new Error('原图缺失，无法重新生成');
    if (task.type === 'edit' && !task.instruction) throw new Error('原修改要求缺失');
    if (['generation','reference'].includes(task.type) && !task.params?.subject) throw new Error('原主题参数缺失');
    if (task.type === 'generation') restoreItem({ kind: 'generation', state: task.params, subject: task.params.subject, size: task.params.size });
    await runTask(task, item);
  } catch (error) { toast(error.message); }
  finally { retryLocks.delete(id); }
}
async function makePale(item) {
  const id = String(item.id); if (localLocks.has(id)) return;
  localLocks.add(id);
  try {
    const blob = await GalleryStore.original(item), result = await ImageWork.run({ type: 'pale', blob });
    const time = new Date().toLocaleString('zh-CN', { hour12: false });
    const output = { id: newId(), createdAt: Date.now(), time, subject: (item.subject || '插画') + ' · 浅色15%', size: item.size, quality: '本地JPG', state: item.state, sourceId: item.id, kind: 'pale', ...result };
    const saved = await GalleryStore.save(output);
    placeCard(createCompletedCard(saved.item), null, saved.evicted);
    addLog({ time, subject: output.subject, size: item.size, quality: '本地浅色JPG', points: 0, success: true });
    await download(output); toast('变浅色成功');
  } catch (error) { toast(error.message || '浅色处理失败'); }
  finally { localLocks.delete(id); }
}
async function importDroppedImages(fileList) {
  const files = [...fileList].filter(f => /^image\/(png|jpeg|webp|gif)$/i.test(f.type));
  if (!files.length) return toast('请拖入 PNG、JPG、WebP 或 GIF 图片');
  await galleryReady;
  let imported = 0;
  for (const file of files) {
    try {
      const time = new Date().toLocaleString('zh-CN', { hour12: false }), subject = file.name.replace(/\.[^.]+$/, '') || '导入图片';
      // save() measures the original while creating the thumbnail; no second full decode.
      const saved = await GalleryStore.save({ id: newId(), createdAt: Date.now(), time, subject, quality: '本地导入', kind: 'import', blob: file });
      placeCard(createCompletedCard(saved.item), null, saved.evicted); imported++;
    } catch (error) { console.warn(error); }
  }
  toast(imported ? `已导入${imported}张图片，可右键使用图片功能` : '图片导入失败，请更换图片后重试');
}
