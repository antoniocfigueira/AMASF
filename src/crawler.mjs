import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { XMLParser } from 'fast-xml-parser';
import robotsParser from 'robots-parser';
import { ROOT, idFor, readJson, readRun, writeJson, sleep } from './util.mjs';
import { normalizeUrl, queueUrl, challengeReason } from './urls.mjs';
import { openBrowser, applySteps } from './browser.mjs';
import { collectFacts } from './facts.mjs';
import { runEngines } from './engines.mjs';

const require = createRequire(import.meta.url);
export async function loadConfig(path, overrides = {}) {
  const config = { ...(await readJson(resolve(ROOT, path || 'config/asf.json'))), ...overrides };
  config.allowedHosts ||= [new URL(config.url).host];
  config.maxDiscovered ||= 10000;
  config.maxQueryVariants ||= 12;
  config.maxSitemapUrls ||= 5000;
  config.maxPages ??= 250;
  config.maxDepth ??= 5;
  config.concurrency ??= 2;
  config.timeoutMs ??= 45000;
  config.settleMs ??= 1500;
  config.engineTimeoutMs ??= 90000;
  config.delayMs ??= 1000;
  config.viewports ||= [{ name: 'desktop', width: 1440, height: 900 }];
  config.beforeEach ||= [];
  config.scenarios ||= [];
  config.headless ??= true;
  config.axe ??= true;
  config.accessMonitor ??= true;
  if (!normalizeUrl(config.url, config.url, config)) throw new Error('URL inicial inválido ou fora dos hosts permitidos.');
  for (const key of ['maxPages', 'maxDiscovered', 'concurrency', 'timeoutMs', 'engineTimeoutMs', 'maxQueryVariants']) if (!Number.isInteger(config[key]) || config[key] < 1) throw new Error(`${key} deve ser inteiro positivo.`);
  if (config.concurrency > 8) throw new Error('Concorrência máxima: 8.');
  if (!Number.isInteger(config.maxDepth) || config.maxDepth < 1) throw new Error('maxDepth deve ser >= 1 para recolher a amostra mínima.');
  if (!config.axe && !config.accessMonitor) throw new Error('Ativa pelo menos um motor.');
  if (!config.viewports.length || new Set(config.viewports.map(v => v.name)).size !== config.viewports.length) throw new Error('As resoluções devem existir e ter nomes únicos.');
  for (const viewport of config.viewports) if (!viewport.name || !Number.isInteger(viewport.width) || !Number.isInteger(viewport.height) || viewport.width < 320 || viewport.height < 200) throw new Error('Resolução inválida.');
  for (const pattern of config.excludePatterns || []) new RegExp(pattern);
  for (const scenario of config.scenarios) { if (!scenario.name || !scenario.urlPattern) throw new Error('Cenário exige name e urlPattern.'); new RegExp(scenario.urlPattern); }
  return config;
}

async function requestText(context, url, maxBytes = 6_000_000) {
  const response = await context.request.get(url, { timeout: 18000, failOnStatusCode: false });
  const body = await response.body();
  if (body.length > maxBytes) throw new Error(`Resposta excede ${maxBytes} bytes`);
  return { status: response.status(), text: body.toString('utf8'), url: response.url() };
}

async function discoverMetadata(context, state, config, log) {
  let robots;
  const sitemaps = new Set(config.sitemaps || []);
  const origin = new URL(config.url).origin;
  try {
    const r = await requestText(context, `${origin}/robots.txt`, 1_000_000);
    if (r.status === 200 && !/^\s*</.test(r.text) && !challengeReason(r.text)) {
      robots = robotsParser(`${origin}/robots.txt`, r.text);
      for (const url of robots.getSitemaps()) if (normalizeUrl(url, config.url, config)) sitemaps.add(url);
      state.robots = { status: 'loaded', url: `${origin}/robots.txt` };
    } else state.warnings.push(`robots.txt indisponível ou devolveu HTML/HTTP ${r.status}; regras não confirmadas.`);
  } catch (e) { state.warnings.push(`robots.txt: ${e.message}`); }
  const visited = new Set();
  let found = 0;
  const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });
  while (sitemaps.size && visited.size < 30 && found < config.maxSitemapUrls) {
    const url = sitemaps.values().next().value;
    sitemaps.delete(url);
    if (visited.has(url) || !normalizeUrl(url, config.url, config)) continue;
    visited.add(url);
    try {
      await sleep(config.delayMs);
      const r = await requestText(context, url);
      if (r.status !== 200 || !/<(?:\w+:)?(?:urlset|sitemapindex)[\s>]/i.test(r.text)) throw new Error(`não é sitemap XML (HTTP ${r.status})`);
      const xml = parser.parse(r.text);
      const list = x => x ? Array.isArray(x) ? x : [x] : [];
      for (const item of list(xml.sitemapindex?.sitemap)) if (item.loc) sitemaps.add(item.loc);
      for (const item of list(xml.urlset?.url)) {
        if (found >= config.maxSitemapUrls) { state.sitemapLimitReached = true; break; }
        if (item.loc) { queueUrl(state, item.loc, config.url, 1, 'sitemap', config); found++; }
      }
      log(`Sitemap: ${found} URLs recolhidos.`);
    } catch (e) { state.warnings.push(`Sitemap ${url}: ${e.message}`); }
  }
  if (sitemaps.size || found >= config.maxSitemapUrls) state.sitemapLimitReached = true;
  return robots;
}

export async function scan(config, output, { resume = false, retryFailed = false, onProgress = () => {}, signal } = {}) {
  const dir = resolve(ROOT, output);
  await mkdir(join(dir, 'observations'), { recursive: true });
  await mkdir(join(dir, 'evidence'), { recursive: true });
  await mkdir(join(dir, 'raw'), { recursive: true });
  // Exclusive lock stops two processes using a run/profile at once.
  const lock = join(dir, '.running');
  await writeFile(lock, String(process.pid), { flag: 'wx' }).catch(async error => {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(await readFile(lock, 'utf8'));
    try { process.kill(pid, 0); } catch { await rm(lock); await writeFile(lock, String(process.pid), { flag: 'wx' }); return; }
    throw new Error('Já existe uma auditoria ativa nesta pasta.');
  });
  let context;
  let state;
  let saveChain = Promise.resolve();
  const save = () => {
    // Keep the checkpoint small: full findings live in atomic observation files.
    const snapshot = { ...state, observations: state.observations.map(o => ({ id: o.id, url: o.url, viewport: o.viewport, scenario: o.scenario, status: o.status, accessMonitor: o.accessMonitor, observationFile: `observations/${o.id}.json` })) };
    const serialized = structuredClone(snapshot);
    saveChain = saveChain.then(() => writeJson(join(dir, 'state.json'), serialized));
    return saveChain;
  };
  const log = message => { console.log(message); onProgress({ message, at: new Date().toISOString() }); };
  try {
    const existing = await readRun(dir, null);
    if (existing && !resume) throw new Error('A pasta já contém uma execução. Usa --resume ou uma nova pasta --output.');
    const signature = idFor(JSON.stringify({ url: config.url, allowedHosts: config.allowedHosts, viewports: config.viewports, axe: config.axe, accessMonitor: config.accessMonitor, scenarios: config.scenarios, beforeEach: config.beforeEach }));
    if (existing && existing.signature !== signature) throw new Error('Configuração incompatível com esta execução. Escolhe outra pasta de saída.');
    state = existing || { schemaVersion: 1, id: idFor(dir), signature, startedAt: new Date().toISOString(), inventory: [], observations: [], warnings: [], config, status: 'running', versions: {} };
    state.config = config;
    state.status = 'running';
    delete state.finishedAt;
    for (const name of ['playwright', '@axe-core/playwright', '@qualweb/core', '@qualweb/act-rules', '@qualweb/wcag-techniques', '@qualweb/best-practices', '@qualweb/counter', '@a12e/accessmonitor-rulesets']) {
      try { state.versions[name] = JSON.parse(await readFile(resolve(ROOT, 'node_modules', name, 'package.json'), 'utf8')).version; } catch {}
    }
    state.provenance = await readJson(resolve(ROOT, 'vendor/provenance.json'), null);
    for (const entry of state.inventory) if (entry.status === 'running' || retryFailed && ['failed', 'blocked', 'partial'].includes(entry.status)) entry.status = 'queued';
    if (retryFailed) state.observations = state.observations.filter(o => o.status === 'ok');
    queueUrl(state, config.url, config.url, 0, 'homepage', config, true);
    for (const url of config.seeds || []) queueUrl(state, url, config.url, 1, 'seed', config);
    await save();
    context = await openBrowser(config);
    state.browserVersion = context.browser()?.version();
    // Do not allow a discovered navigation/redirect to leave the configured scope.
    await context.route('**/*', route => {
      const request = route.request();
      if (request.isNavigationRequest() && request.frame().parentFrame() === null && !normalizeUrl(request.url(), config.url, config)) return route.abort('blockedbyclient');
      return route.continue();
    });
    const robots = await discoverMetadata(context, state, config, log);
    let nextStart = Date.now();
    let active = 0;
    let attempted = state.inventory.filter(x => ['ok', 'partial', 'failed', 'blocked', 'non-html'].includes(x.status)).length;
    let stoppedForBlock = false;
    const pace = async () => { const at = Math.max(Date.now(), nextStart); nextStart = at + config.delayMs; await sleep(Math.max(0, at - Date.now())); };
    const observe = async (entry, viewport, scenario) => {
      const id = idFor(`${entry.url}|${viewport.name}|${scenario.name}`);
      const previous = state.observations.find(o => o.id === id);
      if (previous && (previous.status === 'ok' || !retryFailed)) return previous;
      const o = { id, url: entry.url, viewport: viewport.name, dimensions: { width: viewport.width, height: viewport.height }, scenario: scenario.name, startedAt: new Date().toISOString(), practices: [], engineErrors: [] };
      const page = await context.newPage();
      page.setDefaultTimeout(config.timeoutMs);
      page.on('dialog', d => { void d.dismiss(); });
      page.on('popup', p => { void p.close(); });
      try {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await pace();
        log(`A analisar ${entry.url} · ${viewport.name} · ${scenario.name}`);
        const response = await page.goto(entry.url, { waitUntil: 'domcontentloaded', timeout: config.timeoutMs });
        o.httpStatus = response?.status();
        o.finalUrl = page.url();
        if (response && !/html|xhtml/i.test(response.headers()['content-type'] || '')) { o.status = 'non-html'; o.error = 'Documento não HTML; requer avaliação própria.'; return o; }
        await page.waitForLoadState('load', { timeout: 12000 }).catch(() => {});
        await page.waitForTimeout(config.settleMs);
        o.title = await page.title();
        const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
        const blocked = challengeReason(bodyText, o.title, o.httpStatus);
        if (blocked) {
          o.status = 'blocked'; o.error = blocked;
          o.screenshot = `evidence/${id}.png`;
          await page.screenshot({ path: join(dir, o.screenshot), timeout: 12000 }).catch(() => { delete o.screenshot; });
          return o;
        }
        if (o.httpStatus >= 400) throw new Error(`HTTP ${o.httpStatus}`);
        if (bodyText.trim().length < 30) throw new Error('Página sem conteúdo suficiente; renderização não confirmada.');
        const sourceHtml = await response?.text().catch(() => '') || await page.content();
        await applySteps(page, config.beforeEach);
        await applySteps(page, scenario.steps);
        await page.waitForTimeout(scenario.steps?.length ? 400 : 0);
        const links = await page.locator('a[href],area[href]').evaluateAll(els => els.map(el => el.href).filter(Boolean));
        for (const link of links) queueUrl(state, link, page.url(), entry.depth + 1, entry.url, config, entry.required && entry.depth === 0);
        o.linksCount = links.length;
        o.facts = await collectFacts(page);
        if (config.saveHtml) { o.htmlFile = `evidence/${id}.html`; await writeFile(join(dir, o.htmlFile), await page.content()); }
        if (config.screenshots) {
          o.screenshot = `evidence/${id}.png`;
          await page.screenshot({ path: join(dir, o.screenshot), fullPage: false, timeout: 12000 }).catch(e => { delete o.screenshot; o.engineErrors.push({ engine: 'screenshot', message: e.message }); });
        }
        const engines = await runEngines(page, config, sourceHtml);
        o.practices = engines.practices;
        o.engineErrors.push(...engines.engineErrors);
        o.accessMonitor = engines.accessMonitor;
        o.axePassedRules = engines.axePassedRules;
        if (engines.rawAccessMonitor) { o.rawAccessMonitor = `raw/${id}.qualweb.json`; await writeJson(join(dir, o.rawAccessMonitor), engines.rawAccessMonitor); }
        if (engines.mappedAccessMonitor) { o.mappedAccessMonitor = `raw/${id}.accessmonitor.json`; await writeJson(join(dir, o.mappedAccessMonitor), engines.mappedAccessMonitor); }
        if (engines.rawAxe) { o.rawAxe = `raw/${id}.axe.json`; await writeJson(join(dir, o.rawAxe), engines.rawAxe); }
        o.status = o.engineErrors.some(e => e.engine !== 'screenshot') ? 'partial' : 'ok';
      } catch (e) { o.status = 'failed'; o.error = e.message; }
      finally { await page.close().catch(() => {}); o.finishedAt = new Date().toISOString(); }
      return o;
    };
    const processEntry = async entry => {
      const all = [];
      const scenarios = [{ name: 'inicial', steps: [] }, ...config.scenarios.filter(s => new RegExp(s.urlPattern).test(entry.url))];
      const expected = config.viewports.reduce((sum, v) => sum + scenarios.filter(s => !s.viewports || s.viewports.includes(v.name)).length, 0);
      for (const viewport of config.viewports) {
        for (const scenario of scenarios.filter(s => !s.viewports || s.viewports.includes(viewport.name))) {
          if (signal?.aborted) break;
          const o = await observe(entry, viewport, scenario);
          all.push(o);
          state.observations = state.observations.filter(x => x.id !== o.id);
          state.observations.push(o);
          await writeJson(join(dir, 'observations', `${o.id}.json`), o);
          await save();
          if (o.status === 'blocked') break;
        }
        if (all.at(-1)?.status === 'blocked') break;
      }
      entry.status = all.length === 0 ? 'queued' : all.some(x => x.status === 'blocked') ? 'blocked' : all.every(x => x.status === 'ok') && all.length === expected ? 'ok' : all.some(x => ['ok', 'partial'].includes(x.status)) ? 'partial' : all[0].status;
      entry.error = all.find(x => x.error)?.error;
      if (entry.status === 'blocked') { stoppedForBlock = true; state.warnings.push('Execução interrompida após bloqueio de acesso. Abrir sessão e retomar com --resume --retry-failed.'); }
      log(`${entry.status.toUpperCase()}: ${entry.url} (${all.map(o => o.accessMonitor?.score ?? 'sem nota').join(' / ')})`);
      await save();
    };
    const worker = async () => {
      while (!signal?.aborted && !stoppedForBlock) {
        const eligible = state.inventory.filter(x => x.status === 'queued').sort((a, b) => Number(b.required) - Number(a.required) || a.depth - b.depth);
        if (attempted >= config.maxPages) break;
        const entry = eligible[0];
        if (!entry) { if (active) { await sleep(250); continue; } break; }
        if (config.respectRobots !== false && robots && robots.isAllowed(entry.url, '*') === false) { entry.status = 'robots-excluded'; continue; }
        entry.status = 'running';
        attempted++; active++;
        try { await processEntry(entry); }
        finally { active--; }
      }
    };
    // Homepage first: direct links receive priority over sitemap entries.
    const home = state.inventory.find(x => x.depth === 0 && x.status === 'queued');
    if (home && !(robots && config.respectRobots !== false && robots.isAllowed(home.url, '*') === false)) {
      home.status = 'running'; attempted++; await processEntry(home);
    }
    if (!stoppedForBlock && !signal?.aborted) await Promise.all(Array.from({ length: config.concurrency }, worker));
    for (const entry of state.inventory) if (entry.status === 'running') entry.status = 'queued';
    state.status = stoppedForBlock ? 'blocked' : signal?.aborted ? 'interrupted' : state.inventory.some(x => x.status === 'queued') ? 'limited' : 'completed';
    state.finishedAt = new Date().toISOString();
    state.warnings = [...new Set(state.warnings)];
    await save();
    return state;
  } catch (e) {
    if (state) { state.status = 'failed'; state.error = e.message; await save(); }
    throw e;
  } finally {
    await context?.close().catch(() => {});
    await saveChain;
    await rm(lock, { force: true });
  }
}
