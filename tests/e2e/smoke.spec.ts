import { test, expect } from '@playwright/test';

test('新規作品を作成し、生成画面に遷移する', async ({ page }) => {
  await page.goto('/');
  await page.click('text=新規作品');
  await page.fill('input[type="text"]', 'テスト作品');
  await page.click('text=作品を作成');
  await expect(page.locator('h1')).toContainText('テスト作品');
});

test('APIキー未設定時にエラーが表示されず、入力が保持される', async ({ page }) => {
  await page.goto('/');
  await page.click('text=新規作品');
  await page.fill('input[type="text"]', 'エラーテスト作品');
  await page.click('text=作品を作成');
  await page.fill('input[placeholder*="もっと不穏"]', 'テストの希望');
  await page.locator('footer button').click();
  await expect(page.locator('.error-toast')).toContainText('APIキー');
  await expect(page.locator('input[placeholder*="もっと不穏"]')).toHaveValue('テストの希望');
});
