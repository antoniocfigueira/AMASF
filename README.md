# ASF Access Lab

Ferramenta local para descobrir páginas, executar testes de acessibilidade no navegador e organizar o trabalho necessário para preparar o **Selo Prata de Usabilidade e Acessibilidade**.

O painel **não inicia análises ao abrir**. É necessário clicar em **Iniciar auditoria** ou executar o comando de análise.

## Abrir a ferramenta

Nesta pasta:

```powershell
cd C:\Users\mrqui\Desktop\ASF\asf-auditor
npm start
```

Abrir **http://127.0.0.1:4177**. Também podes usar `Abrir-Auditor.cmd`.

As dependências já foram instaladas nesta máquina e o motor local foi preparado. Não é necessário iniciar os repositórios `AccessMonitor` ou `monitor-server`, nem configurar MySQL, Docker ou serviços externos.

O painel permite:

- Iniciar uma análise com um limite de páginas explícito.
- Consultar o progresso e os registos.
- Guardar e parar após a observação atual.
- Retomar uma execução e repetir páginas falhadas ou parciais.
- Abrir os relatórios existentes.

O limite é o **total de páginas da execução**, incluindo as páginas já analisadas numa retoma. Para avançar de 100 para 500, seleciona a execução e indica 500. Os testes em diferentes resoluções/cenários não consomem páginas adicionais, mas aumentam a duração.

## Instalação numa máquina nova

Requisitos: Node.js 22 ou superior e Google Chrome. Manter os dois repositórios fornecidos como pastas irmãs desta ferramenta, para reconstruir o adaptador.

```powershell
$env:PUPPETEER_SKIP_DOWNLOAD='true'
npm ci --no-audit --no-fund
npm run setup
npm start
```

O Puppeteer é uma dependência transitiva do QualWeb; as análises usam Playwright e o Chrome instalado. Como alternativa, executar `npx playwright install chromium` e configurar o browser. O `setup` copia o mapeamento e a fórmula do backend, prepara um bundle independente e obtém snapshots das três checklists oficiais. Depois disso, estes recursos funcionam offline.

## O que é analisado

1. Homepage e todas as ligações internas nela encontradas, identificadas como amostra mínima conhecida.
2. Sitemaps XML, incluindo índices e namespaces.
3. Ligações internas do DOM renderizado, respeitando a profundidade e os limites configurados.
4. Desktop a 1440 × 900 e mobile a 390 × 844.
5. Na homepage ASF, cenários adicionais de pesquisa aberta, menu mobile aberto e submenu ASF aberto.

A análise usa dois motores sobre a mesma página renderizada:

- **QualWeb + mapeamento/fórmula AccessMonitor**: versões alinhadas com o backend fornecido, regras `@a12e/accessmonitor-rulesets@1.0.4` e pontuação de 0 a 10 calculada localmente.
- **axe-core**: regras WCAG 2.0/2.1 A e AA e boas práticas, preservando seletores, HTML, diagnóstico e referências de correção.

As pontuações locais **não são resultados emitidos pelo serviço oficial AccessMonitor**. A ferramenta guarda o commit, hashes dos ficheiros reutilizados, versões, resoluções, estados e datas. O teste de integração compara o adaptador com o QualWeb original para a mesma página de teste.

## Configuração

Editar `config/asf.json` antes de uma nova execução:

| Campo | Função |
| --- | --- |
| `url` / `allowedHosts` | Ponto de partida e hosts autorizados, incluindo porta quando aplicável |
| `maxPages` | Limite de páginas HTML a tentar; predefinição: 500 |
| `maxDiscovered` | Limite do inventário, incluindo exclusões e documentos |
| `maxDepth` | Profundidade máxima; pelo menos 1 para descobrir ligações da homepage |
| `maxSitemapUrls` | Máximo de URLs recolhidos dos sitemaps |
| `maxQueryVariants` | Limite de variantes de query por caminho; ligações da amostra mínima têm prioridade |
| `concurrency` / `delayMs` | Número de páginas em paralelo e intervalo entre navegações |
| `timeoutMs` / `engineTimeoutMs` | Limites de navegação e de cada motor |
| `settleMs` | Espera adicional pelo conteúdo; ajustar a sites mais lentos |
| `respectRobots` | Respeitar exclusões de robots.txt; predefinição: true |
| `seeds` | URLs adicionais, por exemplo páginas conhecidas que não têm links |
| `excludePatterns` | Expressões regulares para excluir URLs |
| `viewports` | Resoluções e nomes únicos dos testes |
| `sessionDir` | Perfil de navegador dedicado, separado do perfil pessoal |
| `channel` / `executablePath` | Browser alternativo, por exemplo `channel: "msedge"` |
| `beforeEach` | Passos explícitos antes de analisar cada estado |
| `scenarios` | Percursos/cenários por padrão de URL e, opcionalmente, resolução |
| `saveHtml` / `screenshots` | Recolha de HTML e imagem da viewport |

O crawler remove parâmetros comuns de tracking e fragmentos de âncora, preservando queries funcionais, maiúsculas/minúsculas e a barra final. Os limites evitam ciclos em calendários, filtros e paginações. PDFs, Office e outros ficheiros são inventariados como documentos, sem alegar análise do seu conteúdo.

### Cenários interativos

Exemplo para um modal conhecido:

```json
{
  "name": "modal-informacao-aberto",
  "urlPattern": "/pagina-de-exemplo",
  "viewports": ["desktop", "mobile"],
  "steps": [
    { "action": "click", "role": "button", "name": "Mais informação" },
    { "action": "waitFor", "selector": "[role=dialog]", "state": "visible" }
  ]
}
```

Ações disponíveis: `click`, `fill`, `press`, `check`, `select`, `waitFor` e `wait`. Um passo pode ser marcado `optional: true`; é preferível manter obrigatórios os passos necessários para comprovar o estado.

O crawler não submete formulários automaticamente. Passos configurados são executados tal como foram definidos: usa uma conta/ambiente de teste para cenários que alterem dados. Falhas nos passos deixam o cenário como falhado, em vez de o apresentar como avaliado.

### Login ou verificação de segurança

Com a auditoria parada:

```powershell
npm run session
```

Completar o acesso no Chrome dedicado e **fechar essa janela** antes de iniciar/retomar a auditoria. O perfil guarda cookies e armazenamento; o sistema não resolve CAPTCHA. Uma página de segurança não recebe pontuação de acessibilidade como se fosse uma página ASF. Ao detetar um bloqueio, a execução guarda o estado e termina; outros testes já em curso podem acabar entretanto.

## Utilização por linha de comandos

Os comandos seguintes **iniciam uma análise** apenas quando os executares:

```powershell
# Pequeno ensaio: até 3 páginas
npm run smoke

# Análise segundo a configuração (limite predefinido: 500)
npm run audit

# Escolher explicitamente a pasta e aumentar o limite
node src/cli.mjs scan --config config/asf.json --max-pages 1000 --output runs/inicial

# Retomar, sem repetir os estados já concluídos
node src/cli.mjs scan --config config/asf.json --max-pages 1000 --output runs/inicial --resume

# Repetir também falhas e análises parciais
node src/cli.mjs scan --config config/asf.json --max-pages 1000 --output runs/inicial --resume --retry-failed
```

Para Ctrl+C, a ferramenta termina depois da observação atual e gera o relatório. Se houver uma interrupção forçada, o estado e as observações já guardadas permitem retomar; o lock verifica se o processo anterior ainda está ativo.

Uma retoma exige URL, hosts, motores, resoluções e cenários compatíveis. Para alterar estes parâmetros ou fazer a avaliação **depois das correções do site**, criar outra execução; retomar não volta a analisar estados concluídos.

```powershell
# Regenerar o relatório e criar PDF sem voltar a visitar o site
node src/cli.mjs report --output runs/inicial --pdf

# Incorporar a revisão humana exportada pelo relatório
node src/cli.mjs report --output runs/inicial --reviews reviews.json

# Comparar uma segunda execução com a primeira
node src/cli.mjs report --output runs/final --compare runs/inicial --pdf
```

A comparação distingue ocorrências que deixaram de ser detetadas, novas, persistentes e não reavaliadas. Só compara correções em estados efetivamente reavaliados com sucesso. Alterações de seletor e de versões exigem interpretação.

## Relatório

Cada pasta em `runs/` contém:

| Ficheiro / pasta | Conteúdo |
| --- | --- |
| `report.html` | Relatório interativo autónomo, com pesquisa, filtros e checklists editáveis |
| `report.pdf` | Exportação opcional por comando; também disponível pela impressão do browser |
| `report.json` | Dados completos do relatório |
| `RESUMO.md` | Resumo de cobertura, prioridades e limitações |
| `issues.csv` | Problemas agrupados por motor e regra |
| `occurrences.csv` | Elementos afetados, seletores, HTML e diagnóstico |
| `pages.csv` | Inventário: origem, profundidade, amostra e estado |
| `checklists.csv` | Matriz dos requisitos oficiais e evidências de revisão incorporadas |
| `state.json` | Checkpoint leve da execução e referências às observações |
| `observations/` | Resultados por página, resolução e cenário |
| `raw/` | Resultados originais QualWeb, AccessMonitor e axe |
| `evidence/` | Screenshots da viewport e HTML antes da injeção dos motores |

Enquanto uma análise iniciada pelo painel decorre, o relatório é atualizado aproximadamente a cada 30 segundos. Ao terminar, é gerada a versão final. Abrir ou atualizar o relatório não volta a analisar o site.

### Checklists do Prata

Incluem os **27 requisitos dos 10 aspetos críticos**, **17 de Conteúdo** e **13 de Transação**, obtidos do kit oficial e guardados com data, origem e hash.

- Todos começam **Por verificar**.
- Medições e falhas dos motores são apresentadas como **indícios relacionados**, não como aprovação automática de um requisito completo.
- `Cumpre`, `Não cumpre` e `Não aplicável` exigem evidência/justificação.
- As percentagens indicativas usam os requisitos aplicáveis como denominador; pendências continuam nesse denominador. Uma checklist inteiramente N/A não é aprovada.
- A página geral oficial refere pelo menos 75%; a página detalhada do Prata usa “superior a 75%” para Conteúdo/Transação. O relatório conserva esta ressalva; as folhas oficiais e a avaliação da entidade responsável prevalecem.
- A presença de um link para a declaração não comprova que a declaração esteja conforme.

As alterações ficam no navegador. **Exportar revisão** cria `reviews.json`; guardar esse ficheiro e incorporá-lo com o comando `report --reviews` atualiza também os CSV e o relatório partilhável. Não depender apenas do armazenamento do browser.

## Validação local

```powershell
npm test
```

Os testes criam um site de teste em `127.0.0.1`; **não analisam a ASF**. Cobrem normalização de URLs, limites, robots.txt, bloqueios, execução dos dois motores, paridade com QualWeb, retoma, persistência de evidências, escaping do relatório, revisão das checklists, viewport móvel e comparação de execuções.

Com o painel aberto, `node scripts/qa.mjs` verifica apenas o painel e o relatório de ensaio já existente, sem voltar a analisar a ASF. Guarda imagens em `qa/`.

Foi feito um ensaio inicial de **3 páginas reais**, em duas resoluções, para validar a integração. Está em `runs/asf-smoke/`, identificado como execução limitada. **Não foi feita uma auditoria integral.** A configuração passou depois a incluir estados adicionais da homepage; uma análise com essa configuração deve usar uma nova execução.

## Limitações que o relatório preserva

- Cobertura por descoberta, limites e estados configurados; não há garantia de encontrar todas as páginas ou estados.
- Pontuação de ferramentas e verificações heurísticas não constituem certificação WCAG nem atribuição de selo.
- Conteúdo de documentos, legendas/transcrições, qualidade semântica, leitor de ecrã e usabilidade não são certificados automaticamente.
- Robots indisponível, falhas de rede, HTTP de erro e bloqueios são registados; não são tratados como testes aprovados.
- Não há integração com o código-fonte do site ASF: são indicados os elementos no DOM e a orientação de correção, não ficheiros/linhas de um repositório que não foi fornecido.
- Os dois motores podem reportar a mesma barreira. As contagens mantêm as origens e não são apresentadas como número de defeitos de código independentes.
- As gravidades e prioridades são técnicas. As regras de AccessMonitor são ordenadas pelo nível WCAG como aproximação explícita, e não por uma gravidade oficial do AccessMonitor.

## Arquitetura e proveniência

```text
src/crawler.mjs   descoberta, limites, fila, navegação e checkpoints
src/engines.mjs   adaptador QualWeb/AccessMonitor e axe-core
src/facts.mjs     medições e indícios para as checklists
src/report.mjs    agregação, comparação e exportação HTML/CSV/JSON/Markdown
src/server.mjs    painel local e execução controlada pelo utilizador
src/cli.mjs       análise, sessão, relatório e PDF
vendor/          mapeamento e fórmula originais + licença e hashes
data/            snapshots dos 57 requisitos oficiais
```

Os repositórios fornecidos foram usados como referência e permanecem sem alterações. Os ficheiros MIT reutilizados mantêm a licença em `vendor/ACCESSMONITOR-LICENSE.txt`. O bundle substitui apenas os pontos de entrada de navegação/MD5 necessários para funcionar sem NestJS/MySQL; a fórmula e o mapeamento foram copiados sem alterações.

O servidor escuta apenas em `127.0.0.1`, protege as ações por token local e verifica Host/Origin. Não o expor diretamente à Internet. O HTML recolhido de sites externos é servido pelo painel com sandbox; tratar sempre evidências HTML como conteúdo externo. O perfil de sessão não é servido pelo painel.

Fontes:

- https://selo.usabilidade.gov.pt/requisitos/
- https://selo.usabilidade.gov.pt/selo-prata/
- https://amagovpt.github.io/kit-selo/checklists/
- https://playwright.dev/docs/accessibility-testing
- https://github.com/amagovpt/accessmonitor-rulesets
