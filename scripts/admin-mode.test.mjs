import assert from 'node:assert/strict';
import fs from 'node:fs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const models = ['gpt-image-2', 'gpt-image-2-official', 'gpt-image-2.5-sunburst'];
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined });
try {
  const page = await browser.newPage({ viewport: { width:390, height:844 } });
  const errors=[]; page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',async route=>{
    const request=route.request(), url=request.url();
    if(url==='http://admin-test.local/')return route.fulfill({ contentType:'text/html',body:html });
    if(url.endsWith('/admin-access')) {
      const admin=request.headers().authorization==='Bearer test-admin';
      return route.fulfill({ json:{admin,models:admin?models:[],prices:admin?{'gpt-image-2':0.3,'gpt-image-2-official':0.8,'gpt-image-2.5-sunburst':0.3}:{}} });
    }
    if(url.endsWith('/generations'))return route.fulfill({ status:400,json:{error:'测试请求，未计费'} });
    return route.abort();
  });
  await page.goto('http://admin-test.local/');await page.locator('#openSettings').click();
  assert.equal(await page.locator('#adminModelField').isVisible(),false);
  assert.equal(await page.locator('#adminSettingsEntry').isVisible(),false);
  assert.equal(await page.locator('#adminModel option').count(),0);
  await page.locator('#apiKey').fill('test-admin');
  await page.locator('#adminSettingsEntry').waitFor({state:'visible'});
  await page.locator('#openAdminSettings').click();
  await page.locator('#adminModelField').waitFor({state:'visible'});
  assert.deepEqual(await page.locator('#adminModel option').allTextContents(),['gpt-image-2 · 收费 0.3','gpt-image-2-official · 收费 0.8','gpt-image-2.5-sunburst · 收费 0.3']);
  await page.locator('#adminModel').selectOption('gpt-image-2.5-sunburst');
  await page.locator('#saveSettings').click();await page.reload();await page.locator('#openSettings').click();
  await page.locator('#adminSettingsEntry').waitFor({state:'visible'});
  await page.locator('#openAdminSettings').click();
  await page.locator('#adminModelField').waitFor({state:'visible'});
  assert.equal(await page.locator('#adminModel').inputValue(),'gpt-image-2.5-sunburst');
  await page.locator('#saveSettings').click();
  await page.locator('#subject').fill('管理员模型测试');
  const requestPromise=page.waitForRequest(request=>request.url().endsWith('/generations'));
  await page.locator('#generate').click();
  assert.equal((await requestPromise).postDataJSON().admin_model,'gpt-image-2.5-sunburst');
  await page.locator('#openSettings').click();await page.locator('#apiKey').fill('ordinary-key');
  assert.equal(await page.locator('#adminModelField').isVisible(),false);
  assert.equal(await page.locator('#adminSettingsEntry').isVisible(),false);
  assert.equal(await page.locator('#adminModel option').count(),0);
  await page.locator('#saveSettings').click();await page.reload();await page.locator('#openSettings').click();
  assert.equal(await page.locator('#adminModelField').isVisible(),false);
  assert.equal(await page.locator('#adminSettingsEntry').isVisible(),false);
  assert.equal(await page.locator('#adminModel option').count(),0);
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('tonghua-commercial-settings-v1')).adminModel),'');
  assert(!(await page.locator('#modal').innerText()).includes('gpt-image'));
  assert.deepEqual(errors,[]);
  console.log('Admin UI tests passed: key verification, hidden ordinary controls, model selection/persistence/requests, privilege reset on key replacement.');
}finally{await browser.close()}
