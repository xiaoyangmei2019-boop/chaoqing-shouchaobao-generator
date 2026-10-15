import assert from 'node:assert/strict';
import fs from 'node:fs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
let html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
html = html.replace('\n})();\n</script>', '\nwindow.designTest={GalleryStore,createFailedCard,placeCard,galleryReady};\n})();\n</script>');
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined });
try {
 for (const width of [320,390,820,1440]) {
  const page = await browser.newPage({ viewport: { width, height:900 } });
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>route.request().url()==='http://design-test.local/'?route.fulfill({contentType:'text/html',body:html}):route.abort());
  await page.goto('http://design-test.local/');
  await page.locator('#importImageInput').setInputFiles(new URL('../server/fixtures/output-test.jpg',import.meta.url).pathname);
  await page.waitForSelector('.completed-card .card-title');
  assert.equal(await page.locator('.completed-card .meta').innerText(),'本地导入\nJPG');
  await page.evaluate(async()=>{
   const t=window.designTest;await t.galleryReady;
   const item={id:'failure',kind:'failed',failureType:'lineart',subject:'长标题测试'.repeat(15),size:'1.4:1',errorType:'busy',failureTitle:'当前排队拥挤',error:'当前使用人数较多，请稍后重新生成。'.repeat(10)};
   t.placeCard(t.createFailedCard(item),null,[]);
  });
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`overflow at ${width}`);
  if(width<=780)assert.equal(await page.locator('.gallery').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length),2);
  const button=page.locator('.failure-dismiss');await button.scrollIntoViewIfNeeded();
  assert(await button.isVisible());
  // Keyboard actions remain reachable after adding the visible caption.
  await page.locator('.completed-card').scrollIntoViewIfNeeded();
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await page.locator('.completed-card').focus();await page.keyboard.press('Enter');
  assert(await page.locator('#contextMenu').evaluate(el=>el.classList.contains('open')));
  await page.keyboard.press('Escape');
  await page.locator('#openSettings').click();
  await page.locator('#outputFormat').selectOption('jpeg');await page.locator('#saveSettings').click();
  await page.reload();await page.waitForSelector('.completed-card .card-title');
  assert.equal(await page.locator('.completed-card .meta').innerText(),'本地导入\nJPG');
  if (process.env.DESIGN_SCREENSHOT_DIR && [390,1440].includes(width)) {
   await page.evaluate(()=>window.scrollTo(0,0));
   await page.screenshot({path:process.env.DESIGN_SCREENSHOT_DIR+'/design-'+width+'.png',fullPage:true});
  }
  assert.deepEqual(errors,[]);
  await page.close();
 }
 console.log('Design tests passed: 320/390/820/1440 layouts, two mobile columns, import/captions/MIME persistence, long errors, keyboard menu, settings.');
}finally{await browser.close()}
