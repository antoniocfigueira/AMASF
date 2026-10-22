import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, readdir, stat, mkdir } from 'node:fs/promises';
import { resolve, join, extname, sep } from 'node:path';
import { scan, loadConfig } from './crawler.mjs';
import { generateReport } from './report.mjs';
import { ROOT, readJson } from './util.mjs';

const PORT = Number(process.env.ASF_PORT || 4177);
const token = randomBytes(24).toString('hex');
const runsDir = resolve(ROOT, 'runs');
await mkdir(runsDir, { recursive: true });
let task = null;
let logs = [];
const log = event => { logs.push(event); if (logs.length > 400) logs.shift(); };
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(body)); };
async function bodyOf(req) {
  let text = '';
  for await (const chunk of req) { text += chunk; if (text.length > 50000) throw Error('Pedido demasiado grande'); }
  return JSON.parse(text || '{}');
}
async function listRuns() {
  const entries = await readdir(runsDir, { withFileTypes: true });
  const out = [];
  for (const entry of entries.filter(e => e.isDirectory())) {
    try {
      const state = await readJson(join(runsDir, entry.name, 'state.json'));
      out.push({ name: entry.name, status: state.status, startedAt: state.startedAt, completed: state.inventory.filter(p => p.status === 'ok').length, found: state.inventory.length, report: await stat(join(runsDir, entry.name, 'report.html')).then(() => true).catch(() => false) });
    } catch {}
  }
  return out.sort((a,b) => b.startedAt.localeCompare(a.startedAt));
}

const server = http.createServer(async (req, res) => {
  try {
    if (!req.headers.host || ![`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(req.headers.host)) return json(res, 403, { error: 'Host não permitido' });
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (url.pathname === '/') {
      const html = (await readFile(join(ROOT, 'web/index.html'), 'utf8')).replace('__TOKEN__', token);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      return res.end(html);
    }
    if (url.pathname.startsWith('/api/')) {
      if (req.headers['x-asf-token'] !== token) return json(res, 403, { error: 'Token local inválido; atualiza o painel.' });
      if (req.headers.origin && ![`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`].includes(req.headers.origin)) return json(res, 403, { error: 'Origem não permitida' });
      if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, { task: task && { name: task.name, running: task.running, stopping: task.stopping, error: task.error }, logs, runs: await listRuns() });
      if (req.method === 'POST' && url.pathname === '/api/stop') { task?.controller.abort(); if (task) task.stopping = true; return json(res, 200, { message: 'A guardar e a terminar após a observação atual.' }); }
      if (req.method === 'POST' && url.pathname === '/api/start') {
        if (task?.running) return json(res, 409, { error: 'Já existe uma auditoria em curso.' });
        const body = await bodyOf(req);
        const maxPages = Number(body.maxPages || 500);
        if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10000) return json(res, 400, { error: 'O limite deve ser entre 1 e 10000.' });
        const name = body.resume ? String(body.resume) : `asf-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        if (!/^[a-zA-Z0-9_.-]+$/.test(name) || name === '.' || name === '..') return json(res, 400, { error: 'Nome de execução inválido.' });
        const config = await loadConfig('config/asf.json', { maxPages });
        const controller = new AbortController();
        task = { name, running: true, controller };
        const current = task;
        logs = [];
        const dir = join(runsDir, name);
        void (async () => {
          let snapshot = null;
          const timer = setInterval(() => {
            if (!snapshot) snapshot = generateReport(dir).catch(() => {}).finally(() => { snapshot = null; });
          }, 30000);
          try {
            await scan(config, dir, { resume: Boolean(body.resume), retryFailed: Boolean(body.retryFailed), signal: controller.signal, onProgress: log });
          } catch (e) { current.error = e.message; log({ at: new Date().toISOString(), message: e.message }); }
          finally {
            clearInterval(timer);
            await snapshot;
            try { await generateReport(dir); log({ at: new Date().toISOString(), message: 'Relatório gerado.' }); }
            catch (e) { current.error = [current.error, e.message].filter(Boolean).join('; '); }
            current.running = false;
          }
        })();
        return json(res, 202, { name });
      }
      return json(res, 404, { error: 'Operação desconhecida' });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/runs/')) {
      const requested = resolve(ROOT, '.' + decodeURIComponent(url.pathname));
      if (!requested.startsWith(runsDir + sep) || !['.html','.json','.csv','.md','.png','.pdf'].includes(extname(requested))) return json(res, 403, { error: 'Ficheiro não permitido' });
      const bytes = await readFile(requested);
      const types = { '.html':'text/html; charset=utf-8', '.json':'application/json; charset=utf-8', '.csv':'text/csv; charset=utf-8', '.md':'text/plain; charset=utf-8', '.png':'image/png', '.pdf':'application/pdf' };
      const headers = { 'Content-Type': types[extname(requested)], 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };
      if (extname(requested) === '.html' && !requested.endsWith(sep + 'report.html')) headers['Content-Security-Policy'] = "sandbox; default-src 'none'; style-src 'unsafe-inline'";
      res.writeHead(200, headers);
      return res.end(bytes);
    }
    return json(res, 404, { error: 'Não encontrado' });
  } catch (e) { return json(res, e.code === 'ENOENT' ? 404 : 400, { error: e.message }); }
});
server.listen(PORT, '127.0.0.1', () => console.log(`ASF Access Lab: http://127.0.0.1:${PORT}\nCtrl+C para terminar. Os relatórios continuam disponíveis em runs/.`));
function stop() { task?.controller.abort(); server.close(); if (!task?.running) process.exit(0); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
