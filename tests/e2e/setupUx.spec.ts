import { test, expect } from '@playwright/test';

test('相談内容が空なら作品化できず、種メモ保存後は確認画面を表示する', async ({ page }) => {
  let session = createSession();
  let committedBody: { plan: { project: { title: string }; characters: Array<{ role: string }> }; revision: number } | null = null;

  await page.route('**/api/projects', async (route) => {
    await route.fulfill({ json: [] });
  });
  await page.route('**/api/models/providers', async (route) => {
    await route.fulfill({
      json: [
        {
          name: 'deepseek',
          label: 'DeepSeek',
          defaultModel: 'deepseek-v4-flash',
          apiKeyPlaceholder: 'sk-...',
          apiKeyHelp: 'DeepSeek APIキー',
          hasApiKey: true,
        },
      ],
    });
  });
  await page.route('**/api/models/default', async (route) => {
    await route.fulfill({ json: { provider: 'deepseek', modelName: 'deepseek-v4-flash' } });
  });
  await page.route('**/api/setup-sessions', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: [] });
      return;
    }
    await route.fulfill({
      status: 201,
      json: { sessionId: session.sessionId, session, suggestedActions: [] },
    });
  });
  await page.route('**/api/setup-sessions/setup-e2e/draft', async (route) => {
    const body = route.request().postDataJSON();
    session = { ...session, draft: body.draft, revision: session.revision + 1 };
    await route.fulfill({ json: { session, draft: session.draft, revision: session.revision } });
  });
  await page.route('**/api/setup-sessions/setup-e2e/commit-plan', async (route) => {
    session = { ...session, revision: session.revision + 1 };
    await route.fulfill({
      json: {
        session,
        revision: session.revision,
        plan: {
          project: { title: '仮題：雨の図書館', outputLength: 3000, activePresetIds: {} },
          coreConcept: session.draft.coreConcept,
          worldText: '',
          characters: [
            { characterId: 'char-1', name: '', role: 'supporting', description: '旅人' },
          ],
          memories: [],
          storyState: {
            schemaVersion: 1,
            currentSituation: [],
            characterStates: [],
            importantEvents: [],
            openThreads: [],
            updatedAt: '2026-07-10T00:00:00.000Z',
          },
          customSystemPrompt: '',
        },
      },
    });
  });
  await page.route('**/api/setup-sessions/setup-e2e/commit', async (route) => {
    committedBody = route.request().postDataJSON();
    session = { ...session, status: 'committed', committedProjectId: 'proj-e2e', revision: session.revision + 1 };
    await route.fulfill({ json: { projectId: 'proj-e2e', session } });
  });

  await page.goto('/');
  await page.getByRole('banner').getByRole('button', { name: '相談して作る', exact: true }).click();

  const createButton = page.getByRole('button', { name: 'この内容で作品を作る', exact: true });
  await expect(createButton).toBeDisabled();
  await expect(page.getByText('この相談のモデル:')).toBeVisible();

  await page.getByPlaceholder('まだ決まっていません').fill('雨の図書館で出会う二人');
  await page.locator('.setup-draft-section').filter({ hasText: '作品の核' }).getByRole('button', { name: '保存' }).click();
  await expect(createButton).toBeEnabled();
  await createButton.click();

  const dialog = page.getByRole('dialog', { name: '作品にする内容を確認' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('作品タイトル')).toHaveValue('仮題：雨の図書館');
  await expect(dialog.getByLabel('人物1の役割')).toHaveValue('supporting');
  await expect(dialog.getByRole('button', { name: '相談に戻る' })).toBeVisible();

  await dialog.getByLabel('作品タイトル').fill('雨の図書館');
  await dialog.getByLabel('人物1の役割').selectOption('deuteragonist');
  await dialog.getByRole('button', { name: 'この内容で作品を作る' }).click();

  await expect.poll(() => committedBody?.revision).toBe(3);
  expect(committedBody?.plan.project.title).toBe('雨の図書館');
  expect(committedBody?.plan.characters[0].role).toBe('deuteragonist');
  await expect(dialog).toBeHidden();
});

function createSession() {
  return {
    schemaVersion: 1,
    sessionId: 'setup-e2e',
    projectId: null,
    status: 'active',
    revision: 1,
    model: { provider: 'deepseek', modelName: 'deepseek-v4-flash' },
    projectSettings: {
      title: '',
      outputLength: 3000,
      streamingEnabled: false,
      activePresetIds: {},
    },
    messages: [],
    draft: {
      coreConcept: '',
      confirmed: [],
      candidates: [],
      undecided: [],
      characters: [],
      relationshipSeeds: [],
      world: [],
      tone: [],
      ng: [],
      openingSeeds: [],
    },
    locks: [],
    lastError: null,
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
  };
}
