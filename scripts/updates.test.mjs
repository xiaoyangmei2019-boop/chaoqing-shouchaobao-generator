import assert from 'node:assert/strict';
import fs from 'node:fs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
let html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const current = html.match(/<meta name="app-version" content="([^"]+)"/)[1];
html = html.replace('\n})();\n</script>', '\nwindow.updateTest={checkAppVersion,renderUpdateNotice,runningTasks,GalleryStore,expireVersionCheck:()=>{lastVersionCheck.checkedAt=0;localStorage.removeItem(VERSION_CHECK_KEY)}};\n})();\n</script>');
let remote=current, endpointStatus=200, checks=0;
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE || undefined});
try {
 const page=await browser.newPage({viewport:{width:390,height:844}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>{
  const url=new URL(route.request().url());
  if(url.pathname==='/api/image-tasks/version') {
   checks++;
   assert.equal(route.request().headers().authorization,undefined);
   assert(url.searchParams.has('_t'));
   return route.fulfill({status:endpointStatus,json:{version:remote}});
  }
  if(url.origin==='http://updates-test.local' && url.pathname==='/') {
   const document=url.searchParams.has('_app_version')?html.replace(`content="${current}"`,`content="${remote}"`):html;
   return route.fulfill({contentType:'text/html',body:document});
  }
  return route.abort();
 });
 await page.goto('http://updates-test.local/?existing=kept#gallery');
 await page.evaluate(()=>window.updateTest.checkAppVersion());
 assert.equal(await page.locator('#appUpdate').isVisible(),false);
 const firstChecks=checks;
 await page.evaluate(()=>{ window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')); });
 await page.evaluate(()=>window.updateTest.checkAppVersion());
 assert.equal(checks,firstChecks,'focus and online must not bypass the daily interval');
 await page.reload();await page.evaluate(()=>window.updateTest.checkAppVersion());
 assert.equal(checks,firstChecks,'reloading must preserve the last check time');
 await page.evaluate(()=>window.updateTest.expireVersionCheck());
 remote='not-a-version';await page.evaluate(()=>window.updateTest.checkAppVersion());
 assert.equal(await page.locator('#appUpdate').isVisible(),false);
 await page.evaluate(()=>window.updateTest.expireVersionCheck());
 remote='v-111111111111';endpointStatus=503;await page.evaluate(()=>window.updateTest.checkAppVersion());
 assert.equal(await page.locator('#appUpdate').isVisible(),false);
 const failedChecks=checks;await page.evaluate(()=>window.updateTest.checkAppVersion());assert.equal(checks,failedChecks,'failed checks also respect the daily interval');
 await page.evaluate(()=>window.updateTest.expireVersionCheck());
 endpointStatus=200;await page.evaluate(()=>window.updateTest.checkAppVersion());
 assert.equal(await page.locator('#appUpdate').isVisible(),true);
 const originalURL=page.url();
 await page.evaluate(()=>{window.updateTest.runningTasks.set('busy',{});window.updateTest.renderUpdateNotice()});
 assert.equal(await page.locator('#updateNow').isDisabled(),true);assert.equal(page.url(),originalURL);
 await page.evaluate(()=>{window.updateTest.runningTasks.delete('busy');window.updateTest.renderUpdateNotice()});
 assert.equal(await page.locator('#updateNow').isEnabled(),true);
 await page.locator('#updateLater').click();await page.evaluate(()=>window.updateTest.checkAppVersion());
 assert.equal(await page.locator('#appUpdate').isVisible(),false);
 await page.reload();await page.evaluate(()=>window.updateTest.checkAppVersion());
 assert.equal(await page.locator('#appUpdate').isVisible(),false,'defer persists across page reload');
 await page.evaluate(()=>window.updateTest.expireVersionCheck());
 remote='v-222222222222';await page.evaluate(()=>window.updateTest.checkAppVersion());
 assert.equal(await page.locator('#appUpdate').isVisible(),true);
 // A refresh must never silently discard records held only in memory.
 await page.evaluate(()=>{window.originalUnsavedCheck=window.updateTest.GalleryStore.hasUnsavedRecords;window.updateTest.GalleryStore.hasUnsavedRecords=()=>true});
 await page.locator('#updateNow').click();assert.equal(page.url(),originalURL);
 assert((await page.locator('#toast').innerText()).includes('尚未保存'));
 await page.evaluate(()=>{window.updateTest.GalleryStore.hasUnsavedRecords=window.originalUnsavedCheck});
 await page.locator('#importImageInput').setInputFiles(new URL('../server/fixtures/output-test.jpg',import.meta.url).pathname);
 await page.waitForSelector('.completed-card');
 await page.evaluate(()=>localStorage.setItem('tonghua-commercial-settings-v1',JSON.stringify({route:'line2',outputFormat:'jpeg',apiKey:''})));
 await page.locator('#subject').fill('更新前未提交的主题草稿');
 if(process.env.UPDATE_SCREENSHOT)await page.screenshot({path:process.env.UPDATE_SCREENSHOT});
 await page.locator('#updateNow').click();
 await page.waitForURL(url=>url.searchParams.get('_app_version')===remote);
 await page.waitForSelector('.completed-card');
 assert.equal(new URL(page.url()).searchParams.get('existing'),'kept');
 assert.equal(new URL(page.url()).hash,'#gallery');
 assert.equal(await page.locator('#subject').inputValue(),'更新前未提交的主题草稿');
 assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('tonghua-commercial-settings-v1')).route),'line2');
 await page.evaluate(()=>window.updateTest.checkAppVersion());
 assert.equal(await page.locator('#appUpdate').isVisible(),false);
 assert.deepEqual(errors,[]);
 console.log('Update tests passed: daily persistent throttling and defer, current/new/invalid/offline versions, task guard, defer, transient guard, refresh URL, draft/gallery/settings retention.');
} finally {await browser.close()}
