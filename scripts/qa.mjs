import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { mkdir } from 'node:fs/promises';
const browser = await chromium.launch({channel:'chrome',headless:true});
await mkdir('qa',{recursive:true});
try {
  const context = await browser.newContext({viewport:{width:1440,height:1000}});
  const page = await context.newPage();
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:4177/');
  await page.waitForTimeout(500);
  await page.screenshot({path:'qa/dashboard-desktop.png',fullPage:true});
  console.log('Dashboard axe:',JSON.stringify((await new AxeBuilder({page}).analyze()).violations.map(r=>({id:r.id,impact:r.impact,count:r.nodes.length}))));
  await page.goto('http://127.0.0.1:4177/runs/asf-smoke/report.html');
  await page.waitForFunction(()=>window.__reportReady);
  await page.screenshot({path:'qa/report-desktop.png',fullPage:true});
  console.log('Report axe:',JSON.stringify((await new AxeBuilder({page}).analyze()).violations.map(r=>({id:r.id,impact:r.impact,count:r.nodes.length}))));
  await page.locator('[data-page="findings"]').click();
  await page.locator('.issue').first().locator('summary').click();
  await page.screenshot({path:'qa/findings-desktop.png',fullPage:true});
  await page.locator('[data-page="seal"]').click();
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'qa/checklists-mobile.png',fullPage:false});
  console.log('Mobile overflow:',await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2));
  console.log('Browser errors:',JSON.stringify(errors));
} finally { await browser.close(); }
