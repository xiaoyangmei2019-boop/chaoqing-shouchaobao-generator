// Gallery nodes retain metadata only. Full-resolution assets are fetched by user actions.
const galleryCards = new Map(), thumbStates = new WeakMap();
let galleryReady = Promise.resolve(), modalEpoch = 0, editorEpoch = 0;
const galleryObserver = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
  for (const entry of entries) {
    const state = thumbStates.get(entry.target); if (!state) continue;
    state.visible = entry.isIntersecting;
    if (state.visible) loadCardThumbnail(entry.target);
    else { state.epoch++; ImageURLs.release(state.img); }
  }
}, { root: document.querySelector('.gallery-wrap'), rootMargin: '120px 0px' }) : null;

async function loadCardThumbnail(card) {
  const state = thumbStates.get(card);
  if (!state || !state.visible || state.img.hasAttribute('src')) return;
  const epoch = ++state.epoch;
  try {
    const blob = await GalleryStore.preview(state.assetId);
    if (card.isConnected && state.visible && epoch === state.epoch) ImageURLs.set(state.img, blob);
  } catch (error) {
    if (card.isConnected && epoch === state.epoch) { state.img.alt = '预览暂不可用，可右键下载原图'; console.warn(error); }
  }
}
function disposeCard(card) {
  galleryObserver?.unobserve(card);
  const state = thumbStates.get(card);
  if (state) { state.epoch++; state.visible = false; ImageURLs.release(state.img); thumbStates.delete(card); }
  const id = card.dataset.itemId;
  if (id && galleryCards.get(id) === card) galleryCards.delete(id);
}
function mobileActionMode() {
  return innerWidth <= 780 || matchMedia('(hover: none), (pointer: coarse)').matches;
}
function bindCardActions(card, item) {
  let tapStart = null, suppressClickUntil = 0;
  card.addEventListener('contextmenu', e => {
    e.preventDefault();
    openContextMenu(e.clientX, e.clientY, item, mobileActionMode());
  });
  card.addEventListener('pointerdown', e => {
    if (!mobileActionMode() || e.pointerType === 'mouse' || e.target.closest('button')) return;
    tapStart = { id: e.pointerId, x: e.clientX, y: e.clientY };
  }, { passive: true });
  card.addEventListener('pointerup', e => {
    if (!tapStart || tapStart.id !== e.pointerId) return;
    const moved = Math.hypot(e.clientX - tapStart.x, e.clientY - tapStart.y);
    tapStart = null;
    if (moved > 10 || e.target.closest('button')) return;
    e.preventDefault(); e.stopPropagation();
    suppressClickUntil = Date.now() + 700;
    openContextMenu(e.clientX, e.clientY, item, true);
  });
  card.addEventListener('pointercancel', () => { tapStart = null; });
  card.addEventListener('click', e => {
    if (Date.now() < suppressClickUntil) { e.preventDefault(); e.stopPropagation(); }
  });
}
function createCompletedCard(item) {
  const meta = GalleryStore.summary(item), card = document.createElement('article');
  galleryReferenceItems.set(meta.id, meta); galleryCards.set(meta.id, card);
  card.className = 'card' + (meta.size === '1.4:1' ? ' landscape' : '') + (isGalleryReferenced(meta.id) ? ' reference-selected' : '');
  card.dataset.itemId = meta.id; card.title = mobileActionMode() ? '点击打开图片功能' : '右键打开图片功能';
  const box = document.createElement('div'), img = document.createElement('img');
  box.className = 'image-box'; box.style.setProperty('aspect-ratio', String(meta.aspectRatio), 'important');
  img.alt = meta.subject || '生成图片'; img.decoding = 'async'; img.loading = 'lazy';
  box.append(img); card.append(box);
  thumbStates.set(card, { img, assetId: meta.assetId, visible: false, epoch: 0 });
  bindCardActions(card, meta);
  card.addEventListener('dblclick', () => { if (!mobileActionMode()) previewImage(meta); });
  if (galleryObserver) galleryObserver.observe(card);
  else setTimeout(() => { const state = thumbStates.get(card); if (state) { state.visible = true; loadCardThumbnail(card); } }, 0);
  return card;
}
function createFailedCard(item) {
  const card = document.createElement('article');
  card.className = 'card failed-card' + (item.size === '1.4:1' ? ' landscape' : '');
  card.dataset.itemId = String(item.id); card.title = mobileActionMode() ? '生成失败，点击可重新生成' : '生成失败，右键可重新生成';
  galleryCards.set(String(item.id), card);
  card.innerHTML = '<div class="image-box"><div class="failure-visual"><svg class="failure-graphic" viewBox="0 0 80 80" aria-hidden="true"><circle cx="40" cy="40" r="35" fill="#fff" stroke="#c95555" stroke-width="4"/><path d="M40 21v25" stroke="#c95555" stroke-width="7" stroke-linecap="round"/><circle cx="40" cy="59" r="4" fill="#c95555"/></svg><strong class="failure-title"></strong><p class="failure-card-reason"></p><button class="failure-dismiss" type="button">删除失败记录</button></div></div>';
  card.querySelector('.image-box').style.setProperty('aspect-ratio', String(taskAspect(item.size, item.aspectRatio)), 'important');
  card.querySelector('.failure-title').textContent = item.failureTitle || '生成失败';
  card.querySelector('.failure-card-reason').textContent = item.error || '未知错误';
  card.querySelector('.failure-dismiss').onclick = e => { e.stopPropagation(); deleteImageItem(item); };
  bindCardActions(card, item);
  return card;
}
function createPendingCard(item) {
  const card = document.createElement('article');
  card.className = 'card loading-card' + (item.size === '1.4:1' ? ' landscape' : '');
  card.dataset.itemId = String(item.id); card.dataset.taskId = String(item.serverTaskId || '');
  card.innerHTML = '<div class="image-box"><div class="loading-center"><div class="spinner"></div><strong></strong><small>任务在服务器后台处理，可刷新页面</small></div></div>';
  card.querySelector('strong').textContent = item.pendingTitle || TASK_LABELS[item.pendingType]?.[0] || '正在后台处理';
  card.querySelector('.image-box').style.setProperty('aspect-ratio', String(taskAspect(item.size, item.aspectRatio)), 'important');
  galleryCards.set(String(item.id), card); return card;
}
function visiblePositions(exclude = null) {
  const bounds = document.querySelector('.gallery-wrap').getBoundingClientRect(), positions = new Map();
  for (const card of els.gallery.children) {
    if (card === exclude) continue;
    const r = card.getBoundingClientRect();
    if (r.bottom >= bounds.top && r.top <= bounds.bottom) positions.set(card, r);
  }
  return positions;
}
function animatePositions(before) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const moves = [];
  for (const [card, old] of before) {
    if (!card.isConnected) continue;
    const now = card.getBoundingClientRect(), x = old.left - now.left, y = old.top - now.top;
    if (x || y) moves.push([card, x, y]);
  }
  for (const [card, x, y] of moves) card.animate([{ transform: `translate(${x}px,${y}px)` }, { transform: 'translate(0,0)' }], { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' });
}
function removeGalleryRecord(id) {
  id = String(id);
  const card = galleryCards.get(id);
  if (card) { disposeCard(card); card.remove(); }
  galleryReferenceItems.delete(id); imageEditDrafts.delete(id);
  if (galleryReferenceIds.delete(id)) { saveGalleryReferenceIds(); renderReferenceList(); }
  if (contextItem?.id === id) closeContextMenu();
}
function placeCard(card, replacing, evicted = []) {
  const before = visiblePositions(replacing);
  els.gallery.querySelector('.empty')?.remove();
  if (replacing?.isConnected) { disposeCard(replacing); replacing.replaceWith(card); }
  else els.gallery.prepend(card);
  if (card.dataset.itemId) galleryCards.set(card.dataset.itemId, card);
  for (const id of evicted) removeGalleryRecord(id);
  // Count completed/failed records only. Active tasks are never trimmed.
  [...els.gallery.querySelectorAll('.card[data-item-id]')].slice(MAX_IMAGES).forEach(c => removeGalleryRecord(c.dataset.itemId));
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) card.animate([{ opacity: .3 }, { opacity: 1 }], { duration: 220 });
  animatePositions(before);
}
function loadingCard(orientation, label = '正在绘制插画', aspectRatio = null, replacing = null, background = false) {
  const card = document.createElement('article');
  card.className = 'card loading-card' + (orientation === '1.4:1' ? ' landscape' : '');
  card.innerHTML = '<div class="image-box"><div class="loading-center"><div class="spinner"></div><strong></strong><small></small></div></div>';
  card.querySelector('strong').textContent = label;
  card.querySelector('small').textContent = background ? '任务在服务器后台处理，可刷新页面' : '请保持页面开启';
  card.querySelector('.image-box').style.setProperty('aspect-ratio', String(taskAspect(orientation, aspectRatio)), 'important');
  placeCard(card, replacing); return card;
}
function showEmptyIfNeeded() {
  if (!els.gallery.querySelector('.card')) els.gallery.innerHTML = '<div class="empty"><div class="empty-inner"><div class="empty-icon">✎</div><h3>从左侧开始创作</h3><p>选择需要的画面参数，填写主题内容，生成后的插画会自动出现在这里并下载到电脑。</p></div></div>';
}
async function renderGallery() {
  const all = await GalleryStore.list(), fragment = document.createDocumentFragment();
  for (const card of galleryCards.values()) disposeCard(card);
  galleryCards.clear(); galleryReferenceItems.clear();
  for (const item of all) fragment.append(item.kind === 'failed' ? createFailedCard(item) : item.kind === 'pending' ? createPendingCard(item) : createCompletedCard(item));
  els.gallery.replaceChildren(fragment);
  for (const id of [...galleryReferenceIds]) if (!galleryReferenceItems.has(id)) galleryReferenceIds.delete(id);
  saveGalleryReferenceIds(); renderReferenceList(); showEmptyIfNeeded();
}
async function deleteImageItem(item) {
  closeContextMenu();
  if (retryLocks.has(String(item.id))) return toast('任务正在重新生成，请稍后操作');
  try {
    await GalleryStore.remove(item.id);
    const before = visiblePositions(galleryCards.get(String(item.id)));
    removeGalleryRecord(item.id); animatePositions(before); showEmptyIfNeeded();
    toast(item.kind === 'failed' ? '失败记录已删除' : item.kind === 'pending' ? '本地任务记录已删除；服务器后台任务不会取消' : '图片已从右侧历史删除');
  } catch (error) { toast(error.message || '删除失败'); }
}
function closeContextMenu() {
  const menu = $('contextMenu');
  menu.classList.remove('open', 'mobile-sheet');
  menu.style.removeProperty('left'); menu.style.removeProperty('top');
  contextItem = null;
}
function openContextMenu(x, y, item, mobile = mobileActionMode()) {
  contextItem = item;
  const menu = $('contextMenu'), failed = item.kind === 'failed', pending = item.kind === 'pending';
  if (pending) return;
  for (const button of menu.querySelectorAll('button')) button.style.display = failed && !['regenerate','delete'].includes(button.dataset.action) ? 'none' : '';
  menu.querySelector('[data-action=reference]').textContent = isGalleryReferenced(item.id) ? '− 取消参考图' : '＋ 设为参考图';
  menu.classList.toggle('mobile-sheet', mobile);
  menu.classList.add('open');
  if (mobile) { menu.style.removeProperty('left'); menu.style.removeProperty('top'); return; }
  menu.style.left = Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8)) + 'px';
}
function filename(item) {
  const d = new Date(item.createdAt), pad = n => String(n).padStart(2, '0'), ext = referenceExtension(item.blob);
  return `童画-${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${ext}`;
}
async function download(item) {
  try {
    const blob = await GalleryStore.original(item), a = document.createElement('a');
    const url = URL.createObjectURL(blob); a.href = url; a.download = filename({ ...item, blob });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (error) { toast('下载失败：' + error.message); }
}
async function previewImage(item) {
  const epoch = ++modalEpoch, img = $('lightboxImage');
  ImageURLs.release(img); $('lightbox').classList.add('open');
  try { const blob = await GalleryStore.original(item); if (epoch === modalEpoch) ImageURLs.set(img, blob); }
  catch (error) { if (epoch === modalEpoch) { closePreview(); toast(error.message); } }
}
function closePreview() { modalEpoch++; $('lightbox').classList.remove('open'); ImageURLs.release($('lightboxImage')); }
async function openImageEditor(item, presetInstruction = null) {
  const epoch = ++editorEpoch, id = String(item.id);
  imageEditCurrentItem = item;
  ImageURLs.release($('imageEditImage'));
  if (presetInstruction !== null) imageEditDrafts.set(id, String(presetInstruction));
  $('imageEditInput').value = imageEditDrafts.get(id) || '';
  $('imageEditInput').disabled = false; $('imageEditSubmit').disabled = true;
  $('imageEditSubmit').textContent = '正在加载原图…'; $('imageEditModal').classList.add('open');
  try {
    const blob = await GalleryStore.original(item);
    if (epoch !== editorEpoch) return;
    // Retain only the one original currently being edited, so deleting its card is safe.
    imageEditCurrentItem = { ...item, blob };
    ImageURLs.set($('imageEditImage'), blob);
    $('imageEditSubmit').disabled = false; $('imageEditSubmit').textContent = '提交修改'; $('imageEditInput').focus();
  } catch (error) { if (epoch === editorEpoch) { closeImageEditor(); toast(error.message); } }
}
async function reopenCompletedEdit(item) {
  let task = await GalleryStore.retry(item.id), source = task?.type === 'edit' ? task.source : null;
  // Compatibility for edit results created before the edit snapshot was saved.
  if (!source && item.sourceId) source = galleryReferenceItems.get(String(item.sourceId));
  if (!source?.assetId) throw new Error('原修改图片已被清理，无法恢复修改页面');
  const instruction = task?.instruction || item.editInstruction || '';
  await openImageEditor(source, instruction);
  toast('已恢复原图和上次修改内容，确认后再提交');
}
function closeImageEditor(clearDraft = false) {
  editorEpoch++;
  if (clearDraft && imageEditCurrentItem) imageEditDrafts.delete(String(imageEditCurrentItem.id));
  $('imageEditModal').classList.remove('open'); ImageURLs.release($('imageEditImage')); imageEditCurrentItem = null;
}
function restoreItem(item) {
  // Only a plain text-to-image result may repopulate the authoring form.
  // Line-art, image edits, imports and reference-image tasks must never replace
  // what the user is currently typing on the left.
  if (item?.kind !== 'generation') return false;
  const p = item.state || { subject: item.subject, size: item.size };
  for (const key of Object.keys(p)) if (els[key] && p[key] != null) els[key].value = p[key];
  updateForm(); document.querySelector('.sidebar').scrollTo({ top: 0, behavior: 'smooth' });
  toast('已恢复这张图的主题和参数，可再次生成');
  return true;
}
