import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { ruleset, testColors, translations, techniques } from '@a12e/accessmonitor-rulesets';
import { ROOT, idFor, withTimeout } from './util.mjs';
import { parseDocument, DomUtils } from 'htmlparser2';

const require = createRequire(import.meta.url);
const { ACTRules } = require('@qualweb/act-rules');
const { WCAGTechniques } = require('@qualweb/wcag-techniques');
const { BestPractices } = require('@qualweb/best-practices');
const { Counter } = require('@qualweb/counter');
const plain = s => DomUtils.textContent(parseDocument(String(s || ''))).replace(/\s+/g, ' ').trim();

// Reuse the upstream module executors, including ACT's special viewport test.
// The adapter only bridges Puppeteer's multi-argument evaluate to Playwright.
export async function evaluateAccessMonitor(page, sourceHtml) {
  const html = await page.content();
  const title = await page.title();
  const viewport = page.viewportSize();
  const adapter = {
    evaluate(fn, ...args) { return page.evaluate(`(${fn.toString()})(...${JSON.stringify(args)})`); },
    getViewport() { return { ...page.viewportSize(), isMobile: false, isLandscape: viewport.width > viewport.height, hasTouch: false }; },
    setViewport(opts) { return page.setViewportSize(opts.resolution); },
    addEvaluationScript(name) { return page.addScriptTag({ path: require.resolve(name) }); }
  };
  for (const name of ['@qualweb/qw-page', '@qualweb/util', '@qualweb/locale']) await page.addScriptTag({ path: require.resolve(name) });
  const modules = {};
  for (const [name, Module] of [['act-rules', ACTRules], ['wcag-techniques', WCAGTechniques], ['best-practices', BestPractices], ['counter', Counter]]) {
    modules[name] = await new Module().execute(adapter, 'en', { sourceHtml: sourceHtml || html, newTabWasOpen: false });
    if (!modules[name]) throw new Error(`Módulo QualWeb sem resultado: ${name}`);
  }
  await page.setViewportSize(viewport);
  const raw = { system: {
    name: 'QualWeb', version: '0.8.10', date: new Date().toISOString(),
    url: { completeUrl: page.url(), inputUrl: page.url() },
    page: { viewport: { resolution: viewport }, dom: { html, title, elementCount: await page.locator('*').count() } }
  }, modules };
  const { parseEvaluation } = require(resolve(ROOT, 'vendor/accessmonitor.cjs'));
  const mapped = parseEvaluation(raw);
  const score = Number(mapped.data.score);
  if (!Number.isFinite(score) || score < 0 || score > 10) throw new Error('Pontuação AccessMonitor inválida; avaliação incompleta.');
  const practices = Object.keys(mapped.data.tot.results).map(id => {
    const rule = ruleset[id];
    const nodes = mapped.data.nodes[rule.test] || [];
    return {
      id, engine: 'accessmonitor', status: testColors[id] === 'R' ? 'violation' : testColors[id] === 'Y' ? 'review' : 'passed',
      level: rule.level.toUpperCase(), criteria: rule.scs || [],
      title: plain(translations.pt.translation.TESTS_RESULTS[id]?.title || id),
      fix: plain(translations.pt.translation.TECHS[rule.ref] || techniques[rule.ref] || 'Consultar a referência e validar a correção no componente.'),
      helpUrl: `https://amagovpt.github.io/accessmonitor-rulesets/en/${id}.html`, reference: rule.ref,
      impact: rule.level.toUpperCase() === 'A' ? 'serious' : rule.level.toUpperCase() === 'AA' ? 'moderate' : 'minor',
      scope: rule.level.toUpperCase() === 'AAA' ? 'additional' : 'wcag21aa',
      count: nodes.length || Number(mapped.data.elems[rule.test]) || 1,
      nodes: nodes.map(n => ({ target: n.pointer ? [n.pointer] : [], html: n.htmlCode || '', message: n.description || '' }))
    };
  });
  return { score, practices, raw, mapped };
}

function normalizeAxeRule(rule, status) {
  const tags = rule.tags || [];
  const wcag = tags.some(t => /^wcag(?:2|21)(?:a|aa)$/.test(t));
  return {
    id: rule.id, engine: 'axe', status, impact: rule.impact || 'moderate',
    scope: wcag ? 'wcag21aa' : 'best-practice',
    level: tags.includes('wcag21aa') || tags.includes('wcag2aa') ? 'AA' : tags.includes('wcag2a') || tags.includes('wcag21a') ? 'A' : 'BP',
    criteria: tags.filter(t => /^wcag\d{3,4}$/.test(t)).map(t => t.slice(4).split('').join('.')),
    title: rule.help, description: rule.description, fix: rule.description,
    helpUrl: rule.helpUrl, count: rule.nodes.length,
    nodes: rule.nodes.map(n => ({ target: n.target, html: n.html, message: n.failureSummary || '', checks: [...(n.any || []), ...(n.all || []), ...(n.none || [])].map(c => ({ id: c.id, message: c.message, data: c.data })) }))
  };
}
export async function evaluateAxe(page) {
  const raw = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
  return { raw, practices: [...raw.violations.map(r => normalizeAxeRule(r, 'violation')), ...raw.incomplete.map(r => normalizeAxeRule(r, 'review'))], passedRules: raw.passes.length };
}

export async function runEngines(page, config, sourceHtml) {
  const results = { practices: [], engineErrors: [] };
  if (config.accessMonitor) {
    try {
      const am = await withTimeout(evaluateAccessMonitor(page, sourceHtml), config.engineTimeoutMs, 'AccessMonitor', () => { void page.close().catch(() => {}); });
      results.accessMonitor = { score: am.score, passedPractices: am.practices.filter(p => p.status === 'passed').length, provenance: 'Código local monitor-server + QualWeb; não é avaliação emitida pelo serviço oficial.' };
      results.practices.push(...am.practices.filter(p => p.status !== 'passed'));
      results.rawAccessMonitor = am.raw;
      results.mappedAccessMonitor = am.mapped;
    } catch (e) { results.engineErrors.push({ engine: 'accessmonitor', message: e.message }); }
  }
  if (config.axe && !page.isClosed()) {
    try {
      const axe = await withTimeout(evaluateAxe(page), config.engineTimeoutMs, 'axe-core', () => { void page.close().catch(() => {}); });
      results.practices.push(...axe.practices);
      results.rawAxe = axe.raw;
      results.axePassedRules = axe.passedRules;
    } catch (e) { results.engineErrors.push({ engine: 'axe', message: e.message }); }
  } else if (config.axe) results.engineErrors.push({ engine: 'axe', message: 'Página fechada após timeout do motor anterior.' });
  return results;
}

export function groupFindings(observations) {
  const groups = new Map();
  for (const observation of observations) for (const finding of observation.practices || []) {
    if (finding.status === 'passed') continue;
    const key = `${finding.engine}:${finding.status}:${finding.id}`;
    let g = groups.get(key);
    if (!g) { g = { ...finding, key, uid: idFor(key), count: 0, nodes: undefined, occurrences: [], urls: [], observedStates: [] }; groups.set(key, g); }
    g.count += finding.count;
    if (!g.urls.includes(observation.url)) g.urls.push(observation.url);
    g.observedStates.push(`${observation.url} · ${observation.viewport} · ${observation.scenario}`);
    g.occurrences.push({ observationId: observation.id, url: observation.url, viewport: observation.viewport, scenario: observation.scenario, count: finding.count, nodes: finding.nodes, screenshot: observation.screenshot });
  }
  const weight = { critical: 4, serious: 3, moderate: 2, minor: 1 };
  return [...groups.values()].sort((a, b) => (a.status === 'review') - (b.status === 'review') || (weight[b.impact] || 0) - (weight[a.impact] || 0) || b.urls.length - a.urls.length || b.count - a.count);
}
