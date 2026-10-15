import assert from 'node:assert/strict';
import fs from 'node:fs';
const { chromium, devices } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = new URL('../', import.meta.url);
const html = fs.readFileSync(new URL('index.html', root), 'utf8');
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined });
try {
  for (const device of [devices['iPhone 13'], { viewport: { width: 390, height: 844 } }]) {
  const mobile = Boolean(device.isMobile);
  const page = await browser.newPage(device);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url() === 'http://format-test.local/'
    ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
  await page.goto('http://format-test.local/');
  await page.locator('#openSettings').click();
  assert.equal(await page.locator('#outputFormat').inputValue(), mobile ? 'jpeg' : 'png');
  // Old settings with only a key inherit the device default after upgrading.
  await page.evaluate(() => localStorage.setItem('tonghua-commercial-settings-v1', JSON.stringify({ apiKey: '' })));
  await page.reload(); await page.locator('#openSettings').click();
  assert.equal(await page.locator('#outputFormat').inputValue(), mobile ? 'jpeg' : 'png');
  await page.locator('#outputFormat').selectOption('jpeg');
  if (process.env.SETTINGS_SCREENSHOT) await page.screenshot({ path: process.env.SETTINGS_SCREENSHOT });
  await page.locator('#saveSettings').click();
  await page.reload(); await page.locator('#openSettings').click();
  assert.equal(await page.locator('#outputFormat').inputValue(), 'jpeg');
  // Download naming follows the returned image bytes/MIME rather than the preference.
  await page.addScriptTag({ content: fs.readFileSync(new URL('src/references.js', root), 'utf8') });
  const gallery = fs.readFileSync(new URL('src/gallery.js', root), 'utf8');
  await page.addScriptTag({ content: gallery.slice(gallery.indexOf('function filename('), gallery.indexOf('async function download(')) });
  const extension = await page.evaluate(() => filename({ createdAt: Date.now(), blob: new Blob(['jpeg'], { type: 'image/jpeg' }) }));
  assert(extension.endsWith('.jpg'));
  await page.locator('#outputFormat').selectOption('png'); await page.locator('#saveSettings').click();
  await page.reload(); await page.locator('#openSettings').click();
  assert.equal(await page.locator('#outputFormat').inputValue(), 'png');
  assert.deepEqual(errors, []);
  await page.close();
  }
  console.log('Output format UI tests passed: mobile JPG, narrow desktop PNG, legacy settings, explicit JPG/PNG persistence, JPG filename.');
} finally { await browser.close(); }
