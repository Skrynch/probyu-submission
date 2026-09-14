import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  resetSyntheticFamilyDatabase,
  expireSyntheticParentPrivilege,
  expireSyntheticConsent,
} from '../../../services/backend/src/db/family-test-support';

async function confirm(page: Page) {
  const code = await page.getByTestId('dev-code').textContent();
  await page.getByLabel('Одноразовый код').fill(code!);
  await page.getByRole('button', { name: 'Подтвердить', exact: true }).click();
}
async function login(page: Page) {
  await page.goto('/family');
  await page.getByRole('button', { name: 'Войти: Аврора' }).click();
  await confirm(page);
  await expect(page.getByRole('heading', { name: 'Начнём с разрешений' })).toBeVisible();
}
async function activate(page: Page) {
  await login(page);
  await expect(
    page.getByRole('button', { name: 'Продолжить с этими разрешениями' }),
  ).toBeDisabled();
  await page.getByRole('checkbox', { name: /^Базовый текстовый сценарий/ }).check();
  await page.getByRole('button', { name: 'Продолжить с этими разрешениями' }).click();
  await confirm(page);
  await expect(page.getByRole('heading', { name: 'Исследователь', exact: true })).toBeVisible();
}
test.beforeEach(async () => {
  await resetSyntheticFamilyDatabase();
});

test('expired consent is explicit and can be renewed; proxy overwrites forged assertions', async ({
  page,
  context,
}, testInfo) => {
  await context.setExtraHTTPHeaders({
    'x-forwarded-for': '192.0.2.99',
    'x-probyu-client-ip': 'not-an-ip',
    'x-probyu-proxy-key': 'forged',
  });
  await activate(page);
  await page.getByRole('button', { name: 'Разрешить историю', exact: true }).click();
  await confirm(page);
  await expect(page.getByRole('button', { name: 'Выключить историю', exact: true })).toBeVisible();
  await expireSyntheticConsent();
  await page.reload();
  await expect(
    page.getByText('Текстовое согласие больше не действует.', { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText('Согласие на историю больше не действует.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Передать ребёнку', exact: true })).toBeDisabled();
  await page.screenshot({
    path: testInfo.outputPath('consent-expired.png'),
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'Разрешить текстовый сценарий', exact: true }).click();
  await confirm(page);
  await expect(
    page.getByText('Текстовое согласие больше не действует.', { exact: false }),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Передать ребёнку', exact: true })).toBeEnabled();
});

test('cancelling a mistyped proof never restores an expired parent view', async ({ page }) => {
  await activate(page);
  await page.getByRole('button', { name: 'Приостановить доступ', exact: true }).click();
  await expireSyntheticParentPrivilege();
  await page.getByLabel('Одноразовый код').fill('000000');
  await page.getByRole('button', { name: 'Подтвердить', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Осталось попыток: 4');
  await page.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Взрослый режим закрыт' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Отозвать текстовое согласие' })).toHaveCount(0);
});

test('a pending code survives periodic validation and a typo can be corrected without restarting', async ({
  page,
}, testInfo) => {
  await page.clock.install();
  const response = await page.goto('/family');
  expect(response?.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(response?.headers()['content-security-policy']).toContain("script-src 'self';");
  await page.getByRole('button', { name: 'Войти: Аврора' }).click();
  const input = page.getByLabel('Одноразовый код');
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute('autocomplete', 'one-time-code');
  await input.fill('123');
  const checked = page.waitForResponse(
    (r) => r.url().endsWith('/v1/family/session') && r.request().method() === 'GET',
  );
  await page.clock.fastForward(61_000);
  await checked;
  await expect(input).toHaveValue('123');
  await input.fill('000000');
  await page.getByRole('button', { name: 'Подтвердить', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Осталось попыток: 4');
  await expect(input).toBeVisible();
  await expect(input).toBeFocused();
  await page.screenshot({
    path: testInfo.outputPath('code-retry.png'),
    fullPage: true,
  });
  await confirm(page);
  await expect(page.getByRole('heading', { name: 'Начнём с разрешений' })).toBeFocused();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('periodic validation closes a pending form when the server loses the session', async ({
  page,
  context,
}) => {
  await page.clock.install();
  await login(page);
  await page.getByRole('checkbox', { name: /^Базовый текстовый сценарий/ }).check();
  await page.getByRole('button', { name: 'Продолжить с этими разрешениями' }).click();
  await expect(page.getByLabel('Одноразовый код')).toBeVisible();
  await context.clearCookies();
  await page.clock.fastForward(61_000);
  await expect(page.getByRole('heading', { name: 'Проверка доступа' })).toBeVisible();
  await expect(page.getByLabel('Одноразовый код')).toHaveCount(0);
});

test('activation, optional history, two tabs, fresh return, revoke and storage', async ({
  page,
  context,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await activate(page);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath('parent.png'),
    fullPage: true,
  });
  const second = await context.newPage();
  await second.goto('/family');
  await expect(second.getByRole('heading', { name: 'Исследователь', exact: true })).toBeVisible();
  await page.bringToFront();
  await page.getByRole('button', { name: 'Передать ребёнку', exact: true }).click();
  await confirm(page);
  await expect(page.getByRole('heading', { name: 'Привет, Исследователь!' })).toBeVisible();
  await second.bringToFront();
  await expect(second.getByRole('heading', { name: 'Привет, Исследователь!' })).toBeVisible();
  await expect(second.getByRole('button', { name: 'Отозвать текстовое согласие' })).toHaveCount(0);
  await second.getByRole('button', { name: 'Для взрослого', exact: true }).click();
  await expect(second.getByRole('heading', { name: 'Подтвердите действие' })).toBeVisible();
  await confirm(second);
  await expect(second.getByRole('heading', { name: 'Исследователь', exact: true })).toBeVisible();
  await second.getByRole('button', { name: 'Отозвать текстовое согласие' }).click();
  await confirm(second);
  await expect(
    second.getByRole('button', { name: 'Передать ребёнку', exact: true }),
  ).toBeDisabled();
  expect((await new AxeBuilder({ page: second }).analyze()).violations).toEqual([]);
  const storage = await second.evaluate(async () => ({
    local: localStorage.length,
    session: sessionStorage.length,
    dbs: (await indexedDB.databases()).length,
    caches: (await caches.keys()).length,
    sw: (await navigator.serviceWorker.getRegistrations()).length,
  }));
  expect(storage).toEqual({ local: 0, session: 0, dbs: 0, caches: 0, sw: 0 });
  const cookies = await context.cookies();
  expect(cookies).toHaveLength(1);
  expect(cookies[0]).toMatchObject({
    name: '__Host-probuyu_session',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  });
  expect(errors).toEqual([]);
  await second.getByRole('button', { name: 'Выйти из сессии' }).click();
  await expect(second.getByRole('button', { name: 'Войти: Аврора' })).toBeVisible();
});
test('reload, Back/pageshow and network failure keep the parent surface closed', async ({
  page,
  context,
}, testInfo) => {
  await activate(page);
  await page.getByRole('button', { name: 'Передать ребёнку', exact: true }).click();
  await confirm(page);
  await expect(page.getByRole('heading', { name: 'Привет, Исследователь!' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Привет, Исследователь!' })).toBeVisible();
  await page.getByRole('link', { name: 'Открыть готовый пример' }).click();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Привет, Исследователь!' })).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByRole('heading', { name: 'Проверка доступа' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Исследователь', exact: true })).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath('offline.png'),
    fullPage: true,
  });
  await context.setOffline(false);
  await page.getByRole('button', { name: 'Проверить доступ', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Привет, Исследователь!' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('restoring a real BFCache parent document revalidates the server mode', async ({
  page,
  context,
}) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Page.enable');
  const reasons: unknown[] = [];
  cdp.on('Page.backForwardCacheNotUsed', (event) => reasons.push(event));
  await page.addInitScript(() => {
    window.addEventListener('pageshow', (event) => {
      document.documentElement.dataset.m2Persisted = String(event.persisted);
    });
  });
  await activate(page);
  await page.goto('/?m2-public-hop');
  const second = await context.newPage();
  await second.goto('/family');
  await expect(second.getByRole('heading', { name: 'Исследователь', exact: true })).toBeVisible();
  await second.getByRole('button', { name: 'Передать ребёнку', exact: true }).click();
  await confirm(second);
  await expect(second.getByRole('heading', { name: 'Привет, Исследователь!' })).toBeVisible();
  await page.bringToFront();
  await page.goBack({ waitUntil: 'commit' });
  await expect(page.getByRole('heading', { name: 'Привет, Исследователь!' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Отозвать текстовое согласие' })).toHaveCount(0);
  const reason = await page.evaluate(() =>
    JSON.stringify(
      (
        performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming & {
          notRestoredReasons?: unknown;
        }
      ).notRestoredReasons,
    ),
  );
  expect(
    await page.locator('html').getAttribute('data-m2-persisted'),
    JSON.stringify({ reason, reasons }),
  ).toBe('true');
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
