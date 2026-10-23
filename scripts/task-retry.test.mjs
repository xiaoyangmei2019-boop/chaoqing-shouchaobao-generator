import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
const root = process.env.GENERATOR_ROOT || new URL('../', import.meta.url).pathname;
const tasks = fs.readFileSync(root + '/src/tasks.js', 'utf8');
const records = new Map(), snapshots = new Map(), submissions = [], polls = [], notices = [];
let settings = { taskApiBase: 'https://test.invalid/api', apiKey: 'test-only', route: 'line1', adminModel: '', outputFormat: 'png', points: 3 };
let outcome = 'failed';
const source = { assetId: 'original', subject: 'source', size: '1:1.4' };
const blob = new Blob(['image'], { type: 'image/png' });
const context = vm.createContext({
  Blob, FormData, crypto: { randomUUID }, console,
  getSettings: () => ({ ...settings }),
  els: { generate: { lastElementChild: {} } }, activeJobs: 0,
  galleryReady: Promise.resolve(), galleryCards: new Map(),
  GalleryStore: {
    retain: () => () => {}, original: async () => blob,
    save: async (item, snapshot) => {
      records.set(item.id, structuredClone(item));
      if (snapshot) snapshots.set(item.id, structuredClone(snapshot));
      else snapshots.delete(item.id);
      return { item, evicted: [], cached: true };
    },
    retry: async id => structuredClone(snapshots.get(id)),
    list: async () => [...records.values()]
  },
  loadingCard: () => ({ dataset: {}, querySelector: () => ({ textContent: '' }) }),
  placeCard: () => {}, createCompletedCard: x => x, createFailedCard: x => x,
  removeGalleryRecord: () => {}, addLog: () => {}, playTaskSound: () => {},
  download: async () => {}, toast: msg => notices.push(msg), restoreItem: () => {},
  classifyError: msg => ({ type: 'server', title: '服务暂时繁忙', detail: msg }),
  blobDimensions: async () => ({ width: 100, height: 140 }),
  lineArtRequestSize: () => ({ size: '1024x1536' }),
  referenceExtension: () => 'png',
  submitAsyncImageTask: async (base, path, factory, headers, key, requestId) => {
    const body = factory();
    submissions.push({ path, payload: typeof body === 'string' ? JSON.parse(body) : Object.fromEntries(body), requestId });
    if (outcome === 'uncertain') throw Object.assign(new Error('connection lost'), { uncertain: true });
    return { id: 'server-' + submissions.length };
  },
  pollAsyncImageTask: async (base, id) => {
    polls.push(id);
    if (outcome === 'failed') throw Object.assign(new Error('server failed'), { confirmed: true });
    return { blob, points: 3 };
  }
});
vm.runInContext(tasks, context);
for (const type of ['generation', 'reference', 'lineart', 'edit']) {
  settings.route = 'line1'; settings.adminModel = 'gpt-image-2'; outcome = 'failed';
  const spec = { type, params: { subject: 'test', size: '1:1.4' }, source, references: [source], instruction: 'edit test' };
  await context.runTask(spec);
  const failed = [...records.values()].at(-1);
  assert.equal(failed.kind, 'failed');
  const old = snapshots.get(failed.id);
  assert(old.serverTaskId); assert(!old.clientRequestId);
  settings.route = 'line2'; settings.adminModel = ''; outcome = 'success';
  const count = submissions.length;
  await context.retryFailedTask(failed);
  assert.equal(submissions.length, count + 1, 'retry must create a new task after confirmed failure');
  assert.equal(submissions.at(-1).payload.route, 'line2');
  assert.equal(submissions.at(-1).payload.admin_model, undefined, 'stale admin override must not win');
  assert.notEqual(submissions.at(-1).requestId, submissions[count - 1].requestId);
  assert.notEqual(polls.at(-1), old.serverTaskId, 'must not poll previous failed task');
  assert.equal(records.get(failed.id).kind, type);
  if (type === 'edit') assert.equal(submissions.at(-1).payload.task_type, 'edit');
}
// Max and current administrator override also replace stale selections.
settings.route = 'line1'; outcome = 'failed';
await context.runTask({ type: 'generation', params: { subject: 'test', size: '1:1.4' } });
const failed = [...records.values()].at(-1);
settings.route = 'line3'; settings.adminModel = 'gpt-image-2-official'; outcome = 'success';
await context.retryFailedTask(failed);
assert.equal(submissions.at(-1).payload.route, 'line3');
assert.equal(submissions.at(-1).payload.admin_model, 'gpt-image-2-official');
// An ambiguous submission must replay the same identity and engine to recover safely.
settings.route = 'line1'; settings.adminModel = ''; outcome = 'uncertain';
await context.runTask({ type: 'generation', params: { subject: 'uncertain', size: '1:1.4' } });
const ambiguous = [...records.values()].at(-1), original = submissions.at(-1);
settings.route = 'line2'; outcome = 'success';
await context.retryFailedTask(ambiguous);
assert.equal(submissions.at(-1).requestId, original.requestId);
assert.equal(submissions.at(-1).payload.route, original.payload.route);
// Existing server jobs only poll, even when settings change.
const count = submissions.length;
await context.runTask({ type: 'generation', params: { subject: 'pending' }, route: 'line1', serverTaskId: 'existing-job', clientRequestId: 'existing-request' });
assert.equal(submissions.length, count);
assert.equal(polls.at(-1), 'existing-job');
assert(!notices.some(msg => msg.includes('切换') || msg.includes('引擎')));
console.log('Task retry checks passed: current Lite/Pro/Max routing and admin override, fresh task after failure, original identity for uncertain recovery, poll-only pending recovery, no new engine notices.');
