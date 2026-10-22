import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ROOT } from './util.mjs';

export async function openBrowser(config, interactive = false) {
  const options = { headless: interactive ? false : config.headless, locale: 'pt-PT', timezoneId: 'Europe/Lisbon', bypassCSP: true, acceptDownloads: false, viewport: { width: 1440, height: 900 } };
  if (config.executablePath) options.executablePath = config.executablePath;
  else options.channel = config.channel || 'chrome';
  const profile = resolve(ROOT, config.sessionDir || '.session/asf');
  await mkdir(profile, { recursive: true });
  try { return await chromium.launchPersistentContext(profile, options); }
  catch (error) {
    if (/Singleton|ProcessSingleton|user data directory is already in use/i.test(error.message)) throw new Error('A sessão já está aberta. Fecha a janela de sessão antes de iniciar a auditoria.');
    if (!config.channel && !config.executablePath && /not found|doesn't exist|distribution/i.test(error.message)) {
      delete options.channel;
      return chromium.launchPersistentContext(profile, options);
    }
    throw error;
  }
}

export async function applySteps(page, steps = []) {
  for (const step of steps) {
    if (step.action === 'wait') { await page.waitForTimeout(Math.min(Number(step.ms) || 0, 15000)); continue; }
    const locator = step.role ? page.getByRole(step.role, { name: step.name, exact: step.exact ?? false }) : page.locator(step.selector);
    if (step.optional && !await locator.first().isVisible().catch(() => false)) continue;
    const target = locator.first();
    if (step.action === 'click') await target.click({ timeout: step.timeoutMs || 8000 });
    else if (step.action === 'fill') await target.fill(step.value, { timeout: 8000 });
    else if (step.action === 'press') await target.press(step.key, { timeout: 8000 });
    else if (step.action === 'check') await target.check({ timeout: 8000 });
    else if (step.action === 'select') await target.selectOption(step.value);
    else if (step.action === 'waitFor') await target.waitFor({ state: step.state || 'visible', timeout: step.timeoutMs || 8000 });
    else throw new Error(`Ação de cenário não suportada: ${step.action}`);
  }
}
