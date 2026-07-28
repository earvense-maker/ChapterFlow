// 公開Web版 Phase 0 のホスティング判定（設計書 5.2 / 13 Phase 0）。
//
// 本番同等のプロキシを通した長時間SSEが「完走するか」「バッファリングされないか」
// 「途中で切られないか」を実測する。ここを通らないホスティングは採用しない、という
// ゲートに使うためのものなので、判定結果は必ず数値で出す。
//
// 使い方:
//   CHAPTERFLOW_WEB_SSE_PROBE_TOKEN=xxx npm run sse:endurance -- --url https://example.com --seconds 600
//
// 判定:
//   exit 0  = 採用可。指定時間ぶん完走し、イベント間隔も許容内。
//   exit 1  = 不採用。早期切断・バッファリング・タイムアウトのいずれかを検出。

const DEFAULT_SECONDS = 600;
// NOTE: サーバーは1秒ごとに送る。プロキシがバッファリングすると数十秒ぶんが
// まとめて届くので、間隔の最大値がこの閾値を超えたらバッファリングとみなす。
const MAX_ACCEPTABLE_GAP_MS = 5000;

const options = parseArgs(process.argv.slice(2));
const token = process.env.CHAPTERFLOW_WEB_SSE_PROBE_TOKEN;

if (!options.url) {
  process.stderr.write('--url <検証先のオリジン> を指定してください\n');
  process.exit(2);
}
if (!token) {
  process.stderr.write('CHAPTERFLOW_WEB_SSE_PROBE_TOKEN を設定してください\n');
  process.exit(2);
}

const probeUrl = new URL('/api/_probe/sse', options.url);
probeUrl.searchParams.set('seconds', String(options.seconds));

const result = await runProbe(probeUrl, token, options.seconds);
report(result, options.seconds);
process.exit(verdict(result, options.seconds) ? 0 : 1);

async function runProbe(url, probeToken, seconds) {
  const startedAt = Date.now();
  const gaps = [];
  let lastEventAt = startedAt;
  let firstEventMs = null;
  let ticks = 0;
  let completed = false;
  let failure = null;

  // NOTE: クライアント側でも上限を持つ。プロキシが接続を握ったまま無応答になる
  // ケースで、スクリプトが永久に待ち続けないようにする。
  const abortController = new AbortController();
  const hardStop = setTimeout(() => abortController.abort(), (seconds + 60) * 1000);

  try {
    const response = await fetch(url, {
      headers: { accept: 'text/event-stream', 'x-probe-token': probeToken },
      signal: abortController.signal,
    });

    if (!response.ok) {
      return { failure: `HTTP ${response.status}`, ticks, gaps, firstEventMs, completed, elapsedMs: Date.now() - startedAt };
    }
    if (!response.body) {
      return { failure: 'レスポンスボディが空', ticks, gaps, firstEventMs, completed, elapsedMs: Date.now() - startedAt };
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) {
      return { failure: `content-type が SSE ではない: ${contentType}`, ticks, gaps, firstEventMs, completed, elapsedMs: Date.now() - startedAt };
    }

    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');

        const now = Date.now();
        if (block.includes('event: tick')) {
          ticks += 1;
          if (firstEventMs === null) firstEventMs = now - startedAt;
          gaps.push(now - lastEventAt);
          lastEventAt = now;
        }
        if (block.includes('event: done')) completed = true;
      }
    }
  } catch (err) {
    failure = err instanceof Error && err.name === 'AbortError' ? '応答なしでタイムアウト' : String(err);
  } finally {
    clearTimeout(hardStop);
  }

  return { failure, ticks, gaps, firstEventMs, completed, elapsedMs: Date.now() - startedAt };
}

function verdict(result, seconds) {
  if (result.failure) return false;
  if (!result.completed) return false;
  // NOTE: 1秒間隔なので、想定 tick 数の9割を下回るのは取りこぼしが多すぎる。
  if (result.ticks < seconds * 0.9) return false;
  return maxGap(result.gaps) <= MAX_ACCEPTABLE_GAP_MS;
}

function report(result, seconds) {
  const gapMax = maxGap(result.gaps);
  const lines = [
    '--- SSE 耐久検証 ---',
    `要求時間        : ${seconds}s`,
    `実測時間        : ${(result.elapsedMs / 1000).toFixed(1)}s`,
    `完了イベント    : ${result.completed ? 'あり' : 'なし（途中で切断）'}`,
    `受信 tick 数    : ${result.ticks} / 想定 ${seconds}`,
    `初回イベントまで: ${result.firstEventMs === null ? '受信なし' : `${result.firstEventMs}ms`}`,
    `最大イベント間隔: ${gapMax}ms（許容 ${MAX_ACCEPTABLE_GAP_MS}ms）`,
  ];
  if (result.failure) lines.push(`失敗            : ${result.failure}`);
  if (gapMax > MAX_ACCEPTABLE_GAP_MS) {
    lines.push('判定            : プロキシがバッファリングしている可能性が高い。');
  }
  if (!result.completed && !result.failure) {
    lines.push('判定            : 接続時間の上限で切られている。ジョブキューか非同期生成APIが要る。');
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

function maxGap(gaps) {
  return gaps.length === 0 ? 0 : Math.max(...gaps);
}

function parseArgs(argv) {
  const parsed = { url: null, seconds: DEFAULT_SECONDS };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--url') parsed.url = argv[i + 1];
    if (argv[i] === '--seconds') parsed.seconds = Number.parseInt(argv[i + 1], 10) || DEFAULT_SECONDS;
  }
  return parsed;
}
