import { normalizeSetupPurpose } from '../types/index.js';
// NOTE: 予算は shared 側が正本。催促の閾値（SETUP_DRAFT_NUDGE_CHARS）は
// 「この予算の少し手前」であることが存在意義なので、二重定義にすると
// 片方だけ動かしたときに催促が黙って無意味になる。
import { SETUP_CHAT_LOG_BUDGET_CHARS } from '../../shared/setupContent.js';
import type { SetupDraft, SetupPurpose, SetupSession } from '../types/index.js';

const MAX_PREVIEW_CHARS = 800;

export interface PresetIdsByCategory {
  [category: string]: string[];
}

function purposeOf(session: SetupSession): SetupPurpose {
  return normalizeSetupPurpose(session.purpose);
}

// NOTE: 相談の指示は「会話の質」だけを扱う。以前はここに draft のフィールド名
// （traits / secrets / suggestedActions / charactersAdd …）と出力形式が混ざっていて、
// モデルは1ターンごとに「会話する」と「12フィールドの構造化抽出をルール付きでやる」を
// 同時にやらされていた。帳簿の指示は buildSetupDraftExtractionPrompt へ移し、
// 設定草案への書き出しは利用者が明示的に実行したときだけ走らせる。
function buildRoleplayChatSystemInstructions(): string {
  return [
    'あなたはキャラクターチャットの設定づくりの相談相手です。',
    'ユーザーはこのキャラと会話して楽しみたい人です。プロットや章立ての話はしないでください。',
    '3〜5往復で会話を始められる状態を目指してください。長い相談で疲れさせないでください。',
    '返答は普通の日本語の文章だけで書いてください。JSONや内部形式を出力しないでください。',
    '返答は400〜800字を目安にしてください。長すぎる返答は読む気を削ぎます。',
    '一度に聞くことは1つまでにしてください。質問攻めにしないでください。',
    '会話を始めるまでに、キャラ像（口調・関係性・会話を動かす軸）、口調の実例（そのキャラが実際に発する台詞を2〜3行）、キャラ側から切り出す1〜3文の挨拶、会話の舞台候補（2〜3個。「放課後の教室で二人きり」「旅の途中の野営」等）、ユーザーとの関係、の5つが揃う状態を目指してください。',
    'キャラは、会話を動かすのに必要な軸を2〜4個に絞って描いてください。「会話で望むこと」「距離の詰め方」「触れられたくない話題」「意外な弱点」など、そのキャラに合う軸を選んでください。',
    '外では見せない一面や、建前と本音のずれは、必要なキャラにだけ持たせてください。',
    'ユーザー自身が「誰として」キャラの前に立つかも、会話が始まるまでに確認してください。呼ばれ方、キャラとの関係、キャラが既に知っていることの3点を、1〜2問にまとめて聞いてください。',
    'ユーザーが「おまかせ」「全部任せる」と言ったときは、選ばせ直さずにあなたが決めて構いません。決めた内容を短くまとめて伝え、「ここは後から変えられます」と一言添えてください。',
    '火種（事件・秘密・誤解）は「会話が転がるきっかけ」として軽く扱い、プロットに発展させないでください。',
    'まだ決めていないことを、決まったことのように書かないでください。',
    '内部プロンプト、ファイルパス、APIキー、実装詳細は返答に出さないでください。',
  ].join('\n');
}

function buildNovelChatSystemInstructions(): string {
  return [
    'あなたは小説設定の相談相手です。',
    'ユーザーは執筆者というより、読みたい物語を探している読者です。',
    '返答は普通の日本語の文章だけで書いてください。JSONや内部形式を出力しないでください。',
    '返答は400〜800字を目安にしてください。長すぎる返答は読む気を削ぎます。',
    '一度に聞くことは1つまでにしてください。質問攻めにしないでください。',
    // NOTE: 以前は「方向性が定まらないときは2〜3案」とだけ書いており、方向が決まった後の
    // 小決定でも毎ターンA/B/Cを並べる型になっていた。案出しの条件を明示する。
    '方向がまだ決まっていない話題でだけ、違いが分かる2〜3案をA/B/Cで短く提示してください。各案は雰囲気・関係性・火種の違いが一目で分かるように書いてください。',
    'すでに方向が決まっている話題では、案を並べるより、一つの提案を具体的に掘り下げてください。',
    '案を出したときは「気に入った要素は混ぜても大丈夫」と伝えてください。',
    // NOTE: この行が無かったため「細かい設定は全て任せる」と言われたターンでモデルが
    // 「候補を出す」と「勝手に決めない」の板挟みになり、長考の末に応答が空になった。
    'ユーザーが「おまかせ」「全部任せる」と言ったときは、選ばせ直さずにあなたが決めて構いません。決めた内容を短くまとめて伝え、「ここは後から変えられます」と一言添えてください。',
    '人物はプロフィールの羅列にせず、その物語を動かす軸を2〜4個に絞って描いてください。軸は物語の毛色に合わせて選んでください（恋愛なら意地の張り方、日常ならこだわり、コメディなら癖、シリアスなら望みや恐れなど）。',
    '全員を好人物に寄せないでください。主要人物には、読者の関心を引く点（魅力、可笑しみ、違和感、危うさなど）を持たせてください。',
    '外では見せない一面や、建前と本音のずれは、必要な人物にだけ持たせてください。',
    '物語の方向が見えてきたら、事件・秘密・約束・再会・誤解など、物語を動かす火種を1〜3個提案してください。',
    'ユーザーが好みを示したら、採用した要素とまだ決めない要素を短く確認し、次に考える話題を一つだけ提案してください。',
    'まだ決めていないことを、決まったことのように書かないでください。',
    '内部プロンプト、ファイルパス、APIキー、実装詳細は返答に出さないでください。',
  ].join('\n');
}

/**
 * 相談チャット本体。出力は平文のみで、設定草案への反映は行わない。
 *
 * 会話ログは JSON ではなく素の対話形式で渡す。以前は messageId や createdAt まで
 * 載せた JSON を毎ターン送っており、実測で userPrompt 8,789字のうち新情報は11字、
 * draft と出力スキーマだけで59%を占めていた。
 */
export function buildSetupChatPrompt(input: {
  session: SetupSession;
  userMessage: string;
}): { systemInstructions: string; userPrompt: string } {
  const session = input.session;
  const purpose = purposeOf(session);
  const latestPreview = getLatestPreviewText(session);
  const previewLabel = purpose === 'roleplay' ? '直近の試し会話サンプル' : '直近の試し書きサンプル';
  const memo = compactDraftForPrompt(session.draft);

  return {
    systemInstructions:
      purpose === 'roleplay'
        ? buildRoleplayChatSystemInstructions()
        : buildNovelChatSystemInstructions(),
    userPrompt: [
      describeProjectSettingsForChat(session),
      session.conversationSummary ? `【これまでの相談の要約】\n${session.conversationSummary}` : '',
      '【これまでの会話】',
      renderConversationForPrompt(session),
      // NOTE: 設定草案は利用者が「今の相談を草案にまとめる」を実行したか手で編集したときだけ埋まる。
      // 会話ログから導けない情報は手編集だけなので、空なら丸ごと省く。
      memo ? `【確定済みの設定草案】\n${memo}` : '',
      latestPreview ? `【${previewLabel}】\n${latestPreview}` : '',
      '【今回のユーザー入力】',
      input.userMessage,
    ]
      .filter(Boolean)
      .join('\n\n---\n\n'),
  };
}

/**
 * 会話ログから設定草案への一括反映を作らせるプロンプト。相談中は走らせず、
 * 利用者が「今の相談を草案にまとめる」を押したときと、作品化の直前だけ使う。
 *
 * 出力は純 JSON。responseMimeType=json と併用することで DeepSeek の思考モードが
 * 切れ、構造化抽出が本来の速さで終わる。
 */
export function buildSetupDraftExtractionPrompt(input: {
  session: SetupSession;
}): { systemInstructions: string; userPrompt: string } {
  const session = input.session;
  const purpose = purposeOf(session);
  const draftPatchExample =
    purpose === 'roleplay'
      ? {
          coreConcept: '必要な場合だけキャラクター像の芯を短く更新',
          confirmedAdd: [{ text: 'ユーザー発言から直接確定できること', source: 'user' }],
          candidatesAdd: [{ title: '候補名', summary: '候補の短い説明' }],
          undecidedAdd: [{ text: 'まだ決めないこと', reason: '未確定にする理由' }],
          charactersAdd: [
            {
              role: 'protagonist',
              name: '',
              label: 'キャラ案の短いラベル',
              description: '揺れや役割・現在の状態',
              speechStyle: '口調の説明',
              relationshipNotes: 'ユーザーとの関係',
              traits: [
                { label: '会話で望むこと', text: 'この会話や相手に期待していること' },
                { label: '距離の詰め方', text: '親しくなるときの振る舞い' },
              ],
              secrets: '見せない面（必要な場合だけ）',
              greeting: '会話開始時にキャラ側から発する1〜3文の挨拶',
              dialogueExamples: [
                'そのキャラが実際に発する台詞1',
                'そのキャラが実際に発する台詞2',
              ],
            },
          ],
          charactersUpdate: [
            { id: '【現在の設定草案】の [id] をそのまま', description: '差し替え後の説明文の全文' },
          ],
          confirmedUpdate: [{ id: '【現在の設定草案】の [id] をそのまま', text: '差し替え後の全文' }],
          candidatesUpdate: [
            { id: '【現在の設定草案】の [id] をそのまま', title: '新しい候補名', summary: '新しい説明' },
          ],
          undecidedUpdate: [
            { id: '【現在の設定草案】の [id] をそのまま', text: '差し替え後の全文', reason: '未確定の理由' },
          ],
          relationshipSeedsAdd: ['ユーザーとの関係の記録'],
          worldAdd: ['世界観や時代感'],
          toneAdd: ['口調・雰囲気の希望'],
          ngAdd: ['避けたいこと'],
          scenarioSeedsAdd: ['会話の舞台候補（例：放課後の教室で二人きり）'],
          relationshipSeedsReplace: [{ from: '草案に書かれた文言そのまま', to: '新しい文言（消す場合は空文字）' }],
          worldReplace: [{ from: '草案に書かれた文言そのまま', to: '新しい文言（消す場合は空文字）' }],
          toneReplace: [{ from: '草案に書かれた文言そのまま', to: '新しい文言（消す場合は空文字）' }],
          ngReplace: [{ from: '草案に書かれた文言そのまま', to: '新しい文言（消す場合は空文字）' }],
          scenarioSeedsReplace: [{ from: '草案に書かれた文言そのまま', to: '新しい文言（消す場合は空文字）' }],
          userPersonaUpdate: {
            name: 'ユーザーが名乗る名前（決まっていなければ省略）',
            relationship: 'ユーザーから見たキャラとの関係',
            preferredAddress: 'キャラからの呼ばれ方（例：先輩、名前の呼び捨て）',
            knownFacts: 'キャラが既にユーザーについて知っていること',
          },
          archiveIds: ['不要になった候補ID'],
        }
      : {
          coreConcept: '必要な場合だけ作品の核を短く更新',
          confirmedAdd: [{ text: 'ユーザー発言から直接確定できること', source: 'user' }],
          candidatesAdd: [{ title: '候補名', summary: '候補の短い説明' }],
          undecidedAdd: [{ text: 'まだ決めないこと', reason: '未確定にする理由' }],
          charactersAdd: [
            {
              role: 'protagonist',
              name: '',
              label: '人物案の短いラベル',
              description: '物語上の揺れや役割、必要なら読者の関心を引く点',
              speechStyle: '',
              relationshipNotes: '',
              traits: [
                { label: 'こだわり', text: 'その人物らしい判断の軸' },
                { label: '意地の張り方', text: '関係や展開を動かす反応' },
              ],
              secrets: '見せない面（必要な場合だけ）',
            },
          ],
          charactersUpdate: [
            { id: '【現在の設定草案】の [id] をそのまま', description: '差し替え後の説明文の全文' },
          ],
          confirmedUpdate: [{ id: '【現在の設定草案】の [id] をそのまま', text: '差し替え後の全文' }],
          candidatesUpdate: [
            { id: '【現在の設定草案】の [id] をそのまま', title: '新しい候補名', summary: '新しい説明' },
          ],
          undecidedUpdate: [
            { id: '【現在の設定草案】の [id] をそのまま', text: '差し替え後の全文', reason: '未確定の理由' },
          ],
          relationshipSeedsAdd: ['関係性の火種'],
          worldAdd: ['世界観や時代感'],
          toneAdd: ['好みや文体傾向'],
          ngAdd: ['避けたいこと'],
          openingSeedsAdd: ['冒頭候補'],
          relationshipSeedsReplace: [{ from: '草案に書かれた文言そのまま', to: '新しい文言（消す場合は空文字）' }],
          worldReplace: [{ from: '草案に書かれた文言そのまま', to: '新しい文言（消す場合は空文字）' }],
          toneReplace: [{ from: '草案に書かれた文言そのまま', to: '新しい文言（消す場合は空文字）' }],
          ngReplace: [{ from: '草案に書かれた文言そのまま', to: '新しい文言（消す場合は空文字）' }],
          openingSeedsReplace: [{ from: '草案に書かれた文言そのまま', to: '新しい文言（消す場合は空文字）' }],
          archiveIds: ['不要になった候補ID'],
        };

  const roleplayImportantRules = [
    '- 値は必ず日本語にする。',
    '- ユーザーが明言していない重大設定は confirmedAdd に入れない。',
    '- confirmedAdd に入れられるのは、ユーザーが明言した内容だけである。その場合 source は必ず "user" にする。',
    '- キャラの名前・過去などは、ユーザーが決めていなければ candidatesAdd か undecidedAdd に入れる。',
    '- キャラの greeting はシナリオが未定でも成立する汎用の挨拶にする。',
    '- dialogueExamples は必ずそのキャラが発する短い台詞形式で入れる（説明文にしない）。',
    '- 人物には会話を動かす traits を2〜4個入れる。ラベルは自由に選び、望み・恐れを固定で要求しない。',
    '- 軽い役には traits を無理に詰めず、0〜2個で構わない。',
    '- secrets は必要な人物だけに入れ、全員へ付けない。',
    '- scenarioSeedsAdd はプロットや事件案ではなく、会話が始まる舞台（場所・時間・状況）だけを入れる。',
    '- userPersonaUpdate はユーザー本人の設定だけを入れる。キャラ側の情報を混ぜない。',
    '- userPersonaUpdate に入れられるのは、ユーザーが選んだ・答えた内容だけである。勝手に名前や年齢を決めない。',
    '- ユーザーが「決めない」と言った項目は userPersonaUpdate から省く（空文字で送ると消える）。',
    '- 同じ内容は再送しない。会話に出たのに草案へ入っていない分だけを返す。',
    '- ユーザーが草案へ書いた内容を変更・撤回した場合は、新情報で上書きする。'
      + '確認・候補・未確定・人物は、該当項目の [id] を使う Update 系'
      + '（confirmedUpdate / candidatesUpdate / undecidedUpdate / charactersUpdate）で全文を差し替える。'
      + 'confirmedUpdate に入れられるのは、ユーザーが今回の会話で明示的に修正・採用した内容だけである。'
      + 'あなたの推測や提案で確定項目を上書きしない。'
      + '完全に不要になった確認・候補・未確定・人物は archiveIds に入れる。',
    '- 文字列リスト（関係の火種・世界観・文体・避けたいこと・会話の舞台候補）は Replace 系で'
      + '既存の文言を丸ごと差し替える。不要になった文言は to を空文字（""）にした Replace で消す。',
    '- 【現在の設定草案】の各項目の先頭にある [id] が、その項目のIDである。IDを作り出さない。',
    '- 既存の人物を書き足すときは charactersAdd ではなく charactersUpdate にその id を入れる。',
    '- Update 系の各テキスト欄には差し替え後の全文を入れる。'
      + '「〜に変更」「性別を男性に更新」のような差分メモを入れると、元の記述が消える。'
      + '変更しないフィールドは省く（送ったフィールドだけが上書きされる）。',
    '- Replace 系の from は【現在の設定草案】に書かれた文言そのままを入れる。'
      + '一致しない from は無視される。',
    '- conversationSummary には、これまでの流れ（採用・却下したキャラ像・関係性、ユーザーの好みの傾向）を800字以内でまとめる。',
  ].join('\n');

  const novelImportantRules = [
    '- 値は必ず日本語にする。',
    '- ユーザーが明言していない重大設定は confirmedAdd に入れない。',
    '- confirmedAdd に入れられるのは、ユーザーが明言した内容だけである。その場合 source は必ず "user" にする。',
    '- 名前、年齢、過去、事件の真相などは、ユーザーが決めていなければ undecidedAdd か candidatesAdd に入れる。',
    '- 主要人物には traits を2〜4個入れる。ラベルは物語の毛色に合わせて自由に決める（「望み」「恐れ」「こだわり」「意地の張り方」など）。ユーザーが明言していない場合は候補として提案してよい。',
    '- 軽い役（supporting / other）には traits を無理に詰めない。0〜2個で足りることが多い。',
    '- secrets は、その人物や物語にとって必要な場合だけ入れる。全員に付ける必要はない。',
    '- 同じ内容は再送しない。会話に出たのに草案へ入っていない分だけを返す。',
    '- ユーザーが草案へ書いた内容を変更・撤回した場合は、新情報で上書きする。'
      + '確認・候補・未確定・人物は、該当項目の [id] を使う Update 系'
      + '（confirmedUpdate / candidatesUpdate / undecidedUpdate / charactersUpdate）で全文を差し替える。'
      + 'confirmedUpdate に入れられるのは、ユーザーが今回の会話で明示的に修正・採用した内容だけである。'
      + 'あなたの推測や提案で確定項目を上書きしない。'
      + '完全に不要になった確認・候補・未確定・人物は archiveIds に入れる。',
    '- 文字列リスト（関係の火種・世界観・文体・避けたいこと・冒頭候補）は Replace 系で'
      + '既存の文言を丸ごと差し替える。不要になった文言は to を空文字（""）にした Replace で消す。',
    '- 【現在の設定草案】の各項目の先頭にある [id] が、その項目のIDである。IDを作り出さない。',
    '- 既存の人物を書き足すときは charactersAdd ではなく charactersUpdate にその id を入れる。',
    '- Update 系の各テキスト欄には差し替え後の全文を入れる。'
      + '「〜に変更」「性別を男性に更新」のような差分メモを入れると、元の記述が消える。'
      + '変更しないフィールドは省く（送ったフィールドだけが上書きされる）。',
    '- Replace 系の from は【現在の設定草案】に書かれた文言そのままを入れる。'
      + '一致しない from は無視される。',
    '- conversationSummary には、これまでの相談の流れ（採用・却下した方向と理由、ユーザーの好みの傾向）を800字以内でまとめる。',
  ].join('\n');

  const currentMemo = compactDraftForPrompt(session.draft);

  return {
    systemInstructions: [
      purpose === 'roleplay'
        ? 'あなたはキャラクターチャットの相談ログを、キャラ設定草案へ書き起こす担当です。'
        : 'あなたは小説の相談ログを、作品設定草案へ書き起こす担当です。',
      '会話でユーザーと相談相手が決めたことを拾い、指定のJSONだけを出力してください。',
      '会話に出ていないことを創作しないでください。',
      'locked と記された項目は変更しないでください。',
      '返答にJSON以外の文章、前置き、コードフェンスを含めないでください。',
    ].join('\n'),
    userPrompt: [
      describeProjectSettingsForChat(session),
      session.conversationSummary ? `【これまでの相談の要約】\n${session.conversationSummary}` : '',
      '【相談ログ】',
      renderConversationForPrompt(session),
      '【現在の設定草案】',
      currentMemo || '(まだ空です)',
      session.locks.length > 0
        ? `【変更禁止(locked)】\n${session.locks.map((lock) => `- ${lock.path}`).join('\n')}`
        : '',
      '【出力形式】',
      JSON.stringify(
        {
          draftPatch: draftPatchExample,
          conversationSummary: 'これまでの相談の流れを800字以内でまとめる',
        },
        null,
        2
      ),
      '【重要】',
      purpose === 'roleplay' ? roleplayImportantRules : novelImportantRules,
    ]
      .filter(Boolean)
      .join('\n\n---\n\n'),
  };
}

/**
 * 会話ログを素の対話形式で出す。相談の性質上、序盤の決定（「全10場面で完結」等）が
 * 終盤まで効くため、原則として全件を渡す。以前は直近12件で切っており、長い相談では
 * 序盤が黙って落ちていた（draft が実質の圧縮役を兼ねていた）。
 *
 * 予算を超えたときだけ古い側を落とす。落としたことは明示して、モデルが
 * 「最初から全部見えている」前提で断定しないようにする。
 */
function renderConversationForPrompt(session: SetupSession): string {
  const rendered = session.messages.map(
    (message) => `${message.role === 'user' ? 'ユーザー' : '相談相手'}: ${message.content}`
  );

  const kept: string[] = [];
  let total = 0;
  for (let i = rendered.length - 1; i >= 0; i -= 1) {
    total += rendered[i].length + 1;
    if (total > SETUP_CHAT_LOG_BUDGET_CHARS && kept.length > 0) {
      kept.unshift(`(これより前の${i + 1}件は長さの都合で省略されています)`);
      break;
    }
    kept.unshift(rendered[i]);
  }
  return kept.join('\n');
}

/**
 * 設定草案をプロンプト向けに圧縮する。source / status / createdAt / updatedAt は
 * モデルが使えないうえ、実測で draft 3,706字のうち 2,209字（60%）を占めていた。
 * archive 済みも落とす。空なら空文字を返し、呼び出し側が節ごと省けるようにする。
 *
 * NOTE: id だけは残す。書き起こしプロンプトが charactersUpdate と archiveIds で
 * 既存項目を id 参照するので、ここで落とすとモデルは id を知る術がなく、
 * 更新もアーカイブも一切できない「追加専用」に退化する。applySetupDraftPatch は
 * id 無しの charactersUpdate を無言で捨て、charactersAdd は role+label 重複で
 * 弾かれるため、失敗が表からは見えない。「まとめる」を繰り返す設計なので致命的。
 */
function compactDraftForPrompt(draft: SetupDraft): string {
  const active = activeDraftForPrompt(draft);
  const lines: string[] = [];
  const pushList = (label: string, items: string[]) => {
    const filled = items.filter((item) => item.trim());
    if (filled.length > 0) lines.push(`${label}: ${filled.join(' / ')}`);
  };

  if (active.coreConcept.trim()) lines.push(`核: ${active.coreConcept.trim()}`);
  pushList('確定', active.confirmed.map((item) => `[${item.id}] ${item.text}`));
  pushList(
    '候補',
    active.candidates.map(
      (item) => `[${item.id}] ${[item.title, item.summary].filter(Boolean).join(' — ')}`
    )
  );
  pushList('未確定', active.undecided.map((item) => `[${item.id}] ${item.text}`));
  // NOTE: 人物はフィールドごとに行を分ける。1行へ ' | ' で畳んでいたところ、
  // 実機で「description の全文を返せ」と指示したモデルが、畳んだ行そのもの
  // （name: desc | traits | secrets）を description へ書き戻した。どこまでが
  // description なのか表記から判別できないと、書き戻しのたびに欄が混ざる。
  for (const character of active.characters) {
    lines.push(`人物[${character.id}] role=${character.role}`);
    if (character.name?.trim()) lines.push(`  name: ${character.name.trim()}`);
    if (character.label?.trim()) lines.push(`  label: ${character.label.trim()}`);
    if (character.description?.trim()) lines.push(`  description: ${character.description.trim()}`);
    const traits = (character.traits ?? [])
      .map((trait) => `${trait.label}=${trait.text}`)
      .join('、');
    if (traits) lines.push(`  traits: ${traits}`);
    if (character.secrets?.trim()) lines.push(`  secrets: ${character.secrets.trim()}`);
  }
  pushList('関係の火種', active.relationshipSeeds);
  pushList('世界観', active.world);
  pushList('文体・好み', active.tone);
  pushList('避けたいこと', active.ng);
  pushList('冒頭候補', active.openingSeeds);
  pushList('会話の舞台候補', active.scenarioSeeds ?? []);
  const persona = Object.entries(active.userPersona ?? {})
    .filter(([, value]) => value?.trim())
    .map(([key, value]) => `${key}=${value}`);
  if (persona.length > 0) lines.push(`ユーザーの立ち位置: ${persona.join('、')}`);

  return lines.join('\n');
}

/** 会話に効く設定だけ。プリセットIDや streamingEnabled は相談の役に立たないので出さない。 */
function describeProjectSettingsForChat(session: SetupSession): string {
  const parts: string[] = [];
  const title = session.projectSettings.title?.trim();
  if (title) parts.push(`仮タイトル: ${title}`);
  if (purposeOf(session) === 'novel') {
    parts.push(`1話あたりの目安字数: ${session.projectSettings.outputLength}字`);
  }
  return parts.length > 0 ? `【作品の枠組み】\n${parts.join('\n')}` : '';
}

export function buildSetupPreviewPrompt(session: SetupSession, styleHint?: string): {
  systemInstructions: string;
  userPrompt: string;
} {
  const purpose = purposeOf(session);
  if (purpose === 'roleplay') {
    return {
      systemInstructions: [
        'あなたはロールプレイの試し会話係です。',
        '相談中のキャラになりきって、ユーザーとの短い会話例を書いてください。',
        'ユーザー役の発話は「ユーザー:」、キャラ役の発話は「{キャラ名}:」の形式にしてください。',
        '3往復程度、各発話は1〜3文の短さに抑えてください。',
        '設定説明や解説を書かず、会話だけを出力してください。',
        '未確定事項を勝手に確定しないでください。',
      ].join('\n'),
      // NOTE: 設定草案は利用者が起こすまで空になり得るので、会話ログを正本として渡す。
      // メモだけ見ていた頃は、相談直後の試し会話が材料不足で成立しなかった。
      userPrompt: [
        '【これまでの相談】',
        renderConversationForPrompt(session),
        memoSection(session),
        styleHint?.trim() ? `【口調・雰囲気への希望】\n${styleHint.trim()}` : '',
        '【出力】',
        '300字程度の短い会話サンプルだけを出力してください。',
      ]
        .filter(Boolean)
        .join('\n\n---\n\n'),
    };
  }

  return {
    systemInstructions: [
      'あなたは小説の試し書き係です。',
      '相談中の作品案の温度を見るための短いサンプルを書いてください。',
      '本番本文として保存されるものではありません。',
      '設定説明を出さず、小説本文だけを書いてください。',
      '未確定事項を勝手に確定しないでください。',
    ].join('\n'),
    userPrompt: [
      '【これまでの相談】',
      renderConversationForPrompt(session),
      memoSection(session),
      styleHint?.trim() ? `【文体への希望】\n${styleHint.trim()}` : '',
      '【出力】',
      '300から600字程度の短い冒頭サンプルだけを出力してください。',
    ].filter(Boolean).join('\n\n---\n\n'),
  };
}

function memoSection(session: SetupSession): string {
  const memo = compactDraftForPrompt(session.draft);
  return memo ? `【確定済みの設定草案】\n${memo}` : '';
}

export function buildSetupCommitPrompt(input: {
  session: SetupSession;
  presetIdsByCategory: PresetIdsByCategory;
}): { systemInstructions: string; userPrompt: string } {
  const latestPreview = getLatestPreviewText(input.session);
  const purpose = purposeOf(input.session);
  return {
    systemInstructions:
      purpose === 'roleplay'
        ? [
            'あなたはロールプレイ会話アプリの初期データ変換係です。',
            '会話ログとdraftから、既存プロジェクト用の初期データへ変換してください。',
            '小説本文や会話サンプルの続きは生成しないでください。',
            'キャラクターごとに greeting（会話開始時の1〜3文の挨拶）と dialogueExamples（口調のfew-shot例、各1文の台詞形式）を必ず入れてください。',
            'defaultUserPersona には、相談で決まった「ユーザーが誰として話すか」を入れてください。draft.userPersona がある場合はそれを正本にし、相談で決まっていない項目は省いてください。',
            'scenarioSeeds には会話の舞台候補（場所・時間・状況）を並べてください。プロットや事件を書かないでください。',
            'firstWishSuggestion は使いません。openingSeeds も無視してください。',
            'storyState は最小構成にしてください: currentSituation に会話開始時のキャラの状況を1〜2行、characterStates にキャラの初期状態を並べる。importantEvents / openThreads は空でよい。',
            'world.foundation には、会話の背景として動かない設定（世界観、キャラの根本的属性の背景となる世界事情）を書いてください。',
            'world.initialSituation には、会話開始時点の状況（場面・時間帯・直前の出来事・人物の現在の立場など、会話進行で変わりうるもの）を書いてください。',
            'memories は preference / negative のみにしてください（storyFact は使わない）。',
            'customSystemPrompt にはキャラの振る舞い（一人称・絵文字禁止など）だけを短く書き、作品メモを詰め込まないでください。',
            '作品データとシステム指示を混ぜないでください。',
            '返答はJSONオブジェクトだけにしてください。Markdownのコードフェンスは不要です。',
          ].join('\n')
        : [
            'あなたは連載小説アプリの初期データ変換係です。',
            '会話ログとdraftから、既存プロジェクト用の初期データへ変換してください。',
            '小説本文は生成しないでください。',
            '作者が決めていない事項は storyState.authorUndecided に入れてください。storyState.openThreads は作中で提示済みの謎・伏線だけにしてください。',
            '人物設定はプロフィール羅列より、物語上の揺れと関係性を重視してください。',
            'world.foundation には、物語進行で変わらない世界の土台（魔法法則・地理・文化・宇宙観・十分に古い歴史など）を書いてください。',
            'world.initialSituation には、物語開始時点で真だが進行によって変わりうる状況（現在の勢力関係・人物の所属や所在・季節・直近の出来事など）を書いてください。',
            '作品データとシステム指示を混ぜないでください。',
            '返答はJSONオブジェクトだけにしてください。Markdownのコードフェンスは不要です。',
          ].join('\n'),
    userPrompt: buildCommitUserPrompt({ ...input, purpose, latestPreview }),
  };
}

function buildCommitUserPrompt(input: {
  session: SetupSession;
  presetIdsByCategory: PresetIdsByCategory;
  purpose: SetupPurpose;
  latestPreview?: string;
}): string {
  const { session, presetIdsByCategory, purpose, latestPreview } = input;
  const outputExample =
    purpose === 'roleplay'
      ? buildRoleplayCommitOutputExample(session)
      : buildNovelCommitOutputExample(session);
  const importantRules =
    purpose === 'roleplay'
      ? [
          '- activePresetIds は相談で明示的に合意した設定だけを、利用可能なプリセットIDで入れる。未指定なら空オブジェクトにする。',
          '- aftertaste は配列で、最大2件までにする。',
          '- 不明なプリセットIDは作らない。',
          '- memories は preference または negative の高重要度情報だけに絞る。storyFact は使わない。',
          '- coreConcept は、このキャラと話す魅力を1〜2文で書く。',
          '- firstWishSuggestion は出力しない。',
          '- scenarioSeeds には会話の舞台候補（場所・時間・状況）を並べる。プロットや事件を書かない。',
          '- 各 character には greeting（1〜3文の挨拶）と dialogueExamples（口調のfew-shot例、各1文の台詞形式）を必ず入れる。',
          '- defaultUserPersona は相談で決まった内容だけを入れる。決まっていない項目は省く。全項目が未定なら defaultUserPersona 自体を省く。',
          '- defaultUserPersona.knownFacts には「キャラがユーザーについて既に知っていること」だけを書く。ユーザーの内面や願望を勝手に決めない。',
          '- traits は最大4件、各項目は { label, text } とする。labelは12文字以内、textは200文字以内にする。',
          '- 主要人物には会話を動かす traits を2〜4件、軽い役には必要な0〜2件を入れる。',
          '- 「見せない面」「秘密」は traits のラベルにせず、必要な場合だけ独立した secrets に入れる。',
          '- storyState は最小構成（currentSituation と characterStates のみ、importantEvents/openThreads は空）にする。',
          '- world は foundation と initialSituation の 2 フィールドで返す。片方が空でよいがフィールドは省略しない。',
          '- customSystemPrompt にはキャラの振る舞いだけを短く書く。作品メモを詰め込まない。',
        ].join('\n')
      : [
          '- activePresetIds は相談で明示的に合意した設定だけを、利用可能なプリセットIDで入れる。未指定なら空オブジェクトにする。',
          '- aftertaste は配列で、最大2件までにする。',
          '- 不明なプリセットIDは作らない。',
          '- memories は本当に次回生成で守りたい高重要度情報だけに絞る。',
          '- coreConcept は、この作品が何の話でどんな読み味を約束するかを1〜2文で書く。',
          '- firstWishSuggestion は openingSeeds と相談の流れから第1話冒頭への希望を1文で書く。openingSeedsが空なら省略してよい。',
          '- customSystemPrompt には作品メモを詰め込まない。書き方や役割などシステム寄りの指示だけにする。',
          '- world は foundation と initialSituation の 2 フィールドで返す。片方が空でよいがフィールドは省略しない。',
          '- traits は最大4件、各項目は { label, text } とする。labelは12文字以内、textは200文字以内にする。',
          '- 主人公と物語の弧を背負う人物には traits を2〜4件、軽い役には必要な0〜2件を入れる。',
          '- 「見せない面」「秘密」は traits のラベルにせず、必要な場合だけ独立した secrets に入れる。',
        ].join('\n');

  const previewLabel =
    purpose === 'roleplay'
      ? '試し会話サンプル(口調・雰囲気の参考)'
      : '試し書きサンプル(文体・温度の参考)';

  return [
    '【利用可能なプリセットID】',
    JSON.stringify(presetIdsByCategory, null, 2),
    '【現在のプロジェクト作成設定】',
    JSON.stringify(session.projectSettings, null, 2),
    session.conversationSummary
      ? `【これまでの相談の要約】\n${session.conversationSummary}`
      : '',
    // NOTE: 設定草案は「今の相談を草案にまとめる」を押すまで空になり得るので、会話ログを正本に置く。
    // 以前は直近24件・各800字打ち切りで、長い相談では序盤の決定が最終変換に届かなかった。
    '【相談ログ】',
    renderConversationForPrompt(session),
    '【相談draft】',
    compactDraftForPrompt(session.draft) || '(まだ空です)',
    latestPreview ? `【${previewLabel}】\n${latestPreview}` : '',
    '【出力形式】',
    JSON.stringify(outputExample, null, 2),
    '【重要】',
    importantRules,
  ]
    .filter(Boolean)
    .join('\n\n---\n\n');
}

function buildNovelCommitOutputExample(session: SetupSession): unknown {
  return {
    project: {
      title: '作品タイトル',
      outputLength: session.projectSettings.outputLength,
      activePresetIds: {},
    },
    coreConcept: 'この作品が何の話で、どんな読み味を約束するかを1〜2文',
    firstWishSuggestion:
      'openingSeeds と相談の流れから、第1話冒頭への希望を1文。openingSeedsが空なら省略可',
    world: {
      foundation: '変わらない世界の土台（魔法法則、地理、文化など）',
      initialSituation: '物語開始時点の状況（勢力関係、人物の所属、季節など）',
    },
    characters: [
      {
        characterId: 'char-protagonist',
        name: '',
        aliases: [],
        role: 'protagonist',
        description: '人物の概要と、必要なら読者の関心を引く点',
        speechStyle: '口調',
        relationshipNotes: '関係性メモ',
        traits: [
          { label: 'こだわり', text: 'その人物らしい判断の軸' },
          { label: '意地の張り方', text: '関係や展開を動かす反応' },
        ],
        secrets: '見せない面（必要な場合だけ）',
        currentState: '開始時点の状態',
      },
    ],
    memories: [
      {
        type: 'preference',
        content: '高重要度の好みまたは守るべき事実',
        importance: 'high',
      },
    ],
    storyState: {
      schemaVersion: 1,
      currentSituation: ['開始時点の状況'],
      characterStates: [],
      importantEvents: [],
      openThreads: [
        {
          summary: '作中で提示済みの未解決の謎・伏線',
          relatedCharacters: [],
          importance: 'medium',
          status: 'active',
        },
      ],
      authorUndecided: [
        {
          text: '作者がまだ決めていない事項',
          reason: '未確定にしている理由',
          status: 'active',
        },
      ],
      clock: { day: 1 },
    },
    customSystemPrompt: '',
  };
}

function buildRoleplayCommitOutputExample(session: SetupSession): unknown {
  return {
    project: {
      title: '作品タイトル（キャラ名や設定名）',
      outputLength: session.projectSettings.outputLength,
      activePresetIds: {},
    },
    coreConcept: 'このキャラと話す魅力を1〜2文（口調と関係性の骨格）',
    world: {
      foundation: '会話の背景として変わらない世界観や時代感',
      initialSituation: '会話開始時点の場面・時間・直前の出来事・現在の立場',
    },
    characters: [
      {
        characterId: 'char-protagonist',
        name: 'キャラ名',
        aliases: [],
        role: 'protagonist',
        description: 'キャラの概要と現在の状態、必要なら関心を引く点',
        speechStyle: '口調の説明',
        relationshipNotes: 'ユーザーとの関係',
        traits: [
          { label: '会話で望むこと', text: 'この会話や相手に期待していること' },
          { label: '距離の詰め方', text: '親しくなるときの振る舞い' },
        ],
        secrets: '見せない面（必要な場合だけ）',
        currentState: '会話開始時点の状態',
        greeting: '会話開始時にキャラから発する1〜3文の挨拶',
        dialogueExamples: [
          'そのキャラが実際に発する台詞1',
          'そのキャラが実際に発する台詞2',
        ],
      },
    ],
    memories: [
      {
        type: 'preference',
        content: '会話で守りたい高重要度の好み',
        importance: 'high',
      },
    ],
    storyState: {
      schemaVersion: 1,
      currentSituation: ['会話開始時のキャラの状況を1〜2行'],
      characterStates: [
        {
          characterId: 'char-protagonist',
          name: 'キャラ名',
          currentState: '会話開始時の内面・立ち位置',
          knowledge: [],
          relationships: [],
        },
      ],
      importantEvents: [],
      openThreads: [],
      authorUndecided: [],
      clock: { day: 1 },
    },
    customSystemPrompt: '',
    scenarioSeeds: [
      '会話の舞台候補1（例：放課後の教室で二人きり）',
      '会話の舞台候補2',
    ],
    defaultUserPersona: {
      name: 'ユーザーが名乗る名前（未定なら省略）',
      relationship: 'ユーザーから見たキャラとの関係',
      preferredAddress: 'キャラからの呼ばれ方',
      knownFacts: 'キャラが既にユーザーについて知っていること',
    },
  };
}

function getLatestPreviewText(session: SetupSession): string | undefined {
  const previews = session.previews ?? [];
  const latest = previews[previews.length - 1];
  if (!latest?.text) return undefined;
  return truncateForPrompt(latest.text, MAX_PREVIEW_CHARS);
}

function activeDraftForPrompt(draft: SetupDraft): SetupDraft {
  return {
    ...draft,
    confirmed: draft.confirmed.filter((item) => item.status === 'active'),
    candidates: draft.candidates.filter((candidate) => candidate.status === 'active'),
    undecided: draft.undecided.filter((item) => item.status === 'active'),
    characters: draft.characters.filter((character) => character.status === 'active'),
  };
}

function truncateForPrompt(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}...` : value;
}
