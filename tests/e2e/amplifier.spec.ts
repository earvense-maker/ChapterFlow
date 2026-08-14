import { test, expect } from '@playwright/test';

test('妄想増幅器の説明・形式選択・ロールプレイ作成導線が画面内で動く', async ({ page }) => {
  let acknowledged = false;
  let standardSetupBody: Record<string, unknown> | null = null;

  await page.route('**/api/projects', async (route) => {
    await route.fulfill({ json: [] });
  });
  await page.route('**/api/system/amplifier-disclosure', async (route) => {
    if (route.request().method() === 'PUT') acknowledged = true;
    await route.fulfill({ json: { version: 1, acknowledged } });
  });
  await page.route('**/api/setup-sessions', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: [] });
      return;
    }
    standardSetupBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 201,
      json: {
        sessionId: 'setup-standard-after-amplifier',
        session: { sessionId: 'setup-standard-after-amplifier', revision: 1 },
        suggestedActions: [],
      },
    });
  });

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');
  await page.getByRole('button', { name: '妄想増幅器を始める', exact: true }).first().click();

  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expect(page.getByRole('heading', { name: '妄想増幅器を始める' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'はじめる前に' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'ロールプレイとして体験する' })).toBeVisible();
  await expect(page.getByRole('button', { name: '小説として眺める' })).toBeVisible();

  const fit = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    modeCards: (() => {
      const element = document.querySelector('.amplifier-mode-cards');
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: rect.width };
    })(),
  }));
  expect(fit.documentWidth).toBeLessThanOrEqual(fit.viewportWidth);
  expect(fit.modeCards).not.toBeNull();
  expect(fit.modeCards?.left).toBeGreaterThanOrEqual(0);
  expect(fit.modeCards?.right).toBeLessThanOrEqual(fit.viewportWidth);
  await page.screenshot({ path: 'test-results/amplifier-entry.png' });

  await page.getByRole('button', { name: '理解しました', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'はじめる前に' })).toBeHidden();
  expect(acknowledged).toBe(true);

  await page.getByRole('button', { name: 'ロールプレイとして体験する' }).click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expect(
    page.getByRole('heading', { name: '一文からキャラとの会話を始める' })
  ).toBeVisible();
  await expect(page.getByText('見たいキャラクター・関係・雰囲気', { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
    )
  ).toBe(true);

  // amplifier を離れた後の通常導線へ experienceMode を持ち越さない。
  await page.getByRole('button', { name: 'キャンセル', exact: true }).click();
  await page
    .getByRole('button', { name: '一文からキャラ会話を始める', exact: true })
    .first()
    .click();
  await page.getByLabel('見たいキャラクター・関係・雰囲気').fill('静かな先輩と話したい');
  await page.getByRole('button', { name: 'この一文で作品を作る', exact: true }).click();
  await expect.poll(() => standardSetupBody).not.toBeNull();
  expect(standardSetupBody).toMatchObject({ purpose: 'roleplay', setupMode: 'quick' });
  expect(standardSetupBody).not.toHaveProperty('experienceMode');
});
