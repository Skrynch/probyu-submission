import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';

/**
 * F-01: публичная fixed demo без ввода, профиля, AI и browser persistence.
 * Контент приходит из embedded synthetic fixture через OpenAPI SDK.
 */

type Audit = { consoleErrors: string[]; failedRequests: string[]; requests: string[] };

function watchPage(page: Page): Audit {
  const audit: Audit = { consoleErrors: [], failedRequests: [], requests: [] };
  page.on('console', (message) => {
    if (message.type() === 'error') audit.consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => audit.consoleErrors.push(error.message));
  page.on('requestfailed', (request) => audit.failedRequests.push(request.url()));
  page.on('request', (request) => audit.requests.push(`${request.method()} ${request.url()}`));
  return audit;
}

function expectCleanNetwork(audit: Audit, baseURL: string) {
  expect(audit.consoleErrors).toEqual([]);
  expect(audit.failedRequests).toEqual([]);
  for (const entry of audit.requests) {
    const [method, url = ''] = entry.split(' ');
    // Только GET на собственный origin; API — только публичный demo namespace.
    expect(method).toBe('GET');
    expect(url.startsWith(baseURL)).toBe(true);
    const { pathname } = new URL(url);
    if (pathname.startsWith('/v1/'))
      expect(pathname).toMatch(/^\/v1\/demo\/scenarios(\/paper-fall)?$/);
  }
}

async function expectNoBrowserPersistence(page: Page) {
  expect(await page.context().cookies()).toEqual([]);
  const storage = await page.evaluate(async () => ({
    local: window.localStorage.length,
    session: window.sessionStorage.length,
    indexedDb: (await indexedDB.databases()).length,
    caches: (await caches.keys()).length,
    serviceWorkers: (await navigator.serviceWorker.getRegistrations()).length,
  }));
  expect(storage).toEqual({ local: 0, session: 0, indexedDb: 0, caches: 0, serviceWorkers: 0 });
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function expectNoFreeInput(page: Page) {
  await expect(
    page.locator(
      'input:not([type="radio"]):not([aria-hidden="true"]), textarea, [contenteditable="true"]',
    ),
  ).toHaveCount(0);
}

/** Нажимает Tab, пока фокус не окажется на элементе с нужным доступным именем. */
async function tabTo(page: Page, name: RegExp, limit = 30) {
  for (let index = 0; index < limit; index += 1) {
    await page.keyboard.press('Tab');
    const focusedName = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      if (element === null) return '';
      return element.getAttribute('aria-label') ?? element.innerText ?? '';
    });
    if (name.test(focusedName)) return;
  }
  throw new Error(`Focus did not reach ${String(name)}`);
}

const desktopOnly = (testInfo: TestInfo) => testInfo.project.name !== 'desktop-chromium';
const mobileOnly = (testInfo: TestInfo) => testInfo.project.name !== 'mobile-chromium';

test('keyboard-only happy path with reflection answer', async ({ page, baseURL }, testInfo) => {
  test.skip(desktopOnly(testInfo), 'Keyboard path runs on desktop.');
  const audit = watchPage(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Вопрос, который можно проверить руками',
  );
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.getByRole('banner')).toBeVisible();
  await expect(page.getByRole('contentinfo')).toBeVisible();

  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Перейти к содержанию' })).toBeFocused();
  await expect(page.getByRole('link', { name: 'Перейти к содержанию' })).toBeInViewport();

  await tabTo(page, /Начать пример/);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/demo\/paper-fall\/question$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Почему смятый лист падает быстрее плоского?',
  );
  await expect(
    page.getByRole('navigation', { name: 'Путь примера' }).locator('[aria-current="step"]'),
  ).toHaveText('Вопрос');
  await expectNoFreeInput(page);

  await tabTo(page, /Узнать почему/);
  await page.keyboard.press('Enter');
  const explanationHeading = page.getByRole('heading', { level: 1, name: 'Почему так происходит' });
  await expect(explanationHeading).toBeFocused();
  await expect(
    page.getByText('Воздух толкает предметы, которые движутся сквозь него.'),
  ).toBeVisible();

  await tabTo(page, /К пробе/);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: /Сравнить падение/ })).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Сначала безопасность' })).toBeVisible();
  await expect(page.getByText('Не вставай на стул, стол или подоконник.')).toBeVisible();

  await tabTo(page, /Отметить результат/);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Что получилось?' })).toBeFocused();

  // Отправка без выбора даёт связанную ошибку, а не переход.
  await tabTo(page, /Показать отклик/);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toHaveText('Выбери один из вариантов.');
  await expect(page.getByRole('radiogroup')).toHaveAttribute('aria-invalid', 'true');

  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('radio', { name: 'Смятый лист чаще был первым' })).toBeFocused();
  // Roving focus Radix переносит фокус асинхронно: клавиша удерживается, как у человека.
  await page.keyboard.press('ArrowDown', { delay: 80 });
  await expect(page.getByRole('radio', { name: 'Они падали почти одновременно' })).toBeChecked();
  await tabTo(page, /Показать отклик/);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: 'Отклик на твой выбор' })).toBeFocused();
  await expect(
    page.getByText('Попробуй отпускать листы строго вместе и повторить сравнение.'),
  ).toBeVisible();

  await tabTo(page, /Дальше/);
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Что сильнее всего повлияло на результат?' }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Space');
  await expect(page.getByRole('radio', { name: 'Форма листа' })).toBeChecked();
  await tabTo(page, /^Ответить$/);
  await page.keyboard.press('Enter');

  await expect(
    page.getByRole('heading', { level: 1, name: 'Что показал этот эпизод' }),
  ).toBeFocused();
  await expect(page.getByText('Они падали почти одновременно')).toBeVisible();
  await expect(page.getByText(/Форма листа$/)).toBeVisible();
  await expect(page.getByText('Пока мало наблюдений')).toBeVisible();
  await expect(page.getByText(/не оценка способностей или устойчивый паттерн/)).toBeVisible();

  await tabTo(page, /Завершить/);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Проба завершена' })).toBeFocused();
  await tabTo(page, /Вернуться в начало/);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/$/);

  await expectNoBrowserPersistence(page);
  expectCleanNetwork(audit, baseURL ?? '');
});

test('touch path with skipped reflection, back navigation and no overflow', async ({
  page,
  baseURL,
}, testInfo) => {
  test.skip(mobileOnly(testInfo), 'Touch path runs on mobile.');
  const audit = watchPage(page);
  await page.goto('/');
  await expectNoHorizontalOverflow(page);
  await page.getByRole('link', { name: /Начать пример/ }).tap();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Почему смятый лист падает быстрее плоского?',
  );
  await expectNoHorizontalOverflow(page);

  await page.getByRole('button', { name: 'Узнать почему' }).tap();
  await expect(page).toHaveURL(/explanation$/);
  await page.goBack();
  await expect(page).toHaveURL(/question$/);
  await page.goForward();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Почему так происходит' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'К пробе' }).tap();
  await expectNoHorizontalOverflow(page);
  await page.getByRole('button', { name: 'Отметить результат' }).tap();
  await page.getByText('Смятый лист чаще был первым').tap();
  await page.getByRole('button', { name: 'Показать отклик' }).tap();
  await expect(
    page.getByText('Это согласуется с идеей о меньшем сопротивлении воздуха.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Дальше' }).tap();

  await expect(page.getByRole('button', { name: 'Пропустить' })).toBeVisible();
  const primaryBox = await page.getByRole('button', { name: 'Ответить' }).boundingBox();
  expect(primaryBox?.height ?? 0).toBeGreaterThanOrEqual(48);
  await page.getByRole('button', { name: 'Пропустить' }).tap();

  await expect(
    page.getByRole('heading', { level: 1, name: 'Что показал этот эпизод' }),
  ).toBeVisible();
  await expect(page.getByText('Рефлексия пропущена')).toBeVisible();
  await expect(page.getByText('Пока мало наблюдений')).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.getByRole('button', { name: 'Завершить' }).tap();
  await page.getByRole('button', { name: 'Пройти пример ещё раз' }).tap();
  await expect(page).toHaveURL(/question$/);
  await page.getByRole('link', { name: 'Выйти из примера' }).tap();
  await expect(page).toHaveURL(/\/$/);

  await expectNoBrowserPersistence(page);
  expectCleanNetwork(audit, baseURL ?? '');
});

test('reflow at 320 and 768 CSS px keeps every step usable', async ({ page }, testInfo) => {
  test.skip(mobileOnly(testInfo), 'Narrow reflow runs once.');
  for (const width of [320, 768]) {
    await page.setViewportSize({ width, height: 700 });
    await page.goto('/');
    await expectNoHorizontalOverflow(page);
    for (const step of ['question', 'explanation', 'probe', 'result']) {
      await page.goto(`/demo/paper-fall/${step}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expectNoHorizontalOverflow(page);
    }
  }
});

test('reload keeps public step but never restores choices', async ({ page }, testInfo) => {
  test.skip(desktopOnly(testInfo), 'Reload semantics run once.');
  await page.goto('/demo/paper-fall/probe');
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: /Сравнить падение/ })).toBeVisible();

  await page.getByRole('button', { name: 'Отметить результат' }).click();
  await page.getByText('Плоский лист оказался первым').click();
  await page.getByRole('button', { name: 'Показать отклик' }).click();
  await page.getByRole('button', { name: 'Дальше' }).click();
  await expect(page).toHaveURL(/reflection$/);

  await page.reload();
  await expect(page).toHaveURL(/result$/);
  await expect(page.getByRole('status').filter({ hasText: 'выборы не сохраняются' })).toBeVisible();
  await expect(page.getByRole('radio', { checked: true })).toHaveCount(0);

  await page.goto('/demo/paper-fall/done');
  await expect(page).toHaveURL(/result$/);
  await expectNoBrowserPersistence(page);
});

test('Back from reflection never submits the optional answer', async ({ page }, testInfo) => {
  test.skip(desktopOnly(testInfo), 'Form navigation regression runs once.');
  await page.goto('/demo/paper-fall/probe');
  await page.getByRole('button', { name: 'Отметить результат' }).click();
  await page.getByText('Смятый лист чаще был первым').click();
  await page.getByRole('button', { name: 'Показать отклик' }).click();
  await page.getByRole('button', { name: 'Дальше' }).click();
  await page.getByRole('radio', { name: 'Форма листа' }).click();

  await page.getByRole('button', { name: 'Назад' }).click();

  await expect(page).toHaveURL(/result$/);
  await expect(page.getByRole('link', { name: 'Наблюдение' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Дальше' }).click();
  await expect(page.getByRole('radio', { checked: true })).toHaveCount(0);
});

test('editing a confirmed result invalidates later steps until reconfirmed', async ({
  page,
}, testInfo) => {
  test.skip(desktopOnly(testInfo), 'Draft result regression runs once.');
  await page.goto('/demo/paper-fall/probe');
  await page.getByRole('button', { name: 'Отметить результат' }).click();
  await page.getByText('Смятый лист чаще был первым').click();
  await page.getByRole('button', { name: 'Показать отклик' }).click();
  await page.getByRole('button', { name: 'Дальше' }).click();
  await page.getByRole('button', { name: 'Пропустить' }).click();
  await page.getByRole('link', { name: 'Результат' }).click();

  await page.getByRole('radio', { name: 'Они падали почти одновременно' }).click();

  await expect(page.getByRole('region', { name: 'Отклик на твой выбор' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Наблюдение' })).toHaveCount(0);
  await page.goto('/demo/paper-fall/observation');
  await expect(page).toHaveURL(/result$/);

  await page.getByRole('radio', { name: 'Они падали почти одновременно' }).click();
  await page.getByRole('button', { name: 'Показать отклик' }).click();
  await page.getByRole('button', { name: 'Дальше' }).click();
  await page.getByRole('button', { name: 'Пропустить' }).click();
  await expect(page.getByText('Они падали почти одновременно')).toBeVisible();
  await expect(page.getByText('Смятый лист чаще был первым')).toHaveCount(0);
});

test('network error shows honest state and retry recovers without invented content', async ({
  page,
}, testInfo) => {
  test.skip(desktopOnly(testInfo), 'Error states run once.');
  let mode: 'offline' | 'server-error' | 'online' = 'offline';
  await page.route('**/v1/demo/scenarios/**', async (route) => {
    if (mode === 'offline') return route.abort('internetdisconnected');
    if (mode === 'server-error') return route.fulfill({ status: 503, body: '' });
    return route.continue();
  });

  await page.goto('/demo/paper-fall/question');
  await expect(page.getByRole('heading', { name: 'Нет связи с сервером' })).toBeVisible();
  await expect(page.getByText('Почему смятый лист падает быстрее плоского?')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Узнать почему' })).toHaveCount(0);

  mode = 'server-error';
  await page.getByRole('button', { name: 'Повторить' }).click();
  await expect(page.getByRole('heading', { name: 'Сервер сейчас не отвечает' })).toBeVisible();

  mode = 'online';
  await page.getByRole('button', { name: 'Повторить' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Почему смятый лист падает быстрее плоского?' }),
  ).toBeVisible();
});

test('start page list error and unknown scenario are handled', async ({ page }, testInfo) => {
  test.skip(desktopOnly(testInfo), 'Error states run once.');
  let offline = true;
  await page.route('**/v1/demo/scenarios', async (route) =>
    offline ? route.abort('internetdisconnected') : route.continue(),
  );
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Нет связи с сервером' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Начать пример/ })).toHaveCount(0);
  offline = false;
  await page.getByRole('button', { name: 'Повторить' }).click();
  await expect(page.getByRole('link', { name: /Начать пример/ })).toBeVisible();

  await page.goto('/demo/unknown-scenario/question');
  await expect(page.getByRole('heading', { name: 'Такого примера нет' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Повторить' })).toHaveCount(0);
});

test('reduced motion removes step and rail movement', async ({ browser }, testInfo) => {
  test.skip(desktopOnly(testInfo), 'Motion preference runs once.');
  const context = await browser.newContext({
    reducedMotion: 'reduce',
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  await page.goto('/demo/paper-fall/explanation');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Почему так происходит' }),
  ).toBeVisible();
  const motion = await page.evaluate(() => {
    const seconds = (value: string) =>
      Math.max(...value.split(',').map((part) => Number.parseFloat(part)));
    const step = getComputedStyle(document.querySelector('.step-enter') as Element);
    const cause = getComputedStyle(document.querySelector('.cause-chain__item') as Element);
    const pointer = getComputedStyle(document.querySelector('.measure-rail__pointer') as Element);
    return {
      step: seconds(step.animationDuration),
      cause: seconds(cause.animationDuration),
      causeDelay: seconds(cause.animationDelay),
      pointer: seconds(pointer.transitionDuration),
    };
  });
  expect(motion.step).toBeLessThan(0.001);
  expect(motion.cause).toBeLessThan(0.001);
  expect(motion.causeDelay).toBe(0);
  expect(motion.pointer).toBeLessThan(0.001);
  await context.close();
});

async function expectAccessible(page: Page, state: string) {
  // Контраст считается по завершённому кадру, а не по середине входной анимации.
  await page.evaluate(() =>
    Promise.all(
      document.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const violations = results.violations.map(
    (violation) =>
      `${state}: ${violation.id} ${violation.nodes
        .map((node) => `${node.target.join(' ')} ${node.failureSummary ?? ''}`)
        .join(' | ')}`,
  );
  expect(violations).toEqual([]);
}

test.describe('accessibility audit', () => {
  // Итоговые кадры без входной анимации: axe иначе меряет полупрозрачный промежуточный кадр.
  test.use({ contextOptions: { reducedMotion: 'reduce' } });

  test('every F-01 state passes automated WCAG 2.2 AA checks', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: /Начать пример/ }).waitFor();
    await expectAccessible(page, 'start');

    await page.getByRole('link', { name: /Начать пример/ }).click();
    const primary = page.getByRole('button', { name: 'Узнать почему' });
    await expect(primary).toBeVisible();
    // Регрессия tailwind-merge: текст главного действия белый на primary.
    expect(await primary.evaluate((element) => getComputedStyle(element).color)).toBe(
      'rgb(255, 255, 255)',
    );
    await expectAccessible(page, 'question');

    await primary.click();
    await expectAccessible(page, 'explanation');
    await page.getByRole('button', { name: 'К пробе' }).click();
    await expectAccessible(page, 'probe');
    await page.getByRole('button', { name: 'Отметить результат' }).click();
    await page.getByRole('button', { name: 'Показать отклик' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expectAccessible(page, 'result-error');
    await page.getByText('Плоский лист оказался первым').click();
    await page.getByRole('button', { name: 'Показать отклик' }).click();
    await expect(page.getByRole('region', { name: 'Отклик на твой выбор' })).toBeVisible();
    await expectAccessible(page, 'result-feedback');
    await page.getByRole('button', { name: 'Дальше' }).click();
    await expectAccessible(page, 'reflection');
    await page.getByRole('button', { name: 'Пропустить' }).click();
    await expectAccessible(page, 'observation');
    await page.getByRole('button', { name: 'Завершить' }).click();
    await expectAccessible(page, 'done');

    await page.route('**/v1/demo/scenarios/**', (route) => route.abort('internetdisconnected'));
    await page.goto('/demo/paper-fall/question');
    await expect(page.getByRole('heading', { name: 'Нет связи с сервером' })).toBeVisible();
    await expectAccessible(page, 'network-error');
  });
});
