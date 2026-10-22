export async function collectFacts(page) {
  return page.evaluate(() => {
    const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const selector = el => {
      if (el.id) return '#' + CSS.escape(el.id);
      const parts = [];
      for (let p = el; p && p.tagName !== 'HTML' && parts.length < 7; p = p.parentElement) {
        const index = [...(p.parentElement?.children || [])].filter(c => c.tagName === p.tagName).indexOf(p) + 1;
        parts.unshift(p.tagName.toLowerCase() + `:nth-of-type(${index})`);
      }
      return parts.join(' > ');
    };
    const sample = (els, predicate) => els.filter(predicate).slice(0, 40).map(el => ({ selector: selector(el), html: el.outerHTML.slice(0, 700), text: el.innerText?.slice(0, 140) || '' }));
    const paragraphs = [...document.querySelectorAll('main p, article p, [role=main] p')].filter(el => visible(el) && el.textContent.trim().length > 60);
    const interactive = [...document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,[role=button]')].filter(visible);
    const forms = [...document.querySelectorAll('form')].filter(visible);
    const smallText = sample(paragraphs, el => parseFloat(getComputedStyle(el).fontSize) < 16);
    const tightLines = sample(paragraphs, el => { const s = getComputedStyle(el); return s.lineHeight !== 'normal' && parseFloat(s.lineHeight) < 1.5 * parseFloat(s.fontSize) - 0.5; });
    const smallTargets = sample(interactive, el => { const r = el.getBoundingClientRect(); return r.width < 44 || r.height < 44; });
    const longForms = sample(forms, el => el.getBoundingClientRect().height > innerHeight * 2);
    return {
      title: document.title, lang: document.documentElement.lang,
      bodyTextLength: document.body?.innerText.length || 0,
      overflowX: document.documentElement.scrollWidth > innerWidth + 2,
      scrollWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth,
      headings: [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map(el => ({ level: el.tagName, text: el.textContent.trim().slice(0, 180) })).slice(0, 100),
      forms: forms.map(el => ({ selector: selector(el), fields: el.querySelectorAll('input,select,textarea').length })),
      positiveTabindex: sample(interactive, el => Number(el.getAttribute('tabindex')) > 0),
      requiredWithoutSemantic: sample([...document.querySelectorAll('input,select,textarea')].filter(visible), el => !el.required && el.getAttribute('aria-required') !== 'true' && /obrigat|\*/i.test(el.labels?.[0]?.textContent || '')),
      images: document.images.length, tables: document.querySelectorAll('table').length,
      videos: document.querySelectorAll('video,iframe[src*=youtube],iframe[src*=vimeo]').length,
      dialogs: document.querySelectorAll('dialog,[role=dialog]').length,
      smallText, tightLines, smallTargets, longForms,
      statementLinks: [...document.querySelectorAll('a[href]')].filter(el => /acessibilidade|accessibility/i.test(el.textContent + ' ' + el.href)).map(el => ({ text: el.textContent.trim(), url: el.href }))
    };
  });
}

const criteriaToChecklist = {
  '1.1.1': ['10aspetos:1.3', '10aspetos:5.1', '10aspetos:5.3'],
  '1.3.1': ['10aspetos:2.2', '10aspetos:3.1', '10aspetos:4.1'],
  '1.4.3': ['10aspetos:6.1', '10aspetos:6.2'],
  '2.1.1': ['10aspetos:1.2'],
  '3.3.2': ['10aspetos:4.2', 'transacao:2.3', 'transacao:2.4'],
  '3.3.1': ['10aspetos:4.3', 'transacao:4.3'],
  '3.3.3': ['transacao:4.4']
};
// All checklist decisions remain unverified until a reviewer records evidence.
// Evidence associations are advisory, not an assertion of checklist failure/pass.
export function checklistSignals(observations, catalogue) {
  const ids = new Set(catalogue.flatMap(c => c.requirements.map(r => r.id)));
  const out = {};
  const add = (id, o, message, samples = []) => {
    if (!ids.has(id)) return;
    (out[id] ||= []).push({ observationId: o.id, url: o.url, viewport: o.viewport, scenario: o.scenario, message, samples });
  };
  for (const o of observations.filter(o => o.status === 'ok' || o.status === 'partial')) {
    for (const p of o.practices || []) if (p.status === 'violation') for (const criterion of p.criteria || []) for (const id of criteriaToChecklist[criterion] || []) add(id, o, `Verificar relação com ${p.engine}: ${p.title}`, p.nodes?.slice(0, 3));
    const f = o.facts;
    if (!f) continue;
    if (f.smallText.length) add('conteudo:2.1', o, 'Texto principal com menos de 16px (12pt). Confirmar contexto e escalabilidade.', f.smallText);
    if (f.tightLines.length) add('conteudo:2.4', o, 'Parágrafos com entrelinha inferior a 1,5×.', f.tightLines);
    if (f.smallTargets.length) add('conteudo:5.2', o, 'Controlos com largura ou altura inferior a 44px; confirmar área acionável.', f.smallTargets);
    if (f.overflowX) add('conteudo:4.2', o, `Largura do documento ${f.scrollWidth}px excede viewport ${f.viewportWidth}px. Confirmar origem.`);
    if (f.longForms.length) add('transacao:1.2', o, 'Formulários com mais de dois ecrãs de altura.', f.longForms);
    if (f.positiveTabindex.length) add('transacao:1.1', o, 'tabindex positivo pode alterar a sequência de navegação.', f.positiveTabindex);
    if (f.requiredWithoutSemantic.length) add('transacao:2.4', o, 'Indicação visual de campo obrigatório sem required/aria-required.', f.requiredWithoutSemantic);
  }
  return out;
}
