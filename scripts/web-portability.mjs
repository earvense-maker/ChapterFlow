import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// NOTE: 設計書 Phase 0 の「Electron専用モジュールと純粋な共有ロジックの依存関係を可視化する」
// と「storageService の直接import箇所を洗い出す」を機械的に行う。手で書いた一覧は必ず腐るので、
// ソースから毎回作り直し、テスト（tests/unit/webPortability.test.ts）で差分を検出する。

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const workspaceRoot = path.resolve(scriptDir, '..');

const SCAN_ROOTS = ['src', 'apps'];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

/**
 * パスヘルパーは公開Web版に対応物が無い（設計書 3「保存先選択」）。
 * これらを使っている箇所は Phase 2 で単なる差し替えでは済まず、作り替えが要る。
 */
const STORAGE_PATH_HELPERS = [
  'projectDir',
  'setupSessionJsonPath',
  'projectJsonPath',
  'stateJsonPath',
  'presetsJsonPath',
  'charactersJsonPath',
  'legacyCharactersBackupPath',
  'memoriesJsonPath',
  'worldMdPath',
  'contextSummaryMdPath',
  'storyStateJsonPath',
  'storyStateDiffsJsonPath',
  'expressionsJsonPath',
  'knowledgeDir',
  'knowledgeIndexJsonPath',
  'knowledgeContentPath',
  'refineScanJsonPath',
  'roleplaySessionsDir',
  'roleplaySessionJsonPath',
  'refineSessionJsonPath',
  'refineAutomationJsonPath',
  'episodesDir',
  'episodeJsonPath',
  'episodeMdPath',
  'generationsDir',
  'generationLogPath',
  'generationMdPath',
  'generationPromptPath',
  'generationStyleTraceStorePath',
];

/** 公開Web版へ持ち込めない依存。apps/web に1つでも現れたら Phase 0 の境界が壊れている。 */
const ELECTRON_ONLY_MODULES = [
  'electron',
  '../config.js',
  'services/storageService',
  'services/lanAuthService',
  'services/shortcutService',
  'services/dataDirMoveService',
  'services/dataDirFileLock',
  'services/credentialService',
];

export async function collectInventory() {
  const files = [];
  for (const root of SCAN_ROOTS) {
    files.push(...(await listSourceFiles(path.join(workspaceRoot, root))));
  }
  files.sort();

  const contractAdapters = [];
  const storageDataImporters = [];
  const storagePathImporters = [];
  const nodeFsUsers = [];
  const electronUsers = [];
  const webAppViolations = [];

  for (const absolutePath of files) {
    const relativePath = toPosix(path.relative(workspaceRoot, absolutePath));
    const source = await readFile(absolutePath, 'utf-8');

    if (importsStorageService(source)) {
      const usedPathHelpers = STORAGE_PATH_HELPERS.filter((helper) =>
        new RegExp(`\\bstorage\\.${helper}\\b|\\b${helper}\\s*\\(`).test(source)
      );
      // NOTE: 契約アダプタ自身は storageService を呼ぶのが役目なので、未移行として数えない。
      if (relativePath.startsWith('src/server/storage/')) {
        contractAdapters.push(relativePath);
      } else if (usedPathHelpers.length > 0) {
        storagePathImporters.push({ file: relativePath, pathHelpers: usedPathHelpers });
      } else {
        storageDataImporters.push(relativePath);
      }
    }

    if (/from '(node:fs|node:fs\/promises)'/.test(source)) nodeFsUsers.push(relativePath);
    if (/from 'electron'|import\('electron'\)/.test(source)) electronUsers.push(relativePath);

    if (relativePath.startsWith('apps/web/')) {
      for (const forbidden of ELECTRON_ONLY_MODULES) {
        if (source.includes(`'${forbidden}'`) || source.includes(`"${forbidden}"`)) {
          webAppViolations.push({ file: relativePath, imported: forbidden });
        }
      }
      // NOTE: 相対パスで src/ を掘りに行く経路も塞ぐ。共有したい純粋ロジックは
      // packages/core へ抽出してから使う（設計書 4.1）。
      if (/from '\.\.\/\.\.\/\.\.\/src\//.test(source)) {
        webAppViolations.push({ file: relativePath, imported: '../../../src/*' });
      }
    }
  }

  return {
    contractAdapters,
    storageDataImporters,
    storagePathImporters,
    nodeFsUsers,
    electronUsers,
    webAppViolations,
  };
}

function importsStorageService(source) {
  return /from '[^']*storageService\.js'/.test(source);
}

async function listSourceFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      files.push(...(await listSourceFiles(full)));
      continue;
    }
    if (SOURCE_EXTENSIONS.has(path.extname(entry.name)) && !entry.name.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files;
}

function toPosix(value) {
  return value.replaceAll('\\', '/');
}

export function renderInventoryMarkdown(inventory) {
  const lines = [
    '# 公開Web版 移行インベントリ',
    '',
    '<!-- このファイルは scripts/web-portability.mjs が生成する。手で編集しない。 -->',
    '<!-- 更新: npm run web:inventory -->',
    '',
    '設計書 Phase 0「Electron専用モジュールと純粋な共有ロジックの依存関係を可視化する」',
    'および「`storageService` の直接import箇所を洗い出す」の出力。',
    '',
    `## 0. 契約アダプタ（${inventory.contractAdapters.length}件）`,
    '',
    '`storageService` を呼ぶのが役目のファイル。移行対象ではない。',
    '',
    ...inventory.contractAdapters.map((file) => `- \`${file}\``),
    '',
    `## 1. ストレージ契約へ未移行（データ操作のみ・${inventory.storageDataImporters.length}件）`,
    '',
    'Phase 2 で `WebStorage` へ差し替えるだけで済む見込みの呼び出し元。',
    '',
    ...inventory.storageDataImporters.map((file) => `- \`${file}\``),
    '',
    `## 2. パスヘルパー依存（${inventory.storagePathImporters.length}件）`,
    '',
    'ファイルパスを前提にしているため、公開Web版では差し替えではなく作り替えが要る。',
    '',
    ...inventory.storagePathImporters.map(
      ({ file, pathHelpers }) => `- \`${file}\` — ${pathHelpers.join(', ')}`
    ),
    '',
    `## 3. \`node:fs\` 依存（${inventory.nodeFsUsers.length}件）`,
    '',
    '共有パッケージ（`packages/core`）へ入れられないモジュール（設計書 4.1）。',
    '',
    ...inventory.nodeFsUsers.map((file) => `- \`${file}\``),
    '',
    `## 4. Electron 依存（${inventory.electronUsers.length}件）`,
    '',
    ...inventory.electronUsers.map((file) => `- \`${file}\``),
    '',
    '## 5. 公開Web版への依存混入',
    '',
    inventory.webAppViolations.length === 0
      ? 'なし。`apps/web` は Electron 専用モジュールを参照していない。'
      : inventory.webAppViolations
          .map(({ file, imported }) => `- \`${file}\` が \`${imported}\` を参照している`)
          .join('\n'),
    '',
  ];
  return `${lines.join('\n')}`;
}

const inventoryDocPath = path.join(
  workspaceRoot,
  'docs',
  'design',
  '公開Web版_移行インベントリ.md'
);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inventory = await collectInventory();
  await writeFile(inventoryDocPath, renderInventoryMarkdown(inventory), 'utf-8');
  process.stdout.write(`inventory written: ${toPosix(path.relative(workspaceRoot, inventoryDocPath))}\n`);
}
