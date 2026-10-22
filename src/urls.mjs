const FILES = /\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|jpe?g|png|gif|svg|webp|ico|mp[34]|wav|css|js|woff2?|ttf|xml|json|csv|txt)(?:$|\/)/i;
const TRACKING = /^(utm_.+|gclid|fbclid|msclkid|_ga|_gl|jsessionid)$/i;
export function normalizeUrl(input, base, config = {}) {
  try {
    const u = new URL(input, base);
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) return null;
    if ((config.allowedHosts || [new URL(base).hostname]).indexOf(u.host) === -1) return null;
    u.hash = '';
    for (const key of [...u.searchParams.keys()]) if (TRACKING.test(key)) u.searchParams.delete(key);
    u.searchParams.sort();
    // Preserve meaningful query values, route casing and trailing slashes.
    if ((config.excludePatterns || []).some(pattern => new RegExp(pattern, 'i').test(u.href))) return null;
    return u.href;
  } catch { return null; }
}
export const isDocument = url => FILES.test(new URL(url).pathname) || /\/documents\//i.test(new URL(url).pathname);
export function challengeReason(text, title = '', status = 200) {
  const s = `${title}\n${text}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (/verificacao de seguranca|your support id is|insira o codigo da imagem|web page blocked!|request rejected|checking your browser|verify you are human|just a moment\.\.\./.test(s)) return 'Verificação de segurança / proteção contra automação';
  if ([401, 403, 429, 503].includes(status)) return `Acesso indisponível (HTTP ${status})`;
  return null;
}
export function queueUrl(state, input, base, depth, source, config, required = false) {
  const url = normalizeUrl(input, base, config);
  if (!url) return;
  const current = state.inventory.find(x => x.url === url);
  if (current) {
    if (required) current.required = true;
    current.depth = Math.min(current.depth, depth);
    if (current.required && ['depth-limit', 'query-limit'].includes(current.status) && current.depth <= config.maxDepth) current.status = 'queued';
    return current;
  }
  if (state.inventory.length >= config.maxDiscovered) { state.discoveryLimitReached = true; return; }
  const document = isDocument(url);
  const key = new URL(url).origin + new URL(url).pathname;
  const variants = state.inventory.filter(x => x.queryKey === key).length;
  const status = document ? 'document' : depth > config.maxDepth ? 'depth-limit' : variants >= config.maxQueryVariants && !required ? 'query-limit' : 'queued';
  const entry = { url, depth, source, required, queryKey: key, status };
  state.inventory.push(entry);
  return entry;
}
