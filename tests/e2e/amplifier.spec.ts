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

test('方向取得失敗から再取得して選択肢を表示できる', async ({ page }) => {
  const projectId = 'proj-amplifier-retry';
  const generationId = 'gen-amplifier-retry';
  const anchor = { kind: 'novel', generationId, textRevisionNumber: 0 };
  const baseTurn = {
    schemaVersion: 1,
    turnId: 'amp-turn-retry',
    projectId,
    contextKey: 'novel:main',
    anchor,
    anchorTextHash: 'hash',
    anchorExcerpt: '雨上がりのホームで、二人は次の電車を待っていた。',
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
  };
  const failedTurn = {
    ...baseTurn,
    status: 'failed',
    choices: [],
    revision: 1,
    errorCode: 'amplifier_choices_invalid',
  };
  const readyTurn = {
    ...baseTurn,
    status: 'ready',
    revision: 2,
    choices: [
      {
        choiceId: 'choice-1',
        strategy: 'exploit',
        label: '傘をそっと傾ける',
        description: '濡れた肩に気づいた彼女が、二人の距離を少しだけ縮める。',
      },
      {
        choiceId: 'choice-2',
        strategy: 'variation',
        label: '言いかけた名前',
        description: '呼び方を迷った一瞬から、隠していた親しさがこぼれる。',
      },
      {
        choiceId: 'choice-3',
        strategy: 'explore',
        label: '反対ホームの人影',
        description: '見覚えのある人影が現れ、二人だけの時間に小さな揺れが入る。',
      },
    ],
  };
  const project = {
    schemaVersion: 1,
    projectId,
    title: '雨上がりの待ち時間',
    projectType: 'novel',
    experienceMode: 'amplifier',
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
    activeModelProvider: 'deepseek',
    activeModelName: 'deepseek-v4-flash',
    outputLength: 3000,
    streamingEnabled: true,
    activePresetIds: { narration: 'third-close' },
    lastExcerpt: '雨上がりのホームで、二人は次の電車を待っていた。',
  };
  let createRequests = 0;
  let readerStateRequests = 0;

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === '/api/projects') {
      await route.fulfill({ json: [project] });
    } else if (path === `/api/projects/${projectId}/reader-state`) {
      readerStateRequests += 1;
      await route.fulfill({
        json: {
          project,
          state: {
            lastOpenedAt: project.updatedAt,
            currentEpisodeId: null,
            currentSceneId: null,
            selectedDraftGenerationId: generationId,
            lastAcceptedGenerationId: null,
            pendingMemoryCandidateIds: [],
            storyStateRefresh: { status: 'pending', generationId, updatedAt: project.updatedAt },
            uiState: { readingPosition: 0, fontSize: 18 },
          },
          currentEpisode: null,
          currentScene: null,
          currentGeneration: {
            generationId,
            episodeId: 'episode-retry',
            sceneId: 'scene-retry',
            request: { wish: '続きを見たい', outputLength: 3000, previousContextText: '' },
            responseText:
              readerStateRequests > 1
                ? '雨上がりのホームで、二人は次の電車を待っていた。屋根から雨粒が落ちる。'
                : '雨上がりのホームで、二人は次の電車を待っていた。',
            usedPresets: { narration: 'third-close' },
            usedModel: { provider: 'deepseek', modelName: 'deepseek-v4-flash' },
            referencedMemoryIds: [],
            status: 'draft',
            createdAt: project.updatedAt,
            parentGenerationId: null,
          },
          memories: [],
          knowledgeFiles: [],
          navigation: {
            currentSceneOrder: null,
            totalScenes: 0,
            hasPreviousScene: false,
            hasNextScene: false,
          },
          contextUsage: null,
          contextSummaryExcerpt: '',
        },
      });
    } else if (path === `/api/projects/${projectId}/amplifier/state`) {
      await route.fulfill({ json: { turn: failedTurn, preferences: null } });
    } else if (path === `/api/projects/${projectId}/amplifier/turns`) {
      createRequests += 1;
      await route.fulfill({ status: 201, json: { turn: readyTurn, stale: false } });
    } else if (path.endsWith('/characters') || path.endsWith('/knowledge')) {
      await route.fulfill({ json: [] });
    } else if (path.endsWith('/expressions') || path === '/api/expressions/global') {
      await route.fulfill({ json: { ngExpressions: [] } });
    } else if (path === '/api/system/ng-auto-rewrite') {
      await route.fulfill({ json: { enabled: false, maxRewritesPerGeneration: 3 } });
    } else if (path === '/api/system/notification-settings') {
      await route.fulfill({ json: null });
    } else {
      await route.fulfill({ status: 404, json: { error: `Unhandled test route: ${path}` } });
    }
  });

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');
  await page.getByRole('heading', { name: project.title }).click();
  await expect(page.getByText('方向の取得に失敗しました。本文はそのまま残っています。')).toBeVisible();

  await page.getByRole('button', { name: '方向を再取得' }).click();
  await expect.poll(() => createRequests).toBe(1);
  await expect(page.getByRole('button', { name: /傘をそっと傾ける/ })).toBeVisible();

  // 採用後の派生処理ポーリングで親 Reader が再描画されても、同じアンカーの
  // 選択肢を再取得せず、自由入力の値とフォーカスを維持する。
  const freeText = page.getByPlaceholder('こんな方向も見たい…（自由記述）');
  await freeText.fill('このまま静かに話したい');
  await freeText.focus();
  const requestsBeforePoll = readerStateRequests;
  await expect.poll(() => readerStateRequests).toBeGreaterThan(requestsBeforePoll);
  await expect(freeText).toHaveValue('このまま静かに話したい');
  await expect(freeText).toBeFocused();
  expect(createRequests).toBe(1);

  const fit = await page.locator('[data-amplifier-controls]').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
    };
  });
  expect(fit.left).toBeGreaterThanOrEqual(0);
  expect(fit.right).toBeLessThanOrEqual(fit.viewportWidth);
  expect(fit.documentWidth).toBeLessThanOrEqual(fit.viewportWidth);
  await page.screenshot({ path: 'test-results/amplifier-retry.png' });
});
