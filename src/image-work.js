// Copy file-backed and legacy cached Blobs into readable bytes before upload/storage.
async function readImageBytes(blob) {
  if (!blob || !blob.size) throw new Error('图片数据为空，请重新选择原图');
  let bytes;
  try { bytes = await blob.arrayBuffer(); }
  catch (error) {
    if (typeof FileReader === 'undefined') throw new Error('无法读取原图，请重新选择或导入原图后重试');
    bytes = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reader.onabort = () => reject(new Error('无法读取原图，请重新选择或导入原图后重试'));
      reader.readAsArrayBuffer(blob);
    });
  }
  if (!bytes || bytes.byteLength !== blob.size) throw new Error('原图数据不完整，请重新选择或导入原图后重试');
  return bytes;
}
async function readableImageBlob(blob) {
  return new Blob([await readImageBytes(blob)], { type: blob.type || '' });
}
// The DOM image decoder provides a second path when ImageBitmap fails on mobile.
async function decodeImageSource(blob, preferDOM = false) {
  if (!preferDOM && typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob);
      return { image: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch (error) {
      if (typeof document === 'undefined') throw error;
    }
  }
  if (typeof document === 'undefined') throw new Error('图片需要使用页面兼容模式读取');
  const img = document.createElement('img'), url = URL.createObjectURL(blob);
  const close = () => { img.onload = img.onerror = null; img.removeAttribute('src'); URL.revokeObjectURL(url); };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { close(); reject(new Error('读取图片超时，请重新选择原图后重试')); }, 30000);
      img.onload = () => { clearTimeout(timer); resolve(); };
      img.onerror = () => { clearTimeout(timer); reject(new Error('无法解码这张图片，请重新导入 PNG 或 JPG 原图后重试')); };
      img.src = url;
    });
    if (!img.naturalWidth || !img.naturalHeight) throw new Error('图片尺寸无效，请重新选择原图');
    return { image: img, width: img.naturalWidth, height: img.naturalHeight, close };
  } catch (error) { close(); throw error; }
}
// One graphics job at a time. OffscreenCanvas keeps decoding/encoding off the UI thread.
async function transformImage(job, preferDOM = false) {
  const source = await decodeImageSource(job.blob, preferDOM);
  const bitmap = source.image;
  let canvas;
  try {
    const sourceWidth = source.width, sourceHeight = source.height;
    if (job.type === 'dimensions') return { width: sourceWidth, height: sourceHeight };
    let width = sourceWidth, height = sourceHeight;
    if (job.type === 'thumbnail') {
      const scale = Math.min(1, 640 / Math.max(width, height));
      width = Math.max(1, Math.round(width * scale));
      height = Math.max(1, Math.round(height * scale));
    }
    canvas = !preferDOM && typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('浏览器无法处理这张图片');
    if (job.type !== 'thumbnail') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height); }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (job.type === 'pale') ctx.globalAlpha = .15;
    const scale = Math.min(width / sourceWidth, height / sourceHeight);
    const w = sourceWidth * scale, h = sourceHeight * scale;
    ctx.drawImage(bitmap, (width - w) / 2, (height - h) / 2, w, h);
    const type = job.type === 'thumbnail' ? 'image/webp' : job.type === 'pale' ? 'image/jpeg' : 'image/png';
    const quality = job.type === 'thumbnail' ? .9 : 1;
    const blob = canvas.convertToBlob ? await canvas.convertToBlob({ type, quality }) : await new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('图片导出失败')), type, quality));
    return { blob, width, height, sourceWidth, sourceHeight, aspectRatio: width / height };
  } finally {
    source.close();
    if (canvas) { canvas.width = 1; canvas.height = 1; }
  }
}
const ImageWork = (() => {
  let tail = Promise.resolve(), worker = null, disabled = false, nextId = 0;
  const waiting = new Map();
  function stop(error) {
    disabled = true;
    worker?.terminate(); worker = null;
    for (const entry of waiting.values()) entry.reject(error);
    waiting.clear();
  }
  function getWorker() {
    if (disabled || typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return null;
    if (worker) return worker;
    const code = `${decodeImageSource.toString()}\n${transformImage.toString()}\nself.onmessage=async e=>{const {id,job}=e.data;try{self.postMessage({id,result:await transformImage(job)})}catch(error){self.postMessage({id,error:error.message})}};`;
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    try {
      worker = new Worker(url);
      worker.onmessage = e => {
        const entry = waiting.get(e.data.id); if (!entry) return;
        waiting.delete(e.data.id);
        e.data.error ? entry.reject(new Error(e.data.error)) : entry.resolve(e.data.result);
      };
      worker.onerror = e => { e.preventDefault(); stop(new Error('图片后台处理暂不可用')); };
      return worker;
    } catch { disabled = true; return null; }
    finally { URL.revokeObjectURL(url); }
  }
  async function process(job) {
    let preferDOM = false;
    const w = getWorker();
    if (w) {
      try { return await new Promise((resolve, reject) => { const id = ++nextId; waiting.set(id, { resolve, reject }); w.postMessage({ id, job }); }); }
      catch (error) {
        // A worker can start successfully yet fail to decode a particular Blob.
        stop(error); preferDOM = true;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 16));
    return transformImage(job, preferDOM);
  }
  return {
    run(job) { const result = tail.then(() => process(job)); tail = result.catch(() => {}); return result; },
    close() { stop(new Error('页面已关闭')); }
  };
})();
function blobDimensions(blob) { return ImageWork.run({ type: 'dimensions', blob }); }

// Object URLs belong to a visible image/preview, not to an entire gallery record.
const ImageURLs = (() => {
  const urls = new Map();
  return {
    set(img, blob) { this.release(img); const url = URL.createObjectURL(blob); urls.set(img, url); img.src = url; },
    release(img) { img.removeAttribute('src'); const url = urls.get(img); if (url) URL.revokeObjectURL(url); urls.delete(img); },
    clear() { for (const img of [...urls.keys()]) this.release(img); }
  };
})();
