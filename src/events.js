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
let adminCheckVersion = 0, adminCheckTimer = null, verifiedAdminKey = '';
function hideAdminControls() {
  $('adminSettingsEntry').hidden = true;
  $('adminModelField').hidden = true;
  $('adminModel').replaceChildren();
  $('openAdminSettings').setAttribute('aria-expanded', 'false');
  verifiedAdminKey = '';
}
async function checkAdminControls() {
  const version = ++adminCheckVersion, key = $('apiKey').value.trim();
  const chosenModel = $('adminModel').value || getSettings().adminModel;
  hideAdminControls();
  if (!key || !getSettings().taskApiBase) return false;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(getSettings().taskApiBase + '/admin-access', {
      headers: { Authorization: 'Bearer ' + key }, cache: 'no-store', signal: controller.signal
    });
    if (!response.ok) return false;
    const access = await response.json();
    if (version !== adminCheckVersion || $('apiKey').value.trim() !== key) return false;
    if (access.admin === true) {
      for (const model of access.models || []) {
        if (!['gpt-image-2', 'gpt-image-2-official', 'gpt-image-2.5-sunburst'].includes(model)) continue;
        const option = document.createElement('option'), price = access.prices?.[model];
        option.value = model;
        option.textContent = model + ' · ' + (typeof price === 'number' ? '收费 ' + price : '价格待确认');
        $('adminModel').append(option);
      }
      if (chosenModel && Array.from($('adminModel').options).some(option => option.value === chosenModel)) $('adminModel').value = chosenModel;
      verifiedAdminKey = key; $('adminSettingsEntry').hidden = false;
      return true;
    }
  } catch { /* Keep the ordinary route controls available when verification is unavailable. */ }
  finally { clearTimeout(timer); }
  return false;
}
$('openAdminSettings').onclick = () => {
  if (!verifiedAdminKey || verifiedAdminKey !== $('apiKey').value.trim()) return hideAdminControls();
  const field = $('adminModelField'); field.hidden = !field.hidden;
  $('openAdminSettings').setAttribute('aria-expanded', String(!field.hidden));
};
$('apiKey').addEventListener('input', () => {
  ++adminCheckVersion; clearTimeout(adminCheckTimer); hideAdminControls();
  adminCheckTimer = setTimeout(checkAdminControls, 400);
});

function syncEngineButton() {
  const name = { line1: 'Lite', line2: 'Pro', line3: 'Max' }[getSettings().route] || 'Lite';
  $('openEngine').textContent = '生成引擎 · ' + name;
}
function closeEngineDialog(restoreFocus = true) {
  const wasOpen = $('engineModal').classList.contains('open');
  $('engineModal').classList.remove('open');
  $('openEngine').setAttribute('aria-expanded', 'false');
  if (wasOpen && restoreFocus) $('openEngine').focus({ preventScroll: true });
}
$('openEngine').onclick = () => {
  $('generationRoute').value = getSettings().route;
  $('engineModal').classList.add('open');
  $('openEngine').setAttribute('aria-expanded', 'true');
  hideHelp(); closeContextMenu();
  $('generationRoute').focus({ preventScroll: true });
};
$('closeEngine').onclick = () => closeEngineDialog();
$('finishEngine').onclick = () => closeEngineDialog();
$('engineModal').onclick = e => { if (e.target === $('engineModal')) closeEngineDialog(); };
document.addEventListener('keydown', e => {
  if (!$('engineModal').classList.contains('open')) return;
  if (e.key === 'Escape') { closeEngineDialog(); return; }
  if (e.key !== 'Tab') return;
  const controls = [$('closeEngine'), $('generationRoute'), $('finishEngine')];
  const first = controls[0], last = controls[controls.length - 1];
  if (e.shiftKey && (document.activeElement === first || !controls.includes(document.activeElement))) {
    e.preventDefault(); last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault(); first.focus();
  }
});

$('generationRoute').value = getSettings().route;
syncEngineButton();
$('generationRoute').addEventListener('change', () => {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {};
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...saved, route: ['line1', 'line2', 'line3'].includes($('generationRoute').value) ? $('generationRoute').value : 'line1' }));
    syncEngineButton();
    toast('生成引擎已保存');
  } catch { toast('引擎选择保存失败，请重试'); }
});
function fillSettings() { const s = getSettings(); $('apiKey').value = s.apiKey; $('outputFormat').value = s.outputFormat; $('generationRoute').value = s.route; syncEngineButton(); checkAdminControls(); if (!s.apiKey) setQuotaState('empty', null); }
function openSettings(tab = 'api') { fillSettings(); renderLogs(); els.modal.classList.add('open'); switchTab(tab); refreshQuota({ silent: true }); }
function switchTab(name) { document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.dataset.tab === name)); document.querySelectorAll('.tab-panel').forEach(x => x.classList.toggle('active', x.id === `panel-${name}`)); }
for (const el of Object.values(els)) if (['INPUT','TEXTAREA','SELECT'].includes(el?.tagName) && el !== els.referenceInput) el.addEventListener('input', updateForm);
els.generate.onclick = () => generate().catch(error => toast(error.message));
els.referenceInput.onchange = () => addUploadedReferences(els.referenceInput.files);
$('importImageInput').onchange = () => { const files = $('importImageInput').files; importDroppedImages(files).catch(error => toast(error.message)); $('importImageInput').value = ''; };
$('openSettings').onclick = () => openSettings(); $('closeSettings').onclick = () => els.modal.classList.remove('open');
els.modal.onclick = e => { if (e.target === els.modal) els.modal.classList.remove('open'); };
document.querySelectorAll('.tab').forEach(x => x.onclick = () => switchTab(x.dataset.tab));
$('toggleKey').onclick = () => { const x = $('apiKey'), show = x.type === 'password'; x.type = show ? 'text' : 'password'; $('toggleKey').textContent = show ? '隐藏' : '显示'; };
$('clearLogs').onclick = () => { if (confirm('确定清空全部任务记录吗？“我的作品”中的图片不会被删除。')) { localStorage.removeItem(LOG_KEY); renderLogs(); } };
$('saveSettings').onclick = async () => {
  const apiKey = $('apiKey').value.trim(), button = $('saveSettings');
  button.disabled = true;
  try {
    clearTimeout(adminCheckTimer);
    const admin = verifiedAdminKey === apiKey && apiKey ? true : await checkAdminControls();
    if ($('apiKey').value.trim() !== apiKey) return;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ apiKey,
      adminModel: admin ? $('adminModel').value : '',
      route: ['line1', 'line2', 'line3'].includes($('generationRoute').value) ? $('generationRoute').value : 'line1',
      outputFormat: $('outputFormat').value === 'jpeg' ? 'jpeg' : 'png' }));
    fillSettings(); els.modal.classList.remove('open');
    toast(apiKey ? '设置已保存，正在校验额度' : '设置已保存，请填写客户密钥后生成');
    refreshQuota({ silent: !apiKey }); if (apiKey) resumePendingTasks();
  } finally { button.disabled = false; }
};
$('refreshQuota').onclick = () => refreshQuota();
$('contextMenu').onclick = async e => {
  const action = e.target.closest('button')?.dataset.action, item = contextItem;
  if (!action || !item) return;
  closeContextMenu();
  try {
    if (action === 'download') await download(item);
    else if (action === 'regenerate') {
      if (item.kind === 'failed') await retryFailedTask(item);
      else if (item.kind === 'edit') await reopenCompletedEdit(item);
      else restoreItem(item);
    }
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
document.addEventListener('scroll', hideHelp, { capture: true, passive: true }); window.addEventListener('resize', () => { hideHelp(); updateDeviceCopy(); });
$('openHelp').onclick = () => $('supportModal').classList.add('open'); $('supportClose').onclick = () => $('supportModal').classList.remove('open');
$('supportModal').onclick = e => { if (e.target === $('supportModal')) $('supportModal').classList.remove('open'); };
document.addEventListener('keydown', e => { if (e.key === 'Escape') { els.modal.classList.remove('open'); closePreview(); closeImageEditor(); closeContextMenu(); $('supportModal').classList.remove('open'); } });
$('recentThemeList').onclick = e => { const button = e.target.closest('[data-theme-index]'); if (button) { const record = themeHistory()[Number(button.dataset.themeIndex)]; if (record) applyThemeRecord(record); } };
function toggleRecentThemes() { const section = $('recentThemes'); const collapsed = section.classList.toggle('collapsed'); $('recentHead').setAttribute('aria-expanded', String(!collapsed)); }
$('recentHead').onclick = toggleRecentThemes;
$('recentHead').onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleRecentThemes(); } };
const dropArea = document.querySelector('.gallery-wrap'); let dragDepth = 0;
dropArea.addEventListener('dragenter', e => { if (!e.dataTransfer?.types?.includes('Files')) return; e.preventDefault(); dragDepth++; dropArea.classList.add('dragging'); });
dropArea.addEventListener('dragover', e => { if (!e.dataTransfer?.types?.includes('Files')) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
dropArea.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dropArea.classList.remove('dragging'); });
dropArea.addEventListener('drop', e => { e.preventDefault(); dragDepth = 0; dropArea.classList.remove('dragging'); importDroppedImages(e.dataTransfer.files).catch(error => toast(error.message)); });
window.addEventListener('beforeunload', e => { saveParams(); if (activeJobs > 0) { e.preventDefault(); e.returnValue = ''; } });
window.addEventListener('pagehide', e => { saveParams(); if (!e.persisted) { ImageURLs.clear(); ImageWork.close(); } });
loadParams(); fillSettings(); renderLogs(); renderThemeHistory(); updateDeviceCopy();
galleryReady = renderGallery();
galleryReady.then(() => resumePendingTasks()).catch(error => toast('图片缓存暂不可用：' + error.message));
refreshQuota({ silent: true });
