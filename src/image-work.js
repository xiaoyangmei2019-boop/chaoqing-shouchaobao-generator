// One graphics job at a time. OffscreenCanvas keeps decoding/encoding off the UI thread.
async function transformImage(job) {
  const bitmap = await createImageBitmap(job.blob);
  let canvas;
  try {
    const sourceWidth = bitmap.width, sourceHeight = bitmap.height;
    if (job.type === 'dimensions') return { width: sourceWidth, height: sourceHeight };
    let width = sourceWidth, height = sourceHeight;
    if (job.type === 'thumbnail') {
      const scale = Math.min(1, 640 / Math.max(width, height));
      width = Math.max(1, Math.round(width * scale));
      height = Math.max(1, Math.round(height * scale));
    } else if (job.type === 'normalize') {
      if (job.exact) { width = job.dimensions.width; height = job.dimensions.height; }
      else {
        const ratio = job.dimensions.width / job.dimensions.height;
        if (ratio >= 1) height = Math.max(1, Math.round(width / ratio));
        else width = Math.max(1, Math.round(height * ratio));
      }
    }
    canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : document.createElement('canvas');
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
    bitmap.close();
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
    const code = `${transformImage.toString()}\nself.onmessage=async e=>{const {id,job}=e.data;try{self.postMessage({id,result:await transformImage(job)})}catch(error){self.postMessage({id,error:error.message})}};`;
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
    const w = getWorker();
    if (w) {
      try { return await new Promise((resolve, reject) => { const id = ++nextId; waiting.set(id, { resolve, reject }); w.postMessage({ id, job }); }); }
      catch (error) { if (!disabled) throw error; }
    }
    await new Promise(resolve => setTimeout(resolve, 16));
    return transformImage(job);
  }
  return {
    run(job) { const result = tail.then(() => process(job)); tail = result.catch(() => {}); return result; },
    close() { stop(new Error('页面已关闭')); }
  };
})();
function blobDimensions(blob) { return ImageWork.run({ type: 'dimensions', blob }); }
function normalizeLineArtOutput(blob, dimensions, exact = false) { return ImageWork.run({ type: 'normalize', blob, dimensions, exact }); }

// Object URLs belong to a visible image/preview, not to an entire gallery record.
const ImageURLs = (() => {
  const urls = new Map();
  return {
    set(img, blob) { this.release(img); const url = URL.createObjectURL(blob); urls.set(img, url); img.src = url; },
    release(img) { img.removeAttribute('src'); const url = urls.get(img); if (url) URL.revokeObjectURL(url); urls.delete(img); },
    clear() { for (const img of [...urls.keys()]) this.release(img); }
  };
})();
