import { test, expect } from '@playwright/test';

test('新規作品を作成し、生成画面に遷移する', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '設定を直接入力', exact: true }).click();
  await page.fill('input[type="text"]', 'テスト作品');
  await page.click('text=作品を作成');
  await expect(page.locator('h1')).toContainText('テスト作品');
});

test('APIキー未設定時にエラーを表示し、入力を保持する', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '設定を直接入力', exact: true }).click();
  await page.fill('input[type="text"]', 'エラーテスト作品');
  await page.click('text=作品を作成');
  const wishInput = page.getByRole('textbox', {
    name: '次のシーンへの指示（Ctrl+Enterで送信）',
  });
  await wishInput.fill('テストの希望');
  await page.getByRole('button', { name: '生成', exact: true }).click();
  await expect(page.locator('.error-toast')).toContainText('APIキー');
  await expect(wishInput).toHaveValue('テストの希望');
});
