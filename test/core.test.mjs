import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { normalizeUrl, queueUrl, challengeReason } from '../src/urls.mjs';
import { checklistSummary, compareRuns, summarize, loadCatalogue } from '../src/report.mjs';
import { csv, ROOT } from '../src/util.mjs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const config = { allowedHosts: ['www.asf.com.pt'], maxDiscovered: 100, maxDepth: 3, maxQueryVariants: 2 };
test('normalização preserva query funcional, remove tracking e bloqueia destinos externos', () => {
  assert.equal(normalizeUrl('/noticias?ano=2025&utm_source=a#top', 'https://www.asf.com.pt/', config), 'https://www.asf.com.pt/noticias?ano=2025');
  assert.equal(normalizeUrl('https://www.asf.com.pt.evil.test/', 'https://www.asf.com.pt/', config), null);
  assert.equal(normalizeUrl('javascript:alert(1)', 'https://www.asf.com.pt/', config), null);
  assert.equal(normalizeUrl('https://user:secret@www.asf.com.pt/', 'https://www.asf.com.pt/', config), null);
});
test('o inventário conserva documentos, amostra mínima e variantes excluídas', () => {
  const state = { inventory: [] };
  queueUrl(state, '/a', 'https://www.asf.com.pt/', 2, 'sitemap', config);
  queueUrl(state, '/a', 'https://www.asf.com.pt/', 1, 'home', config, true);
  assert.equal(state.inventory[0].required, true);
  assert.equal(state.inventory[0].depth, 1);
  queueUrl(state, '/a?x=1', 'https://www.asf.com.pt/', 2, 'a', config);
  queueUrl(state, '/a?x=2', 'https://www.asf.com.pt/', 2, 'a', config);
  assert.equal(state.inventory.at(-1).status, 'query-limit');
  queueUrl(state, '/ficheiro.pdf', 'https://www.asf.com.pt/', 1, 'home', config, true);
  assert.equal(state.inventory.at(-1).status, 'document');
});
test('bloqueio/CAPTCHA é distinguido de uma página válida', () => {
  assert.ok(challengeReason('Verificação de Segurança. Insira o código da imagem.'));
  assert.ok(challengeReason('Access denied', '', 403));
  assert.equal(challengeReason('A ASF promove a segurança no setor segurador.'), null);
});
test('CSV neutraliza fórmulas e preserva novas linhas e separadores', () => {
  const text = csv([['=HYPERLINK("x")', 'a;b\nc']]);
  assert.ok(text.startsWith('\ufeff'));
  assert.ok(text.includes("'=HYPERLINK"));
  assert.ok(text.includes('a;b\nc'));
});
test('checklists só contam decisões fundamentadas; pendências não desaparecem', () => {
  const c = [{ id: 'x', label: 'x', requirements: [1,2,3,4].map(id => ({ id: String(id) })) }];
  const summaries = checklistSummary(c, { 1: { status: 'pass', notes: 'Testado' }, 2: { status: 'pass', notes: '' }, 3: { status: 'na', notes: 'Não existe vídeo' } });
  assert.equal(summaries[0].pass, 1);
  assert.equal(summaries[0].pending, 2);
  assert.equal(summaries[0].applicable, 3);
  assert.equal(summaries[0].status, 'pending');
  assert.equal(checklistSummary([{ ...c[0], requirements: [{id:'1'}] }], { 1: {status:'na',notes:'Não aplicável'} })[0].percent, null);
});
test('uma amostra desconhecida e motores incompletos nunca obtêm aprovação automática', () => {
  const initial = { inventory: [{url:'a',depth:0,required:true,status:'blocked'}], observations: [] };
  assert.equal(summarize(initial).automaticStatus, 'pending');
  const partial = { inventory: [{url:'a',depth:0,required:true,status:'partial'}], observations: [{url:'a',status:'partial',accessMonitor:{score:10}}] };
  assert.equal(summarize(partial).automaticStatus, 'pending');
  const low = { inventory: [{url:'a',depth:0,required:true,status:'ok'}], observations: [{url:'a',status:'ok',accessMonitor:{score:8.9}}] };
  assert.equal(summarize(low).automaticStatus, 'below');
});
test('uma página não reavaliada não é contabilizada como corrigida', () => {
  const o = { url:'a',viewport:'desktop',scenario:'inicial',status:'ok',practices:[{engine:'axe',id:'button-name',status:'violation',nodes:[{target:['button']}]}] };
  const before = { observations:[o], versions:{axe:'1'},startedAt:'before' };
  const after = { observations:[],versions:{axe:'1'},startedAt:'after' };
  assert.equal(compareRuns(before, after).resolved.length, 0);
  assert.equal(compareRuns(before, after).notRetested.length, 1);
  after.observations.push({...o,practices:[]});
  assert.equal(compareRuns(before, after).resolved.length, 1);
});
test('catálogo oficial inclui todos os 57 requisitos com fonte e descrição', async () => {
  const c = await loadCatalogue();
  assert.deepEqual(c.map(x=>x.requirements.length), [27,17,13]);
  for (const list of c) for (const r of list.requirements) assert.ok(r.title && r.source && r.guidance);
});
test('mapeamento e fórmula do backend são preservados e têm hashes rastreáveis', async () => {
  const provenance = JSON.parse(await readFile(resolve(ROOT, 'vendor/provenance.json'), 'utf8'));
  for (const file of ['middleware.ts', 'mapping.ts']) {
    const original = await readFile(resolve(ROOT, '../monitor-server/src/evaluation', file));
    const vendored = await readFile(resolve(ROOT, 'vendor', file));
    assert.deepEqual(vendored, original);
    assert.equal(createHash('sha256').update(vendored).digest('hex'), provenance.hashes[file]);
  }
});
