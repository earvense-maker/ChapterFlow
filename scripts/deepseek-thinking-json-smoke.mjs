// AI相談 JSON 出力時の思考モード制御 設計書 §9 の実 API スモークテスト。
//
// DeepSeek のチャット補完 API へ、ChapterFlow の DeepSeek アダプタが送るのと
// 同じ組み合わせ（thinking enabled + reasoning_effort high + response_format
// json_object + max_tokens 40,000）が実際のエンドポイントで受理されるか、
// JSON として解析できて visibleReply が空にならないかを確認する。
//
// 使い方:
//   DEEPSEEK_API_KEY=sk-... npm run deepseek:smoke
//   DEEPSEEK_API_KEY=sk-... npm run deepseek:smoke -- --model deepseek-v4-flash
//
// 判定:
//   exit 0  = 設計書 §9 の API レベル確認を満たす。
//   exit 1  = HTTP 400 / 空応答 / JSON 不成立 / visibleReply 空 のいずれか。
//   exit 2  = 環境変数・引数の不備。
//
// NOTE: API キーが必要なため自動テスト（CI）には含めない。実装受け入れ時の
// 手動確認に使う。

const API_BASE = 'https://api.deepseek.com/chat/completions';
const DEFAULT_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro'];
const MAX_OUTPUT_TOKENS = 40_000;

const options = parseArgs(process.argv.slice(2));
const apiKey = process.env.DEEPSEEK_API_KEY;

if (!apiKey) {
  process.stderr.write('DEEPSEEK_API_KEY を設定してください\n');
  process.exit(2);
}

const models = options.model ? [options.model] : DEFAULT_MODELS;

const results = [];
for (const model of models) {
  results.push(await smokeModel(model, apiKey));
}

report(results);
process.exit(results.every((r) => r.ok) ? 0 : 1);

async function smokeModel(model, apiKey) {
  const body = {
    model,
    messages: [
      {
        role: 'system',
        content: '次の JSON スキーマだけを返してください。前後に解説を付けない。',
      },
      {
        role: 'user',
        content:
          'あなたは小説の設定相談相手です。返答は JSON で返してください。\n' +
          '{"visibleReply": "利用者へ見せる自然文", "turnIntent": "explore", ' +
          '"suggestedActions": [{"label": "短い見出し", "message": "押したとき送る文", ' +
          '"responseMode": "consult"}], "patches": []}\n' +
          '相談内容: 主人公の人物設定をどう固めるか、2案程度示してください。',
      },
    ],
    temperature: 0.55,
    max_tokens: MAX_OUTPUT_TOKENS,
    stream: false,
    // NOTE: 設計書 5.3 / 5.6 の送信値と同一。thinking と JSON 出力の同時指定が
    // HTTP 400 にならないことが本テストの主目的。
    thinking: { type: 'enabled' },
    reasoning_effort: 'high',
    response_format: { type: 'json_object' },
  };

  let response;
  try {
    response = await fetch(API_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { model, ok: false, step: 'network', detail: String(err) };
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    return {
      model,
      ok: false,
      step: `http-${response.status}`,
      detail: errorBody.slice(0, 400),
    };
  }

  const data = await response.json().catch(() => null);
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    const reasoning = data?.choices?.[0]?.message?.reasoning_content ?? '';
    return {
      model,
      ok: false,
      step: 'empty-content',
      detail: `content=空 reasoning_content=${reasoning.length}chars finish=${data?.choices?.[0]?.finish_reason ?? 'none'}`,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { model, ok: false, step: 'invalid-json', detail: content.slice(0, 200) };
  }

  const visibleReply = typeof parsed.visibleReply === 'string' ? parsed.visibleReply.trim() : '';
  if (visibleReply === '') {
    return { model, ok: false, step: 'empty-visible-reply', detail: content.slice(0, 200) };
  }

  return {
    model,
    ok: true,
    finishReason: data?.choices?.[0]?.finish_reason ?? 'none',
    visibleReplyChars: visibleReply.length,
    suggestedActions: Array.isArray(parsed.suggestedActions) ? parsed.suggestedActions.length : 0,
    usage: data?.usage
      ? {
          prompt: data.usage.prompt_tokens,
          completion: data.usage.completion_tokens,
          reasoning: data.usage.completion_tokens_details?.reasoning_tokens ?? null,
        }
      : null,
  };
}

function report(results) {
  const lines = ['--- DeepSeek JSON + thinking スモークテスト ---'];
  for (const r of results) {
    if (r.ok) {
      lines.push(
        `${r.model}: OK（finish=${r.finishReason} visibleReply=${r.visibleReplyChars}字 ` +
          `suggestedActions=${r.suggestedActions}${usageLine(r.usage)}）`
      );
    } else {
      lines.push(`${r.model}: NG（${r.step}）${r.detail}`);
    }
  }
  lines.push(results.every((r) => r.ok) ? '判定: 合格。JSON + thinking high の同時指定が受理されました。' : '判定: 不合格。設計書 §9 の確認を満たしません。');
  process.stdout.write(`${lines.join('\n')}\n`);
}

function usageLine(usage) {
  if (!usage) return '';
  return ` usage=${usage.prompt}+${usage.completion}（うち思考 ${usage.reasoning ?? '不明'}トークン）`;
}

function parseArgs(argv) {
  const parsed = { model: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--model') parsed.model = argv[i + 1] ?? null;
  }
  return parsed;
}
