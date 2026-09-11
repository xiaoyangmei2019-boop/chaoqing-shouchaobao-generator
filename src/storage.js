// v2 separates small gallery metadata, original assets, preview assets and retry snapshots.
// The v1 store is migrated transaction by transaction without decoding or rewriting originals.
const GalleryStore = (() => {
  const RECORDS = 'records', ASSETS = 'assets', PREVIEWS = 'previews', RETRIES = 'retries';
  const stores = [RECORDS, ASSETS, PREVIEWS, RETRIES];
  let connection = null, ready = null, writes = Promise.resolve();
  const previewJobs = new Map(), transient = new Map(), transientAssets = new Map();
  const pins = new Map();
  const request = q => new Promise((resolve, reject) => { q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error); });
  const done = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error || new Error('浏览器缓存写入失败')); tx.onerror = () => {}; });
  const serial = fn => { const result = writes.then(fn); writes = result.catch(() => {}); return result; };
  function summary(item) {
    const keys = ['id','createdAt','time','subject','size','quality','state','kind','sourceId','width','height','aspectRatio','editInstruction','failureType','failureTitle','error','assetId','assetIds','attempt','pendingType','pendingTitle','clientRequestId','serverTaskId'];
    const meta = {};
    for (const key of keys) if (item[key] !== undefined) meta[key] = item[key];
    meta.id = String(meta.id);
    meta.createdAt = Number(meta.createdAt) || Date.now();
    if (!meta.aspectRatio) meta.aspectRatio = item.width && item.height ? item.width / item.height : taskAspect(item.size);
    return meta;
  }
  function pack(item, retry) {
    const assets = new Map(), ids = new Set();
    function asset(value, fallback) {
      if (!value) return null;
      const id = value.assetId || (value.id ? 'image:' + value.id : fallback);
      if (!id) return null;
      if (value.blob) assets.set(id, { id, blob: value.blob });
      ids.add(id); return id;
    }
    const meta = summary(item);
    if (item.blob || item.assetId) meta.assetId = asset(item, 'image:' + item.id);
    let snapshot = retry || null;
    if (!snapshot && item.kind === 'failed') snapshot = { type: item.failureType, params: item.state, source: item.sourceItem, references: item.references || [], instruction: item.editInstruction };
    if (snapshot) {
      const source = snapshot.source ? { ...summary(snapshot.source), assetId: asset(snapshot.source, 'source:' + item.id) } : null;
      const references = (snapshot.references || []).map((ref, i) => ({ name: ref.name || '参考图', assetId: asset(ref, 'reference:' + item.id + ':' + i) }));
      snapshot = { id: meta.id, type: snapshot.type, params: snapshot.params ? { ...snapshot.params } : null, source, references, instruction: snapshot.instruction || '', clientRequestId: snapshot.clientRequestId || meta.clientRequestId || '', serverTaskId: snapshot.serverTaskId || meta.serverTaskId || '' };
    }
    meta.assetIds = [...ids];
    return { meta, assets: [...assets.values()], snapshot };
  }
  function open() {
    if (ready) return ready;
    ready = (async () => {
      const db = await new Promise((resolve, reject) => {
        const q = indexedDB.open(DB_NAME, 2);
        q.onupgradeneeded = () => {
          const db = q.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
          if (!db.objectStoreNames.contains(RECORDS)) { const s = db.createObjectStore(RECORDS, { keyPath: 'id' }); s.createIndex('createdAt', 'createdAt'); }
          for (const name of [ASSETS, PREVIEWS, RETRIES]) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
        };
        q.onblocked = () => toast('缓存升级中，请关闭仍打开的旧版页面后继续');
        q.onerror = () => reject(q.error);
        q.onsuccess = () => resolve(q.result);
      });
      connection = db;
      db.onversionchange = () => { db.close(); connection = null; ready = null; };
      const keys = await request(db.transaction(STORE).objectStore(STORE).getAllKeys());
      for (const key of keys) {
        const tx = db.transaction([STORE, ...stores], 'readwrite'), completion = done(tx);
        const q = tx.objectStore(STORE).get(key);
        q.onsuccess = () => {
          try {
            if (!q.result) return;
            const data = pack(q.result);
            for (const a of data.assets) tx.objectStore(ASSETS).put(a);
            tx.objectStore(RECORDS).put(data.meta);
            if (data.snapshot) tx.objectStore(RETRIES).put(data.snapshot);
            tx.objectStore(STORE).delete(key);
          } catch { tx.abort(); }
        };
        await completion;
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      return db;
    })().catch(error => { ready = null; connection?.close(); connection = null; throw error; });
    return ready;
  }
  async function get(name, id) { const db = await open(); return request(db.transaction(name).objectStore(name).get(String(id))); }
  async function list() {
    const db = await open(), records = await request(db.transaction(RECORDS).objectStore(RECORDS).getAll());
    const combined = new Map(records.map(x => [x.id, x]));
    for (const [id, data] of transient) combined.set(id, data.meta);
    return [...combined.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_IMAGES);
  }
  // Prune metadata with an index, then remove only assets no remaining record uses.
  function prune(tx, onEvicted) {
    const table = tx.objectStore(RECORDS), q = table.index('createdAt').openCursor(null, 'prev');
    const used = new Set(pins.keys()), evicted = []; let count = 0;
    q.onsuccess = () => {
      const cursor = q.result;
      if (cursor) {
        if (++count > MAX_IMAGES) { evicted.push(cursor.primaryKey); cursor.delete(); tx.objectStore(RETRIES).delete(cursor.primaryKey); }
        else for (const id of cursor.value.assetIds || []) used.add(id);
        cursor.continue(); return;
      }
      const keys = tx.objectStore(ASSETS).openKeyCursor();
      keys.onsuccess = () => { const cursor = keys.result; if (!cursor) return; if (!used.has(cursor.primaryKey)) { tx.objectStore(ASSETS).delete(cursor.primaryKey); tx.objectStore(PREVIEWS).delete(cursor.primaryKey); } cursor.continue(); };
      onEvicted(evicted);
    };
  }
  async function save(item, retry = null) {
    const data = pack(item, retry);
    let thumbnail = null;
    if (item.blob && item.kind !== 'failed') {
      try {
        thumbnail = await ImageWork.run({ type: 'thumbnail', blob: item.blob });
        data.meta.width = thumbnail.sourceWidth; data.meta.height = thumbnail.sourceHeight;
        data.meta.aspectRatio = thumbnail.sourceWidth / thumbnail.sourceHeight;
        if (!data.meta.size) data.meta.size = data.meta.aspectRatio >= 1 ? '1.4:1' : '1:1.4';
        if (!data.meta.state && data.meta.kind === 'import') data.meta.state = { subject: data.meta.subject, size: data.meta.size };
      } catch (error) { console.warn('缩略图稍后重试', error); }
    }
    return serial(async () => {
      let evicted = [];
      try {
        const db = await open(), tx = db.transaction(stores, 'readwrite'), completion = done(tx);
        for (const a of data.assets) tx.objectStore(ASSETS).put(a);
        if (thumbnail) tx.objectStore(PREVIEWS).put({ id: data.meta.assetId, blob: thumbnail.blob, width: thumbnail.width, height: thumbnail.height });
        tx.objectStore(RECORDS).put(data.meta);
        if (data.snapshot) tx.objectStore(RETRIES).put(data.snapshot); else tx.objectStore(RETRIES).delete(data.meta.id);
        prune(tx, ids => { evicted = ids; });
        await completion;
        transient.delete(data.meta.id);
        return { item: data.meta, cached: true, evicted };
      } catch (error) {
        console.warn('浏览器缓存写入失败', error);
        transient.set(data.meta.id, data);
        for (const a of data.assets) transientAssets.set(a.id, { ...a, thumbnail });
        while (transient.size > MAX_IMAGES) transient.delete(transient.keys().next().value);
        collectTransientAssets();
        return { item: data.meta, cached: false, evicted };
      }
    });
  }
  function collectTransientAssets() {
    const used = new Set([...transient.values()].flatMap(data => data.meta.assetIds || []));
    for (const id of transientAssets.keys()) if (!used.has(id)) transientAssets.delete(id);
  }
  async function remove(id) {
    return serial(async () => {
      id = String(id);
      const db = await open(), tx = db.transaction(stores, 'readwrite'), completion = done(tx);
      tx.objectStore(RECORDS).delete(id); tx.objectStore(RETRIES).delete(id);
      prune(tx, () => {});
      await completion;
      transient.delete(id); collectTransientAssets();
    });
  }
  async function original(value) {
    if (value?.blob) return value.blob;
    const id = typeof value === 'string' ? value : value?.assetId;
    if (!id) throw new Error('原图数据缺失');
    const a = transientAssets.get(id) || await get(ASSETS, id);
    if (!a?.blob) throw new Error('原图已清理或无法读取');
    return a.blob;
  }
  async function preview(id) {
    if (previewJobs.has(id)) return previewJobs.get(id);
    const job = (async () => {
      const temp = transientAssets.get(id);
      if (temp?.thumbnail) return temp.thumbnail.blob;
      const existing = await get(PREVIEWS, id);
      if (existing?.blob) return existing.blob;
      const blob = await original(id), thumb = await ImageWork.run({ type: 'thumbnail', blob });
      if (temp) temp.thumbnail = thumb;
      else await serial(async () => {
        const db = await open(), tx = db.transaction([ASSETS, PREVIEWS], 'readwrite'), completion = done(tx);
        // Avoid resurrecting an asset that was deleted while its thumbnail was being built.
        const q = tx.objectStore(ASSETS).getKey(id);
        q.onsuccess = () => { if (q.result !== undefined) tx.objectStore(PREVIEWS).put({ id, blob: thumb.blob, width: thumb.width, height: thumb.height }); };
        await completion;
      }).catch(error => console.warn('预览缓存保存失败', error));
      return thumb.blob;
    })();
    previewJobs.set(id, job);
    try { return await job; } finally { previewJobs.delete(id); }
  }
  async function retry(id) { return transient.get(String(id))?.snapshot || get(RETRIES, id); }
  function retain(values) {
    const ids = [...new Set(values.map(value => value?.assetId).filter(Boolean))];
    for (const id of ids) pins.set(id, (pins.get(id) || 0) + 1);
    return () => { for (const id of ids) { const n = (pins.get(id) || 1) - 1; n ? pins.set(id, n) : pins.delete(id); } };
  }
  return { open, list, save, remove, original, preview, retry, summary, retain, close() { connection?.close(); connection = null; ready = null; } };
})();
