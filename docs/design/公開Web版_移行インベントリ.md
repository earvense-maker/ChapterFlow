# 公開Web版 移行インベントリ

<!-- このファイルは scripts/web-portability.mjs が生成する。手で編集しない。 -->
<!-- 更新: npm run web:inventory -->

設計書 Phase 0「Electron専用モジュールと純粋な共有ロジックの依存関係を可視化する」
および「`storageService` の直接import箇所を洗い出す」の出力。

## 0. 契約アダプタ（1件）

`storageService` を呼ぶのが役目のファイル。移行対象ではない。

- `src/server/storage/fileProjectStorage.ts`

## 1. ストレージ契約へ未移行（データ操作のみ・15件）

Phase 2 で `WebStorage` へ差し替えるだけで済む見込みの呼び出し元。

- `src/server/prompts/contextAssembler.ts`
- `src/server/routes/generate.ts`
- `src/server/routes/settings.ts`
- `src/server/services/expressionService.ts`
- `src/server/services/generationReaderState.ts`
- `src/server/services/ngRewriteService.ts`
- `src/server/services/postGenerationMaintenanceService.ts`
- `src/server/services/refineAutomationGuard.ts`
- `src/server/services/refineAutomationService.ts`
- `src/server/services/refineChatService.ts`
- `src/server/services/refineScanService.ts`
- `src/server/services/roleplaySessionService.ts`
- `src/server/services/setupSessionService.ts`
- `src/server/services/storyStateService.ts`
- `src/server/services/styleVariationService.ts`

## 2. パスヘルパー依存（3件）

ファイルパスを前提にしているため、公開Web版では差し替えではなく作り替えが要る。

- `src/server/services/generationService.ts` — generationMdPath, generationPromptPath
- `src/server/services/knowledgeService.ts` — knowledgeContentPath
- `src/server/services/shortcutService.ts` — episodeMdPath

## 3. `node:fs` 依存（18件）

共有パッケージ（`packages/core`）へ入れられないモジュール（設計書 4.1）。

- `apps/web/src/config.ts`
- `src/electron/main.ts`
- `src/electron/userDataPath.ts`
- `src/server/app.ts`
- `src/server/prompts/presetParts.ts`
- `src/server/prompts/styleSamplePresets.ts`
- `src/server/routes/settings.ts`
- `src/server/routes/system.ts`
- `src/server/services/appSettingsService.ts`
- `src/server/services/dataDirFileLock.ts`
- `src/server/services/dataDirMoveService.ts`
- `src/server/services/setupCommitService.ts`
- `src/server/services/shortcutService.ts`
- `src/server/services/storageService.ts`
- `src/server/utils/crashLog.ts`
- `src/server/utils/legacyDirResolver.ts`
- `src/server/utils/pathSafety.ts`
- `src/server/utils/safeWrite.ts`

## 4. Electron 依存（2件）

- `src/electron/main.ts`
- `src/server/routes/system.ts`

## 5. 公開Web版への依存混入

なし。`apps/web` は Electron 専用モジュールを参照していない。
