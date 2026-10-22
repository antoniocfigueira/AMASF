import { resolve, join } from 'node:path';
import { access } from 'node:fs/promises';
import { chromium } from 'playwright';
import { scan, loadConfig } from './crawler.mjs';
import { generateReport, summarize } from './report.mjs';
import { openBrowser } from './browser.mjs';
import { ROOT } from './util.mjs';

function argsOf(args) {
  const out = { command: args[0] || 'help' };
  const boolean = new Set(['resume','retry-failed','no-accessmonitor','no-axe','headed','pdf','help']);
  const values = new Set(['config','url','output','max-pages','concurrency','reviews','compare','channel','session-dir']);
  for (let i = 1; i < args.length; i++) {
    const name = args[i].replace(/^--/, '');
    if (boolean.has(name)) out[name] = true;
    else if (values.has(name)) { if (!args[i+1] || args[i+1].startsWith('--')) throw Error(`Falta o valor de --${name}`); out[name] = args[++i]; }
    else throw Error(`Argumento desconhecido: ${args[i]}`);
  }
  return out;
}

export async function exportPdf(dir) {
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const { pathToFileURL } = await import('node:url');
    await page.goto(pathToFileURL(join(dir, 'report.html')).href);
    await page.waitForFunction(() => window.__reportReady === true);
    // Print every issue including reviews, independently of the screen filters.
    await page.evaluate(() => {
      const result = document.getElementById('result');
      result.value = '';
      result.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelectorAll('.issue').forEach(el => el.open = true);
    });
    await page.pdf({ path: join(dir, 'report.pdf'), format: 'A4', printBackground: true, preferCSSPageSize: true });
  } finally { await browser?.close(); }
}

async function main() {
  const args = argsOf(process.argv.slice(2));
  if (args.command === 'help' || args.help) {
    console.log(`ASF Access Lab — Auditoria e preparação para Selo Prata

  npm start                           Painel local em http://127.0.0.1:4177
  npm run smoke                       Analisar até 3 páginas reais da ASF
  npm run audit                       Análise configurada (500 páginas)
  npm run session                     Abrir sessão para login/verificação humana

  node src/cli.mjs scan --config config/asf.json --output runs/inicial --max-pages 500
  node src/cli.mjs scan --config config/asf.json --output runs/inicial --max-pages 500 --resume --retry-failed
  node src/cli.mjs report --output runs/inicial --pdf
  node src/cli.mjs report --output runs/final --compare runs/inicial --reviews reviews.json

O relatório inclui HTML, CSV, JSON, resumo Markdown e evidências.
As checklists não são aprovadas automaticamente. As notas são locais, não emitidas pelo serviço oficial.`);
    return;
  }
  const overrides = {};
  if (args.url) { overrides.url = new URL(args.url.includes('://') ? args.url : 'https://' + args.url).href; overrides.allowedHosts = [new URL(overrides.url).host]; overrides.sitemaps = [new URL('/sitemap.xml', overrides.url).href]; }
  if (args['max-pages']) overrides.maxPages = Number(args['max-pages']);
  if (args.concurrency) overrides.concurrency = Number(args.concurrency);
  if (args['no-accessmonitor']) overrides.accessMonitor = false;
  if (args['no-axe']) overrides.axe = false;
  if (args.headed) overrides.headless = false;
  if (args.channel) overrides.channel = args.channel;
  if (args['session-dir']) overrides.sessionDir = args['session-dir'];
  const config = await loadConfig(args.config, overrides);
  if (args.command === 'session') {
    console.log('A abrir uma sessão dedicada. Conclui o login/verificação, se necessário, e fecha esta janela para guardar a sessão. Não abras uma auditoria enquanto esta janela estiver aberta.');
    const context = await openBrowser(config, true);
    const page = context.pages()[0] || await context.newPage();
    await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: config.timeoutMs }).catch(e => console.warn(e.message));
    await new Promise(resolve => context.on('close', resolve));
    return;
  }
  const output = resolve(ROOT, args.output || `runs/asf-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  if (args.command === 'scan') {
    const controller = new AbortController();
    let report;
    const interrupt = () => { console.log('A terminar após a observação atual e a guardar o relatório…'); controller.abort(); };
    process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
    try { await scan(config, output, { resume: args.resume, retryFailed: args['retry-failed'], signal: controller.signal }); }
    finally {
      process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
      try { await access(join(output, 'state.json')); report = await generateReport(output, { reviewsFile: args.reviews, compareDir: args.compare }); }
      catch (error) { console.error('Relatório:', error.message); }
    }
    if (!report) throw Error('A análise terminou mas o relatório não pôde ser gerado; os checkpoints foram preservados.');
    if (args.pdf) await exportPdf(output);
    console.log(`\nRelatório: ${join(output, 'report.html')}\nEstado: ${report.state.status}; páginas concluídas: ${report.summary.pagesOk}/${report.summary.pagesFound}; nota mínima: ${report.summary.minScore ?? 'indisponível'}.`);
    if (['blocked','failed'].includes(report.state.status)) process.exitCode = 2;
  } else if (args.command === 'report') {
    if (!args.output) throw Error('Indica --output runs/nome-da-execucao');
    await generateReport(output, { reviewsFile: args.reviews, compareDir: args.compare });
    if (args.pdf) await exportPdf(output);
    console.log(`Relatório atualizado: ${join(output, 'report.html')}`);
  } else throw Error(`Comando desconhecido: ${args.command}`);
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(ROOT, 'src/cli.mjs')) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
