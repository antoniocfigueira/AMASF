import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { scan } from '../src/crawler.mjs';
import { generateReport } from '../src/report.mjs';
import { evaluateAccessMonitor } from '../src/engines.mjs';
import { createRequire } from 'node:module';

test('crawler, motores, robots, retoma, relatório e interface funcionam em conjunto', { timeout: 180000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'asf-audit-test-'));
  const server = http.createServer((req,res) => {
    if (req.url === '/robots.txt') { res.setHeader('Content-Type','text/plain'); res.end('User-agent: *\nDisallow: /private'); return; }
    if (req.url === '/sitemap.xml') { res.setHeader('Content-Type','application/xml'); res.end(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>http://127.0.0.1:${server.address().port}/sitemap-only</loc></url><url><loc>http://127.0.0.1:${server.address().port}/private</loc></url></urlset>`); return; }
    res.setHeader('Content-Type','text/html; charset=utf-8');
    if (req.url === '/challenge') { res.end('<html><title>Verificação de Segurança</title><body>Insira o código da imagem. Your support ID is 123.</body></html>'); return; }
    if (req.url === '/private') { res.statusCode = 500; res.end('Nunca deve ser visitada'); return; }
    res.end('<!doctype html><html lang="pt-PT"><head><title>Página de teste</title></head><body><a href="#main">Saltar para conteúdo</a><main id="main"><h1>Teste de acessibilidade</h1><p>Uma página de teste com conteúdo suficiente para avaliar o comportamento da ferramenta.</p>' + (req.url === '/' ? '<a href="/second?utm_source=test">Segunda página</a><a href="/second">Duplicado</a><a href="/report.pdf">Documento</a><button></button><img src="data:image/png;base64,iVBORw0KGgo="><button id="open-panel" onclick="document.getElementById(\'panel\').hidden=false">Abrir painel</button><div id="panel" hidden>Conteúdo do painel expandido</div>' : '<button>Continuar</button>') + '</main></body></html>');
  });
  await new Promise(r => server.listen(0,'127.0.0.1',r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const config = { url:origin+'/',name:'Teste </script><script>window.pwned=true</script>',allowedHosts:[new URL(origin).host],maxDiscovered:100,maxPages:2,maxDepth:3,maxQueryVariants:3,maxSitemapUrls:100,concurrency:1,delayMs:1,timeoutMs:15000,settleMs:10,engineTimeoutMs:45000,viewports:[{name:'desktop',width:1366,height:768},{name:'mobile',width:390,height:844}],sessionDir:join(temp,'session'),accessMonitor:true,axe:true,screenshots:true,saveHtml:true,headless:true,sitemaps:[origin+'/sitemap.xml'],beforeEach:[],scenarios:[{name:'painel-aberto',urlPattern:'/$',viewports:['desktop'],steps:[{action:'click',selector:'#open-panel'},{action:'waitFor',selector:'#panel'}]}] };
  let browser;
  try {
    const first = await scan(config,join(temp,'run'));
    assert.equal(first.status,'limited');
    assert.equal(first.inventory.filter(p=>p.status==='ok').length,2);
    assert.equal(first.inventory.filter(p=>p.url===origin+'/second').length,1);
    assert.ok(first.observations.every(o=>Number.isFinite(o.accessMonitor?.score)));
    assert.equal(first.observations.length,5);
    assert.equal(first.observations.filter(o=>o.scenario==='painel-aberto').length,1);
    assert.ok(first.observations.some(o=>o.practices.some(p=>p.id==='button-name')));
    const resumed = await scan({...config,maxPages:6},join(temp,'run'),{resume:true});
    assert.equal(resumed.inventory.find(p=>p.url.endsWith('/private')).status,'robots-excluded');
    assert.equal(resumed.observations.length,7);
    const report = await generateReport(join(temp,'run'));
    assert.ok(report.findings.some(f=>f.id==='button-name'));
    assert.equal(report.summary.required,2);
    const html = await readFile(join(temp,'run/report.html'),'utf8');
    assert.ok(html.includes('\\u003c/script>'));
    browser = await chromium.launch({channel:'chrome',headless:true});
    const context = await browser.newContext({bypassCSP:true});
    const page = await context.newPage();
    const errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    const {pathToFileURL}=await import('node:url');
    await page.goto(pathToFileURL(join(temp,'run/report.html')).href);
    await page.waitForFunction(()=>window.__reportReady);
    assert.equal(await page.evaluate(()=>window.pwned),undefined);
    await page.locator('[data-page="findings"]').click();
    await page.locator('#search').fill('button-name');
    assert.ok(await page.locator('.issue').count());
    await page.locator('[data-page="seal"]').click();
    assert.equal(await page.locator('.requirement').count(),27);
    const review = page.locator('.requirement').first();
    await review.locator('textarea').fill('Teste de teclado e screenshot da página.');
    await review.locator('select').selectOption('pass');
    await page.reload();
    await page.waitForFunction(()=>window.__reportReady);
    assert.equal(await page.locator('.requirement').first().locator('select').inputValue(),'pass');
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false);
    assert.deepEqual(errors,[]);
    await page.screenshot({path:join(temp,'report-mobile.png'),fullPage:true});
    // Browser adapter vs original QualWeb core on the same URL and viewport.
    const require=createRequire(import.meta.url);
    const {QualWeb}=require('@qualweb/core');
    const {ACTRules}=require('@qualweb/act-rules');
    const {WCAGTechniques}=require('@qualweb/wcag-techniques');
    const {BestPractices}=require('@qualweb/best-practices');
    const {Counter}=require('@qualweb/counter');
    const {parseEvaluation}=require('../vendor/accessmonitor.cjs');
    const engine=new QualWeb();
    try {
      await engine.start({maxConcurrency:1},{headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
      const native=await engine.evaluate({url:origin+'/second',modules:[new ACTRules(),new WCAGTechniques(),new BestPractices(),new Counter()],viewport:{resolution:{width:1366,height:768}}});
      const nativeMapped=parseEvaluation(native[origin+'/second']);
      await page.setViewportSize({width:1366,height:768});
      const response=await page.goto(origin+'/second');
      const adapted=await evaluateAccessMonitor(page,await response.text());
      assert.equal(adapted.score,Number(nativeMapped.data.score));
      assert.deepEqual(Object.keys(adapted.mapped.data.tot.results).sort(),Object.keys(nativeMapped.data.tot.results).sort());
    } finally { await engine.stop(); }
    const blocked=await scan({...config,url:origin+'/challenge',seeds:[],sitemaps:[],maxPages:1,sessionDir:join(temp,'challenge-session')},join(temp,'blocked'));
    assert.equal(blocked.status,'blocked');
    assert.equal(blocked.observations[0].accessMonitor,undefined);
    console.log('Evidências de integração:',temp);
  } finally { await browser?.close(); await new Promise(r=>server.close(r)); }
});
