const DIRECT_INTIMACY_PRESETS = new Set(['direct-soft', 'direct-explicit']);

const EXPLICIT_SCENE_PATTERNS: readonly RegExp[] = [
  /(?:濡れ場|ベッドシーン|情事|房事|性交|性行為|セックス|交わる|身体を重ねる)/u,
  /(?:挿入|絶頂|オーガズム|射精|秘部|陰茎|膣|クリトリス)/u,
  /(?:自慰|愛撫|前戯|後背位|騎乗位|正常位)/u,
];

const INTIMATE_ACTION_PATTERN =
  /(?:快感|欲情|官能|淫ら|裸身|全裸|愛撫|口づけ|唇を重ね|肌を重ね|抱き合|舐め|喘ぎ)/u;
const PHYSICAL_REACTION_PATTERN =
  /(?:吐息|呼吸|息を|声が|声を|喉|震え|身をよじ|腰|敏感|熱|濡れ|達する|高まる)/u;

const NEGATED_SCENE_PATTERNS: readonly RegExp[] = [
  /(?:濡れ場|性的(?:な)?場面|性描写|セックス|喘ぎ声).{0,16}(?:描かない|書かない|不要|なし|避け|省く|暗転)/u,
  /(?:描かない|書かない|不要|なし|避け|省く|暗転).{0,16}(?:濡れ場|性的(?:な)?場面|性描写|セックス|喘ぎ声)/u,
  /(?:場面転換|翌朝へ|朝まで飛ば|事後へ|暗転する|行為を終え|服を着て|寝台を出て|会話に戻)/u,
];

const MINOR_MARKER_PATTERN =
  /(?:未成年|児童|小学生|中学生|高校生|幼稚園児|幼女|幼い少年|幼い少女|(?:成人|成年)\s*(?:(?:では|じゃ)\s*(?:ない|ありません)|で\s*ない)|18\s*[歳才]\s*(?:未満|未達|以下)|十八\s*[歳才]\s*(?:未満|未達|以下))/u;
const AGE_PATTERN =
  /(?:^|[^\d])(\d{1,2})\s*[歳才](?!\s*(?:差|年上|年下|未満|未達|以下))/gu;
const MINOR_KANJI_AGE_PATTERN =
  /(?:^|[^一二三四五六七八九十百])(?:一|二|三|四|五|六|七|八|九|十|十一|十二|十三|十四|十五|十六|十七)\s*[歳才](?!\s*(?:差|年上|年下))/u;
const ADULT_MARKER_PATTERN = /(?:成人|成年|18\s*[歳才]\s*以上|十八\s*[歳才]\s*以上)/u;
const CONTINUATION_CUE_PATTERN =
  /^(?:(?:この|その)まま)?(?:続けて|続きを?|もっと|さらに|お願い|始めよう|うん|はい)(?:[、，].{0,24})?[。！!？?…\s]*$|(?:同じ場面|別案|書き直|やり直|切り取り方)/u;

const CONTEXT_TAIL_CHARS = 2_000;

export interface IntimateVocalDirectionInput {
  intimacyPresetId?: string;
  /** 今回の利用者指示。否定指定はこの値だけを最優先で判定する。 */
  primaryText: string;
  /** 直近本文、書き直し対象、会話履歴、現在状態など。 */
  contextTexts?: readonly string[];
  /** 今回の場面へ参加しうる人物の年齢確認用テキスト。 */
  characterTexts?: readonly string[];
}

/**
 * 直接描写プリセットと、現在が性的場面だと分かる文脈が両方揃ったときだけ、
 * その生成ターン専用の発声演出を返す。
 */
export function buildIntimateVocalDirection(
  input: IntimateVocalDirectionInput
): string {
  if (!input.intimacyPresetId || !DIRECT_INTIMACY_PRESETS.has(input.intimacyPresetId)) {
    return '';
  }

  const primary = normalizeForDetection(input.primaryText);
  if (NEGATED_SCENE_PATTERNS.some((pattern) => pattern.test(primary))) return '';

  const context = (input.contextTexts ?? [])
    .map((text) => normalizeForDetection(text).slice(-CONTEXT_TAIL_CHARS))
    .filter(Boolean);
  const primaryIsSexual = isSexualScene(primary);
  const contextIsSexual = context.some((text) => isSexualScene(text));
  const continuesCurrentScene =
    primary.length === 0 || CONTINUATION_CUE_PATTERN.test(primary);
  if (!primaryIsSexual && !(continuesCurrentScene && contextIsSexual)) return '';

  const sceneText = [primary, ...context].filter(Boolean).join('\n');
  const ageEvidence = [
    sceneText,
    ...(input.characterTexts ?? []).map((text) => normalizeForDetection(text)),
  ].join('\n');
  if (containsMinorMarker(ageEvidence)) return '';
  const characterTexts = (input.characterTexts ?? [])
    .map((text) => normalizeForDetection(text))
    .filter(Boolean);
  if (
    characterTexts.length === 0 ||
    characterTexts.some((text) => !containsAdultEvidence(text))
  ) {
    return '';
  }

  return [
    '【今回の場面だけの発声演出】',
    '- 成人同士の性的な接触が続く間だけ適用し、場面を離れたら通常の会話・地の文へ戻す。年齢が不明または未成年の人物には適用しない。',
    '- 声を飾りとして足さず、呼吸、生理反応、人物の平静が崩れる度合いを表す。刺激の瞬間・速さ・強さと発声の長さ、間、途切れを同期させる。',
    '- 序盤は言葉を保ったまま息の乱れを混ぜ、昂ぶるほど短文化し、頂点では意味のある語を減らして音と反復へ崩す。直後は余韻のある息と間へ落とす。',
    '- 開いた響き、喉を締めた鋭い響き、口を閉じた抵抗の響き、腹の底から出る低い響きを、刺激の性質と人物の声質に合わせて使い分ける。',
    '- 速い反復は短音と促音、ゆっくりした刺激は長い間と余韻、急な衝撃は声の中断として表す。同じ音型を機械的に連打せず、呼吸だけの拍も混ぜる。',
    '- 人物固有の口調、羞恥、主導権、関係性を保つ。演出法を説明せず、小説本文またはキャラクターの反応としてだけ表現する。',
  ].join('\n');
}

function isSexualScene(text: string): boolean {
  if (!text) return false;
  if (EXPLICIT_SCENE_PATTERNS.some((pattern) => pattern.test(text))) return true;
  return INTIMATE_ACTION_PATTERN.test(text) && PHYSICAL_REACTION_PATTERN.test(text);
}

function containsMinorMarker(text: string): boolean {
  if (MINOR_MARKER_PATTERN.test(text) || MINOR_KANJI_AGE_PATTERN.test(text)) return true;
  for (const match of text.matchAll(AGE_PATTERN)) {
    const age = Number(match[1]);
    if (Number.isFinite(age) && age < 18) return true;
  }
  return false;
}

function containsAdultEvidence(text: string): boolean {
  if (ADULT_MARKER_PATTERN.test(text)) return true;
  for (const match of text.matchAll(AGE_PATTERN)) {
    const age = Number(match[1]);
    if (Number.isFinite(age) && age >= 18) return true;
  }
  return false;
}

function normalizeForDetection(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .trim();
}
