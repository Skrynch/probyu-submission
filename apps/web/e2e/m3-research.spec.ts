import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { resetSyntheticResearchDatabase } from '../../../services/backend/src/db/research-test-support';

async function confirm(page: Page) {
  const code = await page.getByTestId('dev-code').textContent();
  await page.getByLabel('Одноразовый код').fill(code!);
  await page.getByRole('button', { name: 'Подтвердить', exact: true }).click();
}

async function enterChildMode(page: Page) {
  await page.goto('/family');
  await page.getByRole('button', { name: 'Войти: Аврора' }).click();
  await confirm(page);
  await page.getByRole('checkbox', { name: /^Базовый текстовый сценарий/ }).check();
  await page.getByLabel('Возрастная группа').selectOption('13_14');
  await page.getByRole('button', { name: 'Продолжить с этими разрешениями' }).click();
  await confirm(page);
  await page.getByRole('button', { name: 'Передать ребёнку' }).click();
  await confirm(page);
  await expect(page.getByRole('heading', { name: 'Привет, Исследователь!' })).toBeVisible();
  await page.getByRole('link', { name: 'Начать исследование' }).click();
  await expect(page.getByRole('heading', { name: 'Что тебе интересно проверить?' })).toBeVisible();
}

async function askSuggested(page: Page, question: string) {
  await page.getByRole('button', { name: question }).click();
  await expect(page.getByLabel('Твой вопрос')).toHaveValue(question);
  await page.getByRole('button', { name: 'Задать вопрос' }).click();
  await expect(page.getByText('Проверенное объяснение')).toBeVisible({ timeout: 15_000 });
}

test.beforeEach(async () => {
  await resetSyntheticResearchDatabase();
});

test('approved project survives reload and server pause/resume through the final instruction', async ({
  page,
  context,
}, testInfo) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await enterChildMode(page);
  await askSuggested(page, 'Почему бумажная башня бывает устойчивой?');
  await expect(page.getByText('Мини-проект', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Бумажная башня без клея' })).toBeVisible();
  await expect(page.getByText('Это учебный ответ системы: он может ошибаться.')).toBeVisible();
  await expect(page.getByText(/минимальный риск/)).toBeVisible();
  await expect(page.getByText(/Начать или вернуться можно до/)).toBeVisible();
  await expect(page.getByText(/deterministic fake|Детский режим · M3/)).toHaveCount(0);
  const runUrl = page.url();
  expect(runUrl).toMatch(/\/research\/[0-9a-f-]{36}$/);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Вот что можно проверить' })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect(page.getByRole('heading', { name: 'Проверяем доступ' })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
  await expect(page.getByRole('heading', { name: 'Вот что можно проверить' })).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByRole('heading', { name: 'Для продолжения нужна сеть' })).toBeVisible();
  await expect(page.getByText('Бумажная башня без клея')).toHaveCount(0);
  await context.setOffline(false);
  await expect(page.getByRole('heading', { name: 'Вот что можно проверить' })).toBeVisible();
  let dropStartAcknowledgement = true;
  await page.route('**/v1/research/offers/*/commands', async (route) => {
    if (!dropStartAcknowledgement) return route.continue();
    dropStartAcknowledgement = false;
    await route.fetch();
    await route.abort('connectionfailed');
  });
  await page.getByRole('button', { name: 'Начать пробу' }).click();
  await expect(page.getByRole('alert')).toContainText('Нет связи с сервером');
  await page.getByRole('button', { name: 'Начать пробу' }).click();
  await expect(page.getByText(/шаг 1 из 4/)).toBeVisible();
  consoleErrors.splice(0, consoleErrors.length);
  await page.getByRole('button', { name: 'Поставить на паузу' }).click();
  await expect(page.getByText(/Пауза сохранена на сервере/)).toBeVisible();
  await page.reload();
  await expect(page.getByText(/Пауза сохранена на сервере/)).toBeVisible();
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  for (let step = 0; step < 4; step++) {
    await page.getByRole('button', { name: 'Шаг выполнен' }).click();
  }
  await expect(page.getByRole('heading', { name: 'Все шаги пройдены' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('project-complete.png'), fullPage: true });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  const storage = await page.evaluate(async () => ({
    local: localStorage.length,
    session: sessionStorage.length,
    indexed: (await indexedDB.databases()).length,
    caches: (await caches.keys()).length,
    serviceWorker: Boolean(navigator.serviceWorker?.controller),
  }));
  expect(storage).toEqual({ local: 0, session: 0, indexed: 0, caches: 0, serviceWorker: false });
  expect(consoleErrors).toEqual([]);
});

test('unsafe input is closed and curated micro/experience offers can be declined without labels', async ({
  page,
}) => {
  await enterChildMode(page);
  await page.getByLabel('Твой вопрос').fill('Меня зовут Петя, мой телефон +7 999 123-45-67');
  await page.getByRole('button', { name: 'Задать вопрос' }).click();
  await expect(
    page.getByRole('heading', { name: 'С этим вопросом нужна другая помощь' }),
  ).toBeVisible();
  await expect(page.getByText('+7 999')).toHaveCount(0);
  await page.getByRole('button', { name: 'Задать другой вопрос' }).click();
  await askSuggested(page, 'Как провести опыт с бумажной дорожкой?');
  await expect(page.getByText('Опыт', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Не хочу сейчас' }).click();
  await expect(
    page.getByRole('heading', { name: 'Хорошо, пробу можно не начинать' }),
  ).toBeVisible();
  await expect(page.getByText('Отказ не влияет на оценки — их здесь вообще нет.')).toBeVisible();
  await page.getByRole('button', { name: 'Задать другой вопрос' }).click();
  await askSuggested(page, 'Почему бумага падает по-разному?');
  await expect(page.getByText('Короткая проба', { exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('an expired offer gives the child a direct path to a new question', async ({ page }) => {
  await enterChildMode(page);
  await askSuggested(page, 'Почему бумага падает по-разному?');
  let offerExpired = false;
  await page.route('**/v1/research/offers/*/commands', async (route) => {
    offerExpired = true;
    await route.fulfill({
      status: 410,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'OFFER_EXPIRED' }),
    });
  });
  await page.route('**/v1/research/answers/current', async (route) => {
    if (!offerExpired) return route.continue();
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.getByRole('button', { name: 'Начать пробу' }).click();
  await expect(
    page.getByRole('heading', { name: 'Время для начала этой пробы закончилось' }),
  ).toBeVisible();
  await expect(page.getByText('помощь взрослого не нужна')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Вернуть устройство взрослому' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Задать новый вопрос' }).click();
  await expect(page.getByRole('heading', { name: 'Что тебе интересно проверить?' })).toBeVisible();
});

test('a forbidden START immediately removes the approved private surface', async ({ page }) => {
  await enterChildMode(page);
  await askSuggested(page, 'Почему бумажная башня бывает устойчивой?');
  await expect(page.getByRole('heading', { name: 'Бумажная башня без клея' })).toBeVisible();
  await page.route('**/v1/research/offers/*/commands', async (route) => {
    await route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'FORBIDDEN' }),
    });
  });

  await page.getByRole('button', { name: 'Начать пробу' }).click();
  await expect(page.getByRole('heading', { name: 'Исследования пока закрыты' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Верни устройство взрослому');
  await expect(page.getByText('Бумажная башня без клея')).toHaveCount(0);
  await expect(page.getByText('Это учебный ответ системы: он может ошибаться.')).toHaveCount(0);
});

test('a delayed START acknowledgement cannot cross a lifecycle privacy boundary', async ({
  page,
}) => {
  await enterChildMode(page);
  await askSuggested(page, 'Почему бумажная башня бывает устойчивой?');
  await expect(page.getByRole('heading', { name: 'Бумажная башня без клея' })).toBeVisible();

  let markStartCommitted!: () => void;
  let releaseStart!: () => void;
  let markStartDelivered!: () => void;
  const startCommitted = new Promise<void>((resolve) => {
    markStartCommitted = resolve;
  });
  const startHeld = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  const startDelivered = new Promise<void>((resolve) => {
    markStartDelivered = resolve;
  });
  await page.route('**/v1/research/offers/*/commands', async (route) => {
    const response = await route.fetch();
    markStartCommitted();
    await startHeld;
    await route.fulfill({ response });
    markStartDelivered();
  });

  let markRevalidationStarted!: () => void;
  let releaseRevalidation!: () => void;
  const revalidationStarted = new Promise<void>((resolve) => {
    markRevalidationStarted = resolve;
  });
  const revalidationHeld = new Promise<void>((resolve) => {
    releaseRevalidation = resolve;
  });
  await page.route(/\/v1\/research\/answers\/[0-9a-f-]{36}$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    markRevalidationStarted();
    await revalidationHeld;
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'UNAVAILABLE' }),
    });
  });

  await page.getByRole('button', { name: 'Начать пробу' }).click();
  await startCommitted;
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect(page.getByRole('heading', { name: 'Проверяем доступ' })).toBeVisible();
  await expect(page.getByText('Бумажная башня без клея')).toHaveCount(0);

  await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
  await revalidationStarted;
  await expect(page.getByRole('heading', { name: 'Проверяем вопрос' })).toBeVisible();

  releaseStart();
  await startDelivered;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(page.getByRole('heading', { name: 'Проверяем вопрос' })).toBeVisible();
  await expect(page.getByText('Бумажная башня без клея')).toHaveCount(0);
  await expect(page.getByText(/шаг 1 из 4/)).toHaveCount(0);

  releaseRevalidation();
  await expect(
    page.getByRole('heading', { name: 'Не удалось открыть это исследование' }),
  ).toBeVisible();
  await expect(page.getByText('Бумажная башня без клея')).toHaveCount(0);
});

test('a delayed NEXT acknowledgement cannot roll back a revalidated newer step', async ({
  page,
  context,
}) => {
  await enterChildMode(page);
  await askSuggested(page, 'Почему бумажная башня бывает устойчивой?');
  await page.getByRole('button', { name: 'Начать пробу' }).click();
  await expect(page.getByText(/шаг 1 из 4/)).toBeVisible();
  const runUrl = page.url();

  let markNextCommitted!: () => void;
  let releaseNext!: () => void;
  let markNextDelivered!: () => void;
  const nextCommitted = new Promise<void>((resolve) => {
    markNextCommitted = resolve;
  });
  const nextHeld = new Promise<void>((resolve) => {
    releaseNext = resolve;
  });
  const nextDelivered = new Promise<void>((resolve) => {
    markNextDelivered = resolve;
  });
  await page.route('**/v1/research/challenges/*/commands', async (route) => {
    const response = await route.fetch();
    markNextCommitted();
    await nextHeld;
    await route.fulfill({ response });
    markNextDelivered();
  });

  await page.getByRole('button', { name: 'Шаг выполнен' }).click();
  await nextCommitted;

  const second = await context.newPage();
  await second.goto(runUrl);
  await expect(
    second.getByText(
      'Сложи или сверни листы руками так, чтобы из них получились устойчивые опоры.',
    ),
  ).toBeVisible();
  await second.getByRole('button', { name: 'Шаг выполнен' }).click();
  const newerStep =
    'Поставь опоры рядом и положи сверху оставшийся лист. Не поднимай конструкцию выше уровня глаз.';
  await expect(second.getByText(newerStep)).toBeVisible();

  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect(page.getByRole('heading', { name: 'Проверяем доступ' })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
  await expect(page.getByText(newerStep)).toBeVisible();

  releaseNext();
  await nextDelivered;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(page.getByText(newerStep)).toBeVisible();
  await expect(
    page.getByText('Сложи или сверни листы руками так, чтобы из них получились устойчивые опоры.'),
  ).toHaveCount(0);
});

test('an unauthenticated cancel immediately removes the pending private surface', async ({
  page,
}) => {
  await enterChildMode(page);
  let firstAnswerSnapshot = true;
  await page.route(/\/v1\/research\/answers\/[0-9a-f-]{36}$/, async (route) => {
    if (!firstAnswerSnapshot || route.request().method() !== 'GET') return route.continue();
    firstAnswerSnapshot = false;
    const id = route.request().url().split('/').at(-1)!;
    const now = new Date().toISOString();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id, status: 'QUEUED', createdAt: now, updatedAt: now }),
    });
  });
  await page.route('**/v1/research/answers/*/events?*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    await route.abort('connectionfailed').catch(() => undefined);
  });
  await page.route('**/v1/research/answers/*/cancel', async (route) => {
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'UNAUTHENTICATED' }),
    });
  });
  await page.getByRole('button', { name: 'Почему бумага падает по-разному?' }).click();
  await page.getByRole('button', { name: 'Задать вопрос' }).click();
  await expect(page.getByRole('heading', { name: 'Готовим безопасное объяснение' })).toBeVisible();

  await page.getByRole('button', { name: 'Остановить запрос' }).click();
  await expect(page.getByRole('heading', { name: 'Исследования пока закрыты' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Доступ закончился');
  await expect(page.getByRole('heading', { name: 'Готовим безопасное объяснение' })).toHaveCount(0);
});

test('a slow watcher keeps cancel available and shows a clear long-wait state', async ({
  page,
}) => {
  await enterChildMode(page);
  let firstAnswerSnapshot = true;
  await page.route(/\/v1\/research\/answers\/[0-9a-f-]{36}$/, async (route) => {
    if (!firstAnswerSnapshot || route.request().method() !== 'GET') return route.continue();
    firstAnswerSnapshot = false;
    const id = route.request().url().split('/').at(-1)!;
    const now = new Date().toISOString();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id, status: 'QUEUED', createdAt: now, updatedAt: now }),
    });
  });
  await page.route('**/v1/research/answers/*/events?*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    await route.abort('connectionfailed').catch(() => undefined);
  });
  await page.getByRole('button', { name: 'Почему бумага падает по-разному?' }).click();
  await page.getByRole('button', { name: 'Задать вопрос' }).click();
  await expect(page.getByRole('heading', { name: 'Готовим безопасное объяснение' })).toBeVisible();
  const cancel = page.getByRole('button', { name: 'Остановить запрос' });
  await expect(cancel).toBeEnabled();
  await expect(page.getByText(/занимает больше времени/)).toBeVisible({ timeout: 4_500 });
  await expect(cancel).toBeEnabled();
  await cancel.click();
  await expect(page.getByRole('heading', { name: 'Запрос остановлен' })).toBeVisible();
});

test('a completed-before-cancel race reloads the authorized answer instead of blanking the UI', async ({
  page,
}) => {
  await enterChildMode(page);
  let firstAnswerSnapshot = true;
  await page.route(/\/v1\/research\/answers\/[0-9a-f-]{36}$/, async (route) => {
    if (!firstAnswerSnapshot || route.request().method() !== 'GET') return route.continue();
    firstAnswerSnapshot = false;
    const id = route.request().url().split('/').at(-1)!;
    const now = new Date().toISOString();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id, status: 'QUEUED', createdAt: now, updatedAt: now }),
    });
  });
  let markDeliveryComplete!: () => void;
  let releaseEvents!: () => void;
  const deliveryComplete = new Promise<void>((resolve) => {
    markDeliveryComplete = resolve;
  });
  const eventsReleased = new Promise<void>((resolve) => {
    releaseEvents = resolve;
  });
  await page.route('**/v1/research/answers/*/events?*', async (route) => {
    const response = await route.fetch();
    markDeliveryComplete();
    await eventsReleased;
    await route.fulfill({ response }).catch(() => undefined);
  });
  let cancelPayload: Record<string, unknown> | undefined;
  page.on('response', async (response) => {
    if (response.request().method() === 'POST' && response.url().endsWith('/cancel')) {
      cancelPayload = (await response.json()) as Record<string, unknown>;
    }
  });

  await page.getByRole('button', { name: 'Почему бумага падает по-разному?' }).click();
  await page.getByRole('button', { name: 'Задать вопрос' }).click();
  await expect(page.getByRole('heading', { name: 'Готовим безопасное объяснение' })).toBeVisible();
  await deliveryComplete;
  await page.getByRole('button', { name: 'Остановить запрос' }).click();
  releaseEvents();

  await expect(page.getByRole('heading', { name: 'Вот что можно проверить' })).toBeVisible();
  expect(cancelPayload).toMatchObject({ status: 'COMPLETED' });
  expect(cancelPayload).not.toHaveProperty('answer');
  expect(cancelPayload).not.toHaveProperty('challengeRun');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a second tab keeps a different question visible and explains the active-run conflict', async ({
  page,
  context,
}) => {
  await enterChildMode(page);
  const second = await context.newPage();
  await second.goto('/research');
  await expect(
    second.getByRole('heading', { name: 'Что тебе интересно проверить?' }),
  ).toBeVisible();

  let markAccepted!: () => void;
  let releaseResponse!: () => void;
  const accepted = new Promise<void>((resolve) => {
    markAccepted = resolve;
  });
  const heldResponse = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  await page.route('**/v1/research/questions', async (route) => {
    const response = await route.fetch();
    markAccepted();
    await heldResponse;
    await route.fulfill({ response });
  });

  await page.getByRole('button', { name: 'Почему бумага падает по-разному?' }).click();
  await page.getByRole('button', { name: 'Задать вопрос' }).click();
  await accepted;
  const differentQuestion = 'Почему бумажная башня бывает устойчивой?';
  await second.getByLabel('Твой вопрос').fill(differentQuestion);
  await second.getByRole('button', { name: 'Задать вопрос' }).click();
  await expect(second.getByRole('alert')).toContainText('Новый вопрос не отправлен');
  await expect(second.getByLabel('Твой вопрос')).toHaveValue(differentQuestion);

  releaseResponse();
  await expect(page.getByText('Проверенное объяснение')).toBeVisible({ timeout: 15_000 });
});
