// Lightweight form persistence and event wiring. No full-gallery redraw on task completion.
let saveParamsTimer = null;
function saveParams() { clearTimeout(saveParamsTimer); try { localStorage.setItem(PARAM_KEY, JSON.stringify(params())); } catch {} }
function loadParams() {
  try { const p = JSON.parse(localStorage.getItem(PARAM_KEY) || '{}'); for (const key of Object.keys(p)) if (els[key] && p[key] != null) els[key].value = p[key]; } catch {}
  if (!['1:1.4','1.4:1'].includes(els.size.value)) els.size.value = '1:1.4';
  updateForm();
}
function updateForm() {
  const titleDisabled = els.titleMode.value === 'none';
  els.titleField.hidden = false;
  els.titleField.classList.toggle('disabled-field', titleDisabled);
  els.titleText.disabled = titleDisabled;
  els.titleText.setAttribute('aria-disabled', String(titleDisabled));
  els.titleText.placeholder = titleDisabled ? '当前已选择不要标题' : '例如：快乐端午';
  $('charCount').textContent = `${els.subject.value.length} / 500`;
  clearTimeout(saveParamsTimer); saveParamsTimer = setTimeout(saveParams, 180);
}
function toast(msg) { els.toast.textContent = msg; els.toast.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => els.toast.classList.remove('show'), 4200); }
function logs() { try { return JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch { return []; } }
function addLog(record) {
  try { const all = logs(); all.unshift(record); localStorage.setItem(LOG_KEY, JSON.stringify(all.slice(0, 300))); } catch (error) { console.warn(error); }
  if (els.modal.classList.contains('open')) renderLogs();
  clearTimeout(refreshQuota.afterTaskTimer);
  refreshQuota.afterTaskTimer = setTimeout(() => refreshQuota({ silent: true }), 1000);
}
function fillSettings() { const s = getSettings(); $('apiKey').value = s.apiKey; if (!s.apiKey) setQuotaState('empty', null); }
function openSettings(tab = 'api') { fillSettings(); renderLogs(); els.modal.classList.add('open'); switchTab(tab); refreshQuota({ silent: true }); }
function switchTab(name) { document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.dataset.tab === name)); document.querySelectorAll('.tab-panel').forEach(x => x.classList.toggle('active', x.id === `panel-${name}`)); }
for (const el of Object.values(els)) if (['INPUT','TEXTAREA','SELECT'].includes(el?.tagName) && el !== els.referenceInput) el.addEventListener('input', updateForm);
els.generate.onclick = () => generate().catch(error => toast(error.message));
els.referenceInput.onchange = () => addUploadedReferences(els.referenceInput.files);
$('openSettings').onclick = () => openSettings(); $('closeSettings').onclick = () => els.modal.classList.remove('open');
els.modal.onclick = e => { if (e.target === els.modal) els.modal.classList.remove('open'); };
document.querySelectorAll('.tab').forEach(x => x.onclick = () => switchTab(x.dataset.tab));
$('toggleKey').onclick = () => { const x = $('apiKey'), show = x.type === 'password'; x.type = show ? 'text' : 'password'; $('toggleKey').textContent = show ? '隐藏' : '显示'; };
$('clearLogs').onclick = () => { if (confirm('确定清空全部生成记录吗？图片历史不会被删除。')) { localStorage.removeItem(LOG_KEY); renderLogs(); } };
$('saveSettings').onclick = () => { const apiKey = $('apiKey').value.trim(); localStorage.setItem(SETTINGS_KEY, JSON.stringify({ apiKey })); fillSettings(); els.modal.classList.remove('open'); toast(apiKey ? '客户密钥已保存，正在校验额度' : '客户密钥已清除'); refreshQuota({ silent: !apiKey }); };
$('refreshQuota').onclick = () => refreshQuota();
$('contextMenu').onclick = async e => {
  const action = e.target.closest('button')?.dataset.action, item = contextItem;
  if (!action || !item) return;
  closeContextMenu();
  try {
    if (action === 'download') await download(item);
    else if (action === 'regenerate') item.kind === 'failed' ? await retryFailedTask(item) : restoreItem(item);
    else if (action === 'reference') toggleGalleryReference(item);
    else if (action === 'edit') await openImageEditor(item);
    else if (action === 'preview') await previewImage(item);
    else if (action === 'lineart') await extractLineArt(item);
    else if (action === 'pale') await makePale(item);
    else if (action === 'delete') await deleteImageItem(item);
  } catch (error) { toast(error.message); }
};
document.addEventListener('click', e => { if (!e.target.closest('#contextMenu')) closeContextMenu(); });
document.addEventListener('scroll', closeContextMenu, { capture: true, passive: true });
$('lightboxClose').onclick = closePreview;
$('lightbox').onclick = e => { if (e.target === $('lightbox')) closePreview(); };
$('imageEditInput').oninput = () => { if (imageEditCurrentItem) imageEditDrafts.set(String(imageEditCurrentItem.id), $('imageEditInput').value); };
$('imageEditSubmit').onclick = () => { if (imageEditCurrentItem) editImage(imageEditCurrentItem, $('imageEditInput').value.trim()); };
$('imageEditCancel').onclick = () => closeImageEditor(true); $('imageEditClose').onclick = () => closeImageEditor();
$('imageEditModal').onclick = e => { if (e.target === $('imageEditModal')) closeImageEditor(); };
document.addEventListener('pointerdown', unlockTaskAudio, { once: true, capture: true });
document.querySelectorAll('.help').forEach(help => {
  help.addEventListener('mouseenter', () => showHelp(help)); help.addEventListener('mouseleave', hideHelp);
  help.addEventListener('focus', () => showHelp(help)); help.addEventListener('blur', hideHelp);
  help.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); $('helpBubble').classList.contains('open') ? hideHelp() : showHelp(help); });
});
document.addEventListener('scroll', hideHelp, { capture: true, passive: true }); window.addEventListener('resize', hideHelp);
$('openHelp').onclick = () => $('supportModal').classList.add('open'); $('supportClose').onclick = () => $('supportModal').classList.remove('open');
$('supportModal').onclick = e => { if (e.target === $('supportModal')) $('supportModal').classList.remove('open'); };
document.addEventListener('keydown', e => { if (e.key === 'Escape') { els.modal.classList.remove('open'); closePreview(); closeImageEditor(); closeContextMenu(); $('supportModal').classList.remove('open'); } });
$('recentThemeList').onclick = e => { const button = e.target.closest('[data-theme-index]'); if (button) { const record = themeHistory()[Number(button.dataset.themeIndex)]; if (record) applyThemeRecord(record); } };
const dropArea = document.querySelector('.gallery-wrap'); let dragDepth = 0;
dropArea.addEventListener('dragenter', e => { if (!e.dataTransfer?.types?.includes('Files')) return; e.preventDefault(); dragDepth++; dropArea.classList.add('dragging'); });
dropArea.addEventListener('dragover', e => { if (!e.dataTransfer?.types?.includes('Files')) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
dropArea.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dropArea.classList.remove('dragging'); });
dropArea.addEventListener('drop', e => { e.preventDefault(); dragDepth = 0; dropArea.classList.remove('dragging'); importDroppedImages(e.dataTransfer.files).catch(error => toast(error.message)); });
window.addEventListener('beforeunload', e => { saveParams(); if (activeJobs > 0) { e.preventDefault(); e.returnValue = ''; } });
window.addEventListener('pagehide', e => { saveParams(); if (!e.persisted) { ImageURLs.clear(); ImageWork.close(); GalleryStore.close(); } });
loadParams(); fillSettings(); renderLogs(); renderThemeHistory();
galleryReady = renderGallery();
galleryReady.catch(error => toast('图片缓存暂不可用：' + error.message));
refreshQuota({ silent: true });
