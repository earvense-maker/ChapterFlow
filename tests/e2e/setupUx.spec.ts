import { test, expect } from '@playwright/test';

test('相談内容が空なら作品化できず、種メモ保存後は確認画面を表示する', async ({ page }) => {
  let session = createSession();
  let committedBody: {
    plan: { project: { title: string }; characters: Array<{ role: string }>; firstWishSuggestion?: string };
    revision: number;
  } | null = null;

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
          firstWishSuggestion: '雨の図書館で、閉館間際に二人が出会うところから始めたい。',
          world: { foundation: '', initialSituation: '' },
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
  await expect(dialog.getByLabel('世界の土台')).toHaveValue('');
  await expect(dialog.getByLabel('開始時点の状況')).toHaveValue('');
  await expect(dialog.getByLabel('第1話冒頭への希望')).toHaveValue('雨の図書館で、閉館間際に二人が出会うところから始めたい。');
  await expect(dialog.getByLabel('人物1の役割')).toHaveValue('supporting');
  await expect(dialog.getByRole('button', { name: '相談に戻る' })).toBeVisible();

  await dialog.getByLabel('作品タイトル').fill('雨の図書館');
  await dialog.getByLabel('世界の土台').fill('夢は図書館の本に宿る。');
  await dialog.getByLabel('開始時点の状況').fill('閉館間際、雨が強まっている。');
  await dialog.getByLabel('第1話冒頭への希望').fill('雨の日の図書館で、閉館間際に二人が出会うところから始めたい。');
  await dialog.getByLabel('人物1の役割').selectOption('deuteragonist');
  await dialog.getByRole('button', { name: 'この内容で作品を作る' }).click();

  await expect.poll(() => committedBody?.revision).toBe(3);
  expect(committedBody?.plan.project.title).toBe('雨の図書館');
  expect(committedBody?.plan.world).toEqual({
    foundation: '夢は図書館の本に宿る。',
    initialSituation: '閉館間際、雨が強まっている。',
  });
  expect(committedBody?.plan.characters[0].role).toBe('deuteragonist');
  expect(committedBody?.plan.firstWishSuggestion).toBe('雨の日の図書館で、閉館間際に二人が出会うところから始めたい。');
  await expect(dialog).toBeHidden();
});

test('初回の案内から候補を出し、試し書きをその場で調整できる', async ({ page }) => {
  let session = createSession();
  const previewInstructions: Array<string | undefined> = [];
  let chatTurn = 0;
  let previewRequestCount = 0;
  let reloadWithServerDraft = false;

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
  await page.route('**/api/setup-sessions/setup-e2e', async (route) => {
    if (reloadWithServerDraft) {
      reloadWithServerDraft = false;
      session = {
        ...session,
        revision: session.revision + 1,
        draft: { ...session.draft, coreConcept: 'サーバー側で確定した核' },
      };
    }
    await route.fulfill({ json: session });
  });
  await page.route('**/api/setup-sessions/setup-e2e/draft', async (route) => {
    reloadWithServerDraft = true;
    await route.fulfill({ status: 500, json: { error: 'draft_failed' } });
  });
  await page.route('**/api/setup-sessions/setup-e2e/messages/stream', async (route) => {
    const body = route.request().postDataJSON() as { message: string };
    const now = '2026-07-10T00:01:00.000Z';
    const currentTurn = chatTurn;
    chatTurn += 1;
    const userMessage = {
      messageId: `msg-user-e2e-${currentTurn}`,
      role: 'user',
      content: body.message,
      createdAt: now,
    } as const;
    const assistantMessage = {
      messageId: `msg-assistant-e2e-${currentTurn}`,
      role: 'assistant',
      content: currentTurn === 0 ? 'まずはこの候補から始めましょう。' : '候補を外し、人物の役割を見直しました。',
      createdAt: now,
    } as const;
    const nextDraft = currentTurn === 0
      ? {
          ...session.draft,
          candidates: [
            ...session.draft.candidates,
            {
              id: 'candidate-e2e',
              title: '雨宿りの約束',
              summary: '閉館間際の図書館で、二人がひとつの約束を交わす。',
              source: 'llm',
              status: 'active' as const,
              createdAt: now,
              updatedAt: now,
            },
          ],
          characters: [
            ...session.draft.characters,
            {
              id: 'character-e2e',
              role: 'deuteragonist' as const,
              name: '',
              label: '雨宮',
              description: '閉館間際の図書館に現れる人物。',
              source: 'llm',
              status: 'active' as const,
              createdAt: now,
              updatedAt: now,
            },
          ],
          world: ['夜の街', '古い駅'],
        }
      : {
          ...session.draft,
          candidates: session.draft.candidates.map((candidate) =>
            candidate.id === 'candidate-e2e'
              ? { ...candidate, status: 'archived' as const, updatedAt: now }
              : candidate
          ),
          characters: session.draft.characters.map((character) =>
            character.id === 'character-e2e'
              ? { ...character, role: 'supporting' as const, updatedAt: now }
              : character
          ),
          world: ['港町'],
        };
    session = {
      ...session,
      revision: session.revision + 1,
      messages: [...session.messages, userMessage, assistantMessage],
      draft: nextDraft,
    };
    const response = {
      session,
      assistantMessage,
      draft: session.draft,
      suggestedActions:
        currentTurn === 0
          ? [
              {
                label: '試し書きで温度を見る',
                message: '現在の内容で試し書きを作ってください。',
                intent: 'preview',
              },
            ]
          : [
              {
                label: 'このまま作品にする',
                message: 'この内容で作品にしてください。',
                intent: 'commit',
              },
            ],
      revision: session.revision,
    };
    await route.fulfill({
      headers: { 'content-type': 'text/event-stream' },
      body: `event: result\ndata: ${JSON.stringify(response)}\n\n`,
    });
  });
  await page.route('**/api/setup-sessions/setup-e2e/preview', async (route) => {
    const body = route.request().postDataJSON() as { instruction?: string };
    previewInstructions.push(body.instruction);
    previewRequestCount += 1;
    if (previewRequestCount === 1) {
      await route.fulfill({ status: 500, json: { error: 'preview_failed' } });
      return;
    }
    const now = '2026-07-10T00:02:00.000Z';
    const previewText = `${body.instruction ?? '最初'}の試し書き`;
    session = {
      ...session,
      revision: session.revision + 1,
      draft: body.instruction
        ? { ...session.draft, tone: [...session.draft.tone, body.instruction] }
        : session.draft,
      previews: [
        ...(session.previews ?? []),
        { previewId: `preview-${session.revision}`, text: previewText, createdAt: now },
      ],
    };
    await route.fulfill({ json: { previewText, session, revision: session.revision } });
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
          firstWishSuggestion: '雨の図書館で、閉館間際に二人が出会うところから始めたい。',
          world: { foundation: '', initialSituation: session.draft.world.join('、') },
          characters: [],
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

  await page.goto('/');
  await page.getByRole('banner').getByRole('button', { name: '相談して作る', exact: true }).click();

  await expect(page.getByText('どんな物語を読みたいですか？ 好きな雰囲気や関係性だけでも大丈夫です。一緒に見つけましょう。')).toBeVisible();
  const starter = page.getByRole('button', { name: 'おまかせで候補を出して', exact: true });
  await expect(starter).toBeEnabled();
  await starter.click();

  await expect(page.locator('.setup-draft-edit-row.is-recently-updated')).toHaveCount(4);
  await expect(page.getByText('追加', { exact: true })).toHaveCount(4);

  const coreConcept = page.locator('.setup-draft-section').filter({ hasText: '作品の核' });
  await coreConcept.getByPlaceholder('まだ決まっていません').fill('ローカルで入力した核');
  await coreConcept.getByRole('button', { name: '保存' }).click();
  await expect(page.getByPlaceholder('まだ決まっていません')).toHaveValue('サーバー側で確定した核');
  await expect(page.getByText('作品の核を追加', { exact: true })).toBeVisible();

  const previewAction = page.getByRole('button', { name: '試し書きで温度を見る', exact: true });
  await previewAction.click();
  await expect(page.locator('.setup-error')).toBeVisible();
  await expect(page.getByText('作品の核を追加', { exact: true })).toBeVisible();
  await expect(coreConcept).toHaveClass(/is-recently-updated/);

  await previewAction.click();
  await expect.poll(() => previewInstructions.at(-1)).toBeUndefined();
  await expect(page.getByText('最初の試し書き', { exact: true })).toBeVisible();
  await expect(page.getByText('作品の核を追加', { exact: true })).toBeVisible();
  await expect(coreConcept).toHaveClass(/is-recently-updated/);
  expect(chatTurn).toBe(1);
  await expect(page.getByRole('button', { name: 'もっと軽く', exact: true })).toBeVisible();
  await expect(page.getByLabel('試し書きの調整')).toBeVisible();

  await page.getByRole('button', { name: 'もっと軽く', exact: true }).click();
  await expect.poll(() => previewInstructions.at(-1)).toBe('もっと軽く');
  await expect(page.getByText('もっと軽くの試し書き', { exact: true })).toBeVisible();
  await expect(page.getByText('好み・文体「もっと軽く」を追加', { exact: true })).toBeVisible();

  await page.getByLabel('試し書きの調整').fill('地の文を短めに');
  await page.getByRole('button', { name: 'この希望で再生成', exact: true }).click();
  await expect.poll(() => previewInstructions.at(-1)).toBe('地の文を短めに');
  await expect(page.getByText('好み・文体「地の文を短めに」を追加', { exact: true })).toBeVisible();

  await page.getByPlaceholder('読みたい物語の雰囲気、好きな関係性、避けたい展開など').fill('候補は外して、人物の役割を見直したい。');
  await page.getByRole('button', { name: '送る', exact: true }).click();
  await expect(page.getByText('候補「雨宿りの約束」を削除', { exact: true })).toBeVisible();
  await expect(page.getByText('人物「雨宮」を更新', { exact: true })).toBeVisible();
  await expect(page.getByText('世界観「夜の街」を「港町」に更新', { exact: true })).toBeVisible();
  await expect(page.getByText('世界観「古い駅」を削除', { exact: true })).toBeVisible();
  await expect(
    page.locator('.setup-draft-section').filter({ hasText: '人物' }).getByRole('combobox')
  ).toHaveValue('supporting');
  await expect(
    page.locator('.setup-draft-section').filter({ hasText: '世界観' }).locator('.setup-draft-edit-row.is-recently-updated')
  ).toHaveCount(1);

  await page.getByRole('button', { name: 'このまま作品にする', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '作品にする内容を確認' })).toBeVisible();
  expect(chatTurn).toBe(2);
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
