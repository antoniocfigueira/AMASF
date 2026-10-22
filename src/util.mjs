import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const idFor = value => createHash('sha256').update(value).digest('hex').slice(0, 16);
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT' && fallback !== undefined) return fallback; throw e; }
}
export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2));
  await rename(temp, path);
}
export async function readRun(dir, fallback) {
  const state = await readJson(resolve(dir, 'state.json'), fallback);
  if (!state) return state;
  state.observations = await Promise.all(state.observations.map(async o => {
    if (!o.observationFile) return o;
    if (!/^[a-f0-9]{16}$/.test(o.id)) throw new Error('ID de observação inválido.');
    return readJson(resolve(dir, 'observations', `${o.id}.json`));
  }));
  return state;
}
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const csv = rows => '\ufeff' + rows.map(row => row.map(cell => {
  let s = typeof cell === 'object' ? JSON.stringify(cell) : String(cell ?? '');
  if (/^[=+@\-\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}).join(';')).join('\r\n');
export async function withTimeout(promise, ms, label, onTimeout) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => { onTimeout?.(); reject(new Error(`${label}: limite de ${ms} ms excedido`)); }, ms); })]); }
  finally { clearTimeout(timer); }
}
