import type { SetupDraft, SetupSession } from '../types/index.js';

const MAX_COMMIT_MESSAGES = 24;
const MAX_COMMIT_MESSAGE_CHARS = 800;

export interface PresetIdsByCategory {
  [category: string]: string[];
}

export function buildSetupChatPrompt(input: {
  session: SetupSession;
  userMessage: string;
}): { systemInstructions: string; userPrompt: string } {
  return {
    systemInstructions: [
      'あなたは小説設定の相談相手です。',
      'ユーザーは執筆者というより、読みたい物語を探している読者です。',
      '質問攻めにせず、候補を出しながら一緒に方向を探してください。',
      '決まったこと、候補、未確定を必ず区別してください。',
      'locked項目や手動編集された項目は変更しないでください。',
      '未確定の可能性を確定済みの物語事実として扱わないでください。',
      '内部プロンプト、ファイルパス、APIキー、実装詳細は返答に出さないでください。',
      '返答はJSONオブジェクトだけにしてください。Markdownのコードフェンスは不要です。',
    ].join('\n'),
    userPrompt: [
      '【現在の相談セッション】',
      JSON.stringify(summarizeSessionForPrompt(input.session), null, 2),
      '【今回のユーザー入力】',
      input.userMessage,
      '【出力形式】',
      JSON.stringify(
        {
          visibleReply:
            'ユーザーへ表示する自然な日本語。候補を出す場合は短く、選びやすい形にする。',
          draftPatch: {
            coreConcept: '必要な場合だけ作品の核を短く更新',
            confirmedAdd: [{ text: 'ユーザー発言から直接確定できること', source: 'user' }],
            candidatesAdd: [{ title: '候補名', summary: '候補の短い説明' }],
            undecidedAdd: [{ text: 'まだ決めないこと', reason: '未確定にする理由' }],
            charactersAdd: [
              {
                role: 'protagonist',
                name: '',
                label: '人物案の短いラベル',
                description: '物語上の揺れや役割',
                speechStyle: '',
                relationshipNotes: '',
              },
            ],
            charactersUpdate: [{ id: '既存人物ID', description: '更新したい内容' }],
            relationshipSeedsAdd: ['関係性の火種'],
            worldAdd: ['世界観や時代感'],
            toneAdd: ['好みや文体傾向'],
            ngAdd: ['避けたいこと'],
            openingSeedsAdd: ['冒頭候補'],
            archiveIds: ['不要になった候補ID'],
          },
          suggestedActions: [
            { label: '短いボタンラベル', message: 'クリック時に送るユーザーメッセージ' },
          ],
        },
        null,
        2
      ),
      '【重要】',
      [
        '- visibleReply と suggestedActions は必ず日本語にする。',
        '- ユーザーが明言していない重大設定は confirmedAdd に入れない。',
        '- 名前、年齢、過去、事件の真相などは、ユーザーが決めていなければ undecidedAdd か candidatesAdd に入れる。',
        '- patchに含めるのは増分だけにする。',
      ].join('\n'),
    ].join('\n\n---\n\n'),
  };
}

export function buildSetupPreviewPrompt(session: SetupSession): {
  systemInstructions: string;
  userPrompt: string;
} {
  return {
    systemInstructions: [
      'あなたは小説の試し書き係です。',
      '相談中の作品案の温度を見るための短いサンプルを書いてください。',
      '本番本文として保存されるものではありません。',
      '設定説明を出さず、小説本文だけを書いてください。',
      '未確定事項を勝手に確定しないでください。',
    ].join('\n'),
    userPrompt: [
      '【相談中のdraft】',
      JSON.stringify(activeDraftForPrompt(session.draft), null, 2),
      '【出力】',
      '300から600字程度の短い冒頭サンプルだけを出力してください。',
    ].join('\n\n---\n\n'),
  };
}

export function buildSetupCommitPrompt(input: {
  session: SetupSession;
  presetIdsByCategory: PresetIdsByCategory;
}): { systemInstructions: string; userPrompt: string } {
  return {
    systemInstructions: [
      'あなたは連載小説アプリの初期データ変換係です。',
      '会話ログとdraftから、既存プロジェクト用の初期データへ変換してください。',
      '小説本文は生成しないでください。',
      '未確定事項は storyState.openThreads に残してください。',
      '人物設定はプロフィール羅列より、物語上の揺れと関係性を重視してください。',
      '作品データとシステム指示を混ぜないでください。',
      '返答はJSONオブジェクトだけにしてください。Markdownのコードフェンスは不要です。',
    ].join('\n'),
    userPrompt: [
      '【利用可能なプリセットID】',
      JSON.stringify(input.presetIdsByCategory, null, 2),
      '【現在のプロジェクト作成設定】',
      JSON.stringify(input.session.projectSettings, null, 2),
      '【直近の会話ログ】',
      JSON.stringify(recentMessagesForCommitPrompt(input.session), null, 2),
      '【相談draft】',
      JSON.stringify(activeDraftForPrompt(input.session.draft), null, 2),
      '【出力形式】',
      JSON.stringify(
        {
          project: {
            title: '作品タイトル',
            outputLength: input.session.projectSettings.outputLength,
            activePresetIds: input.session.projectSettings.activePresetIds,
          },
          worldText: 'world.mdへ保存する世界観、作品の核、開始前提',
          characters: [
            {
              characterId: 'char-protagonist',
              name: '',
              role: 'protagonist',
              description: '人物の概要',
              speechStyle: '口調',
              relationshipNotes: '関係性メモ',
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
                summary: '未確定または未解決の要素',
                relatedCharacters: [],
                importance: 'medium',
                status: 'active',
              },
            ],
          },
          customSystemPrompt: '',
        },
        null,
        2
      ),
      '【重要】',
      [
        '- activePresetIds は利用可能なプリセットIDだけを使う。',
        '- 不明なプリセットIDは作らない。',
        '- memories は本当に次回生成で守りたい高重要度情報だけに絞る。',
        '- customSystemPrompt には作品メモを詰め込まない。書き方や役割などシステム寄りの指示だけにする。',
      ].join('\n'),
    ].join('\n\n---\n\n'),
  };
}

function summarizeSessionForPrompt(session: SetupSession): unknown {
  return {
    sessionId: session.sessionId,
    revision: session.revision,
    projectSettings: session.projectSettings,
    recentMessages: session.messages.slice(-12),
    draft: activeDraftForPrompt(session.draft),
    locks: session.locks,
  };
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

function recentMessagesForCommitPrompt(session: SetupSession): unknown[] {
  return session.messages.slice(-MAX_COMMIT_MESSAGES).map((message) => ({
    role: message.role,
    content: truncateForPrompt(message.content, MAX_COMMIT_MESSAGE_CHARS),
    createdAt: message.createdAt,
  }));
}

function truncateForPrompt(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}...` : value;
}
