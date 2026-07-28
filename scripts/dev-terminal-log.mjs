import { closeSync, mkdirSync, openSync, renameSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath, pathToFileURL } from 'node:url';

// NOTE: crashLog.ts が拾えるのは unhandledRejection / uncaughtException だけで、
// ウィンドウを閉じた・OOM で殺された・ネイティブクラッシュ、といった「外から落ちた」
// 場合は JS のハンドラが一度も走らず、痕跡がゼロになる(2026-07-27 の事故)。
// そこで dev のターミナル出力そのものをファイルへ複写しておき、どんな死に方でも
// 直前に何が出ていたかを後から読めるようにする。

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = path.resolve(__dirname, '..');
export const DEV_TERMINAL_LOG_PATH = path.join(PROJECT_ROOT, 'logs', 'dev-terminal.log');
export const MAX_LOG_BYTES = 5_000_000;

// NOTE: CSI と OSC のエスケープシーケンス。ソースへ生の制御文字を置きたくないので
// RegExp コンストラクタで組み立てる。ファイル側は素のテキストで読みたいため落とす。
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI_PATTERN = new RegExp(
  `${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`,
  'g'
);

export function stripAnsi(text) {
  return text.replace(ANSI_PATTERN, '');
}

export function rotateIfTooLarge(logPath, maxBytes = MAX_LOG_BYTES) {
  try {
    if (statSync(logPath).size < maxBytes) return false;
    renameSync(logPath, `${logPath}.old`);
    return true;
  } catch {
    // 初回（ファイル無し）や rename 失敗はそのまま追記する。記録を残すことが最優先。
    return false;
  }
}

export function buildChildEnv(env = process.env) {
  if (env.NO_COLOR || env.FORCE_COLOR) return { ...env };
  return { ...env, FORCE_COLOR: '1' };
}

export function formatSessionHeader(command, now = new Date(), pid = process.pid) {
  return `\n==== ${now.toISOString()} [dev-start] pid=${pid} node=${process.version}\n$ ${command}\n`;
}

export function formatSessionFooter(code, signal, now = new Date()) {
  return `==== ${now.toISOString()} [dev-exit] ${signal ? `signal=${signal}` : `code=${code ?? 0}`}\n`;
}

/**
 * コマンドを実行し、出力を端末とログファイルの両方へ流す。
 *
 * NOTE: プロセスを終わらせる責務はここに持たせない（テストから呼ぶと vitest ごと落ちる）。
 * 終了コードの引き継ぎは onClose 経由で呼び出し側に任せる。
 */
export function runWithTerminalLog(argv, logPath = DEV_TERMINAL_LOG_PATH, onClose = null) {
  const command = argv.join(' ');

  let fd = null;
  try {
    mkdirSync(path.dirname(logPath), { recursive: true });
    rotateIfTooLarge(logPath);
    fd = openSync(logPath, 'a');
  } catch (err) {
    console.error(
      `[ChapterFlow] ターミナル記録を開けませんでした（記録なしで続行します）: ${err.message}`
    );
  }

  // NOTE: createWriteStream だとユーザー空間にバッファが残り、強制終了で消える。
  // 「殺されても直前の出力が残る」ことが目的なので、必ず fd へ都度 writeSync する。
  const record = (text) => {
    if (fd === null || text === '') return;
    try {
      writeSync(fd, stripAnsi(text));
    } catch {
      fd = null; // 以降は端末表示だけ続ける
    }
  };
  const closeLog = () => {
    if (fd === null) return;
    try {
      closeSync(fd);
    } catch {
      // 閉じられなくても終了は妨げない
    }
    fd = null;
  };

  record(formatSessionHeader(command));
  if (fd !== null) console.log(`[ChapterFlow] このターミナルの記録: ${logPath}`);

  // NOTE: shell:true に args 配列を渡すと Node 22 以降 DEP0190 の警告が毎回出る。
  // 起動コマンドは package.json 由来の固定文字列なので、そのまま1本の文字列で渡す。
  const child = spawn(command, {
    shell: true,
    stdio: ['inherit', 'pipe', 'pipe'],
    // NOTE: stdout をパイプすると concurrently や vite は TTY でないと判断して色を消す。
    // 端末の見た目は今までどおりにしたいので明示的に色を維持させる（ファイルへは stripAnsi 済み）。
    // ただし NO_COLOR が立っているときに FORCE_COLOR を足すと Node が競合を警告するので触らない。
    env: buildChildEnv(process.env),
  });

  // NOTE: チャンク境界がマルチバイト文字の途中に落ちると記録が文字化けするため、
  // ストリームごとに StringDecoder を持たせて繰り越す。
  const pipe = (source, sink) => {
    const decoder = new StringDecoder('utf8');
    source.on('data', (chunk) => {
      sink.write(chunk);
      record(decoder.write(chunk));
    });
    source.on('end', () => record(decoder.end()));
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);

  child.on('error', (err) => {
    record(`[dev-terminal-log] 起動に失敗しました: ${err.message}\n`);
    console.error(`[ChapterFlow] コマンドを起動できませんでした: ${command}`);
    console.error(err);
    closeLog();
    onClose?.(1, null);
  });

  // NOTE: 'exit' ではなく 'close'。stdout/stderr を読み切ってから終了記録を書く。
  child.on('close', (code, signal) => {
    record(formatSessionFooter(code, signal));
    closeLog();
    onClose?.(code, signal);
  });

  return child;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    console.error('usage: node scripts/dev-terminal-log.mjs <command> [args...]');
    process.exit(2);
  }

  // NOTE: Ctrl+C は cmd がコンソール全体へ配るので子にも届く。既定動作のまま即 exit すると
  // 終了記録が残らないので、受け取るだけにして子の終了を待つ。
  const ignoreSignal = () => {};
  process.on('SIGINT', ignoreSignal);
  process.on('SIGTERM', ignoreSignal);

  runWithTerminalLog(argv, DEV_TERMINAL_LOG_PATH, (code, signal) => {
    if (signal) {
      process.off('SIGINT', ignoreSignal);
      process.off('SIGTERM', ignoreSignal);
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}
