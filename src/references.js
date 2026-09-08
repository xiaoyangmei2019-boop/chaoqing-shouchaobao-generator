const referenceNodes = new Map();
function saveGalleryReferenceIds() { localStorage.setItem(REFERENCE_GALLERY_KEY, JSON.stringify([...galleryReferenceIds])); }
function isGalleryReferenced(id) { return galleryReferenceIds.has(String(id)); }
function referenceTotal() { return uploadedReferences.length + galleryReferenceIds.size; }
function referenceExtension(blob) { const type = blob?.type || ''; return type.includes('jpeg') ? 'jpg' : type.includes('webp') ? 'webp' : type.includes('gif') ? 'gif' : 'png'; }
function syncReferenceCards() { for (const [id, card] of galleryCards) card.classList.toggle('reference-selected', isGalleryReferenced(id)); }
function renderReferenceList() {
  const entries = uploadedReferences.map(ref => ({ ...ref, type: 'upload' }));
  for (const id of galleryReferenceIds) { const item = galleryReferenceItems.get(id); if (item) entries.push({ type: 'gallery', id, name: item.subject, assetId: item.assetId }); }
  const keys = new Set(entries.map(e => e.type + ':' + e.id));
  for (const [key, box] of referenceNodes) if (!keys.has(key)) { ImageURLs.release(box.querySelector('img')); box.remove(); referenceNodes.delete(key); }
  els.referenceList.querySelector('.reference-empty')?.remove();
  els.referenceCount.textContent = entries.length ? '已引用 ' + entries.length + ' 张' : '未引用';
  if (!entries.length) { els.referenceList.innerHTML = '<p class="reference-empty">可在这里上传，或右键引用右侧图片，最多 10 张。</p>'; return; }
  for (const entry of entries) {
    const key = entry.type + ':' + entry.id;
    if (referenceNodes.has(key)) continue;
    const box = document.createElement('div'), img = document.createElement('img'), button = document.createElement('button');
    box.className = 'reference-thumb'; box.title = entry.name || '参考图'; img.alt = entry.name || '参考图'; img.decoding = 'async';
    button.className = 'reference-remove'; button.type = 'button'; button.textContent = '×'; button.title = '取消引用';
    button.onclick = () => {
      if (entry.type === 'upload') uploadedReferences = uploadedReferences.filter(x => x.id !== entry.id);
      else { galleryReferenceIds.delete(entry.id); saveGalleryReferenceIds(); syncReferenceCards(); }
      renderReferenceList();
    };
    box.append(img, button); referenceNodes.set(key, box); els.referenceList.append(box);
    Promise.resolve(entry.thumbnail || GalleryStore.preview(entry.assetId)).then(blob => { if (referenceNodes.get(key) === box) ImageURLs.set(img, blob); }).catch(error => { img.alt = '参考图预览不可用'; console.warn(error); });
  }
}
function toggleGalleryReference(item) {
  const id = String(item.id);
  if (isGalleryReferenced(id)) galleryReferenceIds.delete(id);
  else { if (referenceTotal() >= MAX_REFERENCE_IMAGES) return toast('最多可引用 10 张参考图'); galleryReferenceIds.add(id); }
  saveGalleryReferenceIds(); syncReferenceCards(); renderReferenceList();
  toast(isGalleryReferenced(id) ? '已设为参考图' : '已取消参考图');
}
// Capture selections synchronously; subsequent left-panel changes cannot change an active task.
function referenceSnapshot() {
  const refs = uploadedReferences.map(x => ({ name: x.name, assetId: x.assetId, blob: x.blob }));
  for (const id of galleryReferenceIds) { const item = galleryReferenceItems.get(id); if (item) refs.push({ name: item.subject, assetId: item.assetId }); }
  return refs.slice(0, MAX_REFERENCE_IMAGES);
}
async function addUploadedReferences(fileList) {
  const files = [...fileList].filter(f => /^image\/(png|jpeg|webp)$/i.test(f.type));
  if (!files.length) return toast('请选择 PNG、JPG 或 WebP 图片');
  els.referenceInput.value = ''; let added = 0;
  for (const file of files) {
    if (referenceTotal() >= MAX_REFERENCE_IMAGES) break;
    try {
      const thumb = await ImageWork.run({ type: 'thumbnail', blob: file });
      if (referenceTotal() >= MAX_REFERENCE_IMAGES) break;
      const id = newId(); uploadedReferences.push({ id, assetId: 'upload:' + id, name: file.name || '上传参考图', blob: file, thumbnail: thumb.blob });
      added++; renderReferenceList();
    } catch (error) { console.warn(error); }
  }
  toast(added ? '已添加 ' + added + ' 张参考图' : '未能添加参考图，最多可引用 10 张');
}
