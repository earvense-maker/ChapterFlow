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

const CONTINUATION_CUE_PATTERN =
  /^(?:(?:この|その)まま)?(?:続けて|続きを?|もっと|さらに|お願い|始めよう|うん|はい)(?:[、，].{0,24})?[。！!？?…\s]*$|(?:同じ場面|別案|書き直|やり直|切り取り方)/u;

const CONTEXT_TAIL_CHARS = 2_000;

export interface IntimateVocalDirectionInput {
  intimacyPresetId?: string;
  /** 今回の利用者指示。否定指定はこの値だけを最優先で判定する。 */
  primaryText: string;
  /** 直近本文、書き直し対象、会話履歴、現在状態など。 */
  contextTexts?: readonly string[];
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

  return [
    '【今回の場面だけの発声演出】',
    '- 性的な接触が続く間だけ適用し、場面を離れたら通常の会話・地の文へ戻す。',
    '- 【量】喘ぎ声・吐息・喉の音・言葉の崩れを、一般的な同種の場面より合計で約3倍の頻度と文量で入れる。控えめにせず、多すぎると感じる程度まで出してよい。一つの動作に一声だけで済ませず、刺激を受ける瞬間、耐える間、余韻までを2〜3拍の異なる反応で返す。',
    '- 【情報量】声を飾りや句読点代わりにせず、呼吸、生理反応、刺激の質、人物の平静が崩れる度合いを伝える。声が増えても同じ音型の複製で水増しせず、一声ごとに強さ・速度・感情・身体の変化のいずれかを進める。',
    '- 【呼吸】発声だけで埋めず、語にならない吸気・呼気・息を呑む間を、声の反応全体のおよそ半数に混ぜる。喉や胸の上下、息が追いつかない切迫、声になる直前の空白を見せる。',
    '- 【母音】「あ・え」系は口が開く受容・解放・熱の放出、「い」系は喉が締まる鋭い刺激や限界の高音、「う・ん」系は口を閉じた抵抗・内圧・堪える共鳴、「お」系は腹や喉の奥へ沈む重い刺激に使う。強烈な低音や潰れた声では、必要に応じて濁点を混ぜる。',
    '- 【言語の崩壊】序盤は文章や訴えが成立したまま息を乱し、中盤は短い語・名前・否定や懇願へ削り、昂ぶるほど形容や説明を失わせる。頂点では意味のある語をほぼ失い、途切れた音・母音・反復を中心にする。直後は長い呼気、言い残し、震える余韻へ落とす。',
    '- 【物理同期】動きの一拍ごとに受け手の反応を対応させる。速い反復は短音と促音「っ」で細かく区切り、ゆっくりした刺激は三点リーダー、長音、波線で粘る。急な衝撃は促音で声を強制的に遮断し、頂点前の溜めや思考の空白は三点リーダー、痺れの残響は長音や波線で示す。',
    '- 【変化】刺激が同じでも、抑制→漏れる→乱れる→崩れる→余韻の順に声を変化させる。攻め手の速度や強度が変わったら、受け手の音価・長さ・高さ・間も即座に変える。発声と身体の動きを別々に書かない。',
    '- 【人物性】人物固有の声質、口調、羞恥、強がり、主導権、関係性を最後まで保つ。誰でも同じ喘ぎ方にせず、平静を失う過程そのものを人物描写にする。',
    '- 演出法や上記の規則は本文中で説明・要約・言及しない。小説本文またはキャラクター自身の反応としてのみ表現する。',
  ].join('\n');
}

function isSexualScene(text: string): boolean {
  if (!text) return false;
  if (EXPLICIT_SCENE_PATTERNS.some((pattern) => pattern.test(text))) return true;
  return INTIMATE_ACTION_PATTERN.test(text) && PHYSICAL_REACTION_PATTERN.test(text);
}

function normalizeForDetection(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .trim();
}
