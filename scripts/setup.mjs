import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { parseDocument, DomUtils } from 'htmlparser2';
import { selectAll } from 'css-select';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const backend = resolve(root, '../monitor-server');
await mkdir(resolve(root, 'vendor'), { recursive: true });
await mkdir(resolve(root, 'data'), { recursive: true });
const originals = ['mapping.ts', 'middleware.ts'];
const hashes = {};
for (const file of originals) {
  const bytes = await readFile(resolve(backend, 'src/evaluation', file));
  hashes[file] = createHash('sha256').update(bytes).digest('hex');
  await writeFile(resolve(root, 'vendor', file), bytes);
}
await copyFile(resolve(backend, 'LICENSE'), resolve(root, 'vendor/ACCESSMONITOR-LICENSE.txt'));
let commit = null;
try { commit = execFileSync('git', ['-C', backend, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch {}
await writeFile(resolve(root, 'vendor/provenance.json'), JSON.stringify({
  source: '../monitor-server/src/evaluation', commit, hashes,
  rulesets: '1.0.4', description: 'Código original sem alterações; bundle expõe parseEvaluation e generateScore. Navegação e MD5 substituídos por adaptadores locais.'
}, null, 2));

await build({
  stdin: {
    contents: (await readFile(resolve(root, 'vendor/middleware.ts'), 'utf8')) + '\nexport { parseEvaluation, generateScore };',
    resolveDir: resolve(root, 'vendor'), sourcefile: 'middleware.ts', loader: 'ts'
  },
  outfile: resolve(root, 'vendor/accessmonitor.cjs'), bundle: true, platform: 'node', format: 'cjs',
  packages: 'external', plugins: [{ name: 'standalone-adapters', setup(b) {
    b.onResolve({ filter: /^\.\/qualweb$/ }, () => ({ path: 'qualweb', namespace: 'adapter' }));
    b.onResolve({ filter: /^\.\.\/lib\/security$/ }, () => ({ path: 'security', namespace: 'adapter' }));
    b.onLoad({ filter: /.*/, namespace: 'adapter' }, args => ({ contents: args.path === 'security'
      ? "import {createHash} from 'node:crypto'; export const generateMd5Hash = s => createHash('md5').update(s).digest('hex');"
      : "export async function evaluate(){throw new Error('Use o adaptador Playwright.');}" }));
  }}]
});

// Snapshot oficial para o relatório funcionar offline e manter rastreabilidade.
for (const [id, label] of [['10aspetos', '10 aspetos críticos'], ['conteudo', 'Conteúdo'], ['transacao', 'Transação']]) {
  const path = resolve(root, `data/checklist-${id}.json`);
  try {
    const url = `https://raw.githubusercontent.com/amagovpt/kit-selo/master/checklists/checklist-${id}.html`;
    const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    const dom = parseDocument(html);
    const requirements = selectAll('h3', dom).map(h => {
      const title = DomUtils.textContent(h).replace(/\s+/g, ' ').trim();
      const number = title.match(/^\d+\.\d+/)?.[0];
      if (!number) return null;
      const paragraphs = [];
      let next = h.next;
      while (next && !(next.type === 'tag' && /^h[123]$/.test(next.name))) {
        if (next.type === 'tag' && ['p', 'ul', 'ol'].includes(next.name)) paragraphs.push(DomUtils.textContent(next).replace(/\s+/g, ' ').trim());
        next = next.next;
      }
      return { id: `${id}:${number}`, number, title: title.replace(/^\d+\.\d+\s*/, ''), guidance: paragraphs.join('\n'), source: `https://amagovpt.github.io/kit-selo/checklists/checklist-${id}.html#${h.attribs.id || ''}` };
    }).filter(Boolean);
    if (!requirements.length) throw new Error('Lista vazia');
    await writeFile(path, JSON.stringify({ id, label, source: `https://selo.usabilidade.gov.pt/requisitos/${id}/`, snapshotUrl: url, retrievedAt: new Date().toISOString(), sha256: createHash('sha256').update(html).digest('hex'), requirements }, null, 2));
    console.log(`${label}: ${requirements.length} requisitos oficiais.`);
  } catch (error) {
    try { await readFile(path); console.warn(`Snapshot existente mantido: ${error.message}`); }
    catch { throw new Error(`Não foi possível obter a checklist ${id}: ${error.message}`); }
  }
}
console.log('Motor AccessMonitor preparado. Browser: Chrome instalado ou npx playwright install chromium.');
