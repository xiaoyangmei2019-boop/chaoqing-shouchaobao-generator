// A running page can discover later deployments without clearing site data.
const APP_VERSION = document.querySelector('meta[name="app-version"]')?.content || '';
const VERSION_CHECK_INTERVAL = 24 * 60 * 60 * 1000, VERSION_CHECK_KEY = 'tonghua-app-version-check-v1';
let availableVersion = '', deferredVersion = '', deferredUntil = 0, checkingVersion = false, versionCheckTimer = null;
function readVersionCheck() {
  try { return JSON.parse(localStorage.getItem(VERSION_CHECK_KEY) || '{}') || {}; } catch { return {}; }
}
function writeVersionCheck(status) {
  try { localStorage.setItem(VERSION_CHECK_KEY, JSON.stringify(status)); } catch {}
}
let lastVersionCheck = readVersionCheck();
function scheduleVersionCheck(delay = VERSION_CHECK_INTERVAL) {
  clearTimeout(versionCheckTimer);
  versionCheckTimer = setTimeout(checkAppVersion, Math.max(1000, delay));
}
function updateIsBusy() { return runningTasks.size > 0 || localLocks.size > 0 || retryLocks.size > 0; }
function renderUpdateNotice() {
  const panel = $('appUpdate');
  panel.hidden = !availableVersion || availableVersion === APP_VERSION
    || (availableVersion === deferredVersion && Date.now() < deferredUntil);
  if (panel.hidden) return;
  const busy = updateIsBusy();
  $('appUpdateMessage').textContent = busy
    ? '有新版本可用，当前任务仍在处理中，请完成后再更新。'
    : '刷新即可使用最新功能，本地图库和设置会保留。';
  $('updateNow').disabled = busy;
  $('updateNow').textContent = busy ? '任务处理中' : '刷新更新';
}
async function checkAppVersion() {
  if (!APP_VERSION || location.protocol === 'file:' || checkingVersion) return;
  const stored = readVersionCheck();
  if (Number(stored.checkedAt) > Number(lastVersionCheck.checkedAt || 0)) lastVersionCheck = stored;
  const now = Date.now(), checkedAt = Number(lastVersionCheck.checkedAt) || 0;
  if (checkedAt > 0 && checkedAt <= now && now - checkedAt < VERSION_CHECK_INTERVAL) {
    if (/^v-[0-9a-f]{12}$/.test(lastVersionCheck.version || '')) {
      // A manually refreshed newer page must not offer an older cached manifest as an update.
      availableVersion = lastVersionCheck.pageVersion === APP_VERSION && lastVersionCheck.version !== APP_VERSION ? lastVersionCheck.version : '';
      deferredVersion = lastVersionCheck.deferredVersion || '';
      deferredUntil = Number(lastVersionCheck.deferredUntil) || 0;
      renderUpdateNotice();
    }
    scheduleVersionCheck(VERSION_CHECK_INTERVAL - (now - checkedAt));
    return;
  }
  if (document.hidden || !navigator.onLine) { scheduleVersionCheck(); return; }
  checkingVersion = true;
  // Record attempts too, so a failing endpoint cannot cause frequent focus/reload requests.
  lastVersionCheck = { ...lastVersionCheck, checkedAt: now, pageVersion: APP_VERSION };
  writeVersionCheck(lastVersionCheck);
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(getSettings().taskApiBase + '/version?_t=' + Date.now(), {
      cache: 'no-store', signal: controller.signal
    });
    if (!response.ok) return;
    const manifest = await response.json();
    if (!/^v-[0-9a-f]{12}$/.test(manifest.version)) return;
    lastVersionCheck = { ...lastVersionCheck, version: manifest.version };
    writeVersionCheck(lastVersionCheck);
    availableVersion = manifest.version === APP_VERSION ? '' : manifest.version;
    renderUpdateNotice();
  } catch { /* Offline/version-endpoint failures must not interrupt image tasks. */ }
  finally { clearTimeout(timer); checkingVersion = false; scheduleVersionCheck(); }
}
$('updateLater').onclick = () => {
  deferredVersion = availableVersion; deferredUntil = Date.now() + VERSION_CHECK_INTERVAL;
  lastVersionCheck = { ...lastVersionCheck, deferredVersion, deferredUntil }; writeVersionCheck(lastVersionCheck);
  renderUpdateNotice();
};
$('updateNow').onclick = () => {
  if (!availableVersion || updateIsBusy()) { renderUpdateNotice(); return; }
  if (GalleryStore.hasUnsavedRecords()) { toast('有图片或记录尚未保存到本地，请先下载图片或处理临时记录后再更新'); return; }
  if ((uploadedReferences.length || imageEditDrafts.size || imageEditCurrentItem)
      && !confirm('刷新会清除尚未提交的参考图或修改草稿，确定现在更新吗？')) return;
  saveParams();
  const url = new URL(location.href);
  url.searchParams.set('_app_version', availableVersion);
  location.replace(url.href);
};
scheduleVersionCheck(1500);
setInterval(() => { if (availableVersion && !document.hidden) renderUpdateNotice(); }, 3000);
window.addEventListener('online', checkAppVersion);
window.addEventListener('focus', checkAppVersion);
window.addEventListener('pageshow', checkAppVersion);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkAppVersion(); });
