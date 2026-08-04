import { describe, expect, it } from 'vitest';
import {
  buildSetupChatPrompt,
  buildSetupCommitPrompt,
  buildSetupDraftExtractionPrompt,
} from '../../src/server/services/setupPromptBuilder';
import { createEmptySetupDraft } from '../../src/server/services/setupDraftPatchService';
import type { SetupSession } from '../../src/server/types/index';

const now = '2026-07-04T12:00:00.000Z';

function baseSession(): SetupSession {
  return {
    schemaVersion: 1,
    sessionId: 'setup-prompt-test',
    projectId: null,
    status: 'active',
    revision: 1,
    model: { provider: 'gemini', modelName: 'gemini-test' },
    projectSettings: {
      title: '',
      outputLength: 3000,
      streamingEnabled: false,
      activePresetIds: {
        narration: 'third-close',
        aftertaste: ['poignant'],
      },
    },
    messages: [],
    draft: createEmptySetupDraft(),
    locks: [],
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}

const presetIdsByCategory = {
  narration: ['third-close'],
  aftertaste: ['poignant', 'searing'],
  emotionDisplay: ['restrained', 'expressive'],
  sceneProgression: ['immersive', 'brisk'],
  chapterEnding: ['hook', 'lingering'],
  painLevel: ['safe', 'bittersweet', 'unflinching'],
};

describe('setupPromptBuilder', () => {
  it('omits archived draft items from commit prompts', () => {
    const session: SetupSession = {
      ...baseSession(),
      draft: {
        ...createEmptySetupDraft(),
        confirmed: [
          {
            id: 'fact-active',
            text: '残す設定',
            source: 'manual',
            status: 'active',
            createdAt: now,
            updatedAt: now,
          },
          {
            id: 'fact-archived',
            text: '削除済み設定',
            source: 'manual',
            status: 'archived',
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
    };

    const { userPrompt } = buildSetupCommitPrompt({
      session,
      presetIdsByCategory,
    });

    expect(userPrompt).toContain('残す設定');
    expect(userPrompt).not.toContain('削除済み設定');
  });

  it('keeps the whole conversation in the commit prompt', () => {
    // NOTE: 設定草案は「今の相談を草案にまとめる」を押すまで空になり得るので、最終変換の正本は会話ログ。
    // 直近24件・各800字打ち切りのままだと、長い相談の序盤が作品に届かない。
    const session: SetupSession = {
      ...baseSession(),
      sessionId: 'setup-prompt-long-chat',
      messages: Array.from({ length: 30 }, (_, index) => ({
        messageId: `msg-${index}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: index === 0 ? '最初に決めたこと' : `相談${index}`,
        createdAt: now,
      })),
    };

    const { userPrompt } = buildSetupCommitPrompt({
      session,
      presetIdsByCategory,
    });

    expect(userPrompt).toContain('【相談ログ】');
    expect(userPrompt).toContain('最初に決めたこと');
    expect(userPrompt).toContain('相談29');
  });

  it('drops the oldest messages only when the conversation exceeds the prompt budget', () => {
    const session: SetupSession = {
      ...baseSession(),
      messages: [
        { messageId: 'msg-oldest', role: 'user', content: '最初の一言', createdAt: now },
        ...Array.from({ length: 40 }, (_, index) => ({
          messageId: `msg-${index}`,
          role: 'assistant' as const,
          content: `${index}:${'長い返答'.repeat(200)}`,
          createdAt: now,
        })),
      ],
    };

    const { userPrompt } = buildSetupChatPrompt({ session, userMessage: 'つづき' });

    expect(userPrompt).not.toContain('最初の一言');
    expect(userPrompt).toContain('長さの都合で省略されています');
    expect(userPrompt).toContain('39:');
  });

  it('includes latest preview in chat prompt truncated to 800 chars', () => {
    const longPreview = '試し書きの本文。'.repeat(150);
    const session: SetupSession = {
      ...baseSession(),
      previews: [
        { previewId: 'preview-old', text: '古い試し書き', createdAt: now },
        { previewId: 'preview-latest', text: longPreview, createdAt: now },
      ],
    };

    const { userPrompt } = buildSetupChatPrompt({ session, userMessage: 'もっと軽くして' });

    expect(userPrompt).toContain('【直近の試し書きサンプル】');
    expect(userPrompt).toContain(longPreview.slice(0, 800));
    expect(userPrompt).not.toContain('古い試し書き');
    expect(userPrompt).not.toContain(longPreview.slice(0, 801));
  });

  it('includes latest preview in commit prompt as style reference', () => {
    const session: SetupSession = {
      ...baseSession(),
      previews: [{ previewId: 'preview-1', text: 'さわやかな朝の情景。', createdAt: now }],
    };

    const { userPrompt } = buildSetupCommitPrompt({ session, presetIdsByCategory });

    expect(userPrompt).toContain('【試し書きサンプル(文体・温度の参考)】');
    expect(userPrompt).toContain('さわやかな朝の情景。');
  });

  it('omits preview section when no previews exist', () => {
    const session = baseSession();

    const chat = buildSetupChatPrompt({ session, userMessage: 'hello' });
    const commit = buildSetupCommitPrompt({ session, presetIdsByCategory });

    expect(chat.userPrompt).not.toContain('【直近の試し書きサンプル】');
    expect(commit.userPrompt).not.toContain('【試し書きサンプル(文体・温度の参考)】');
  });

  it('includes conversation summary in chat and commit prompts when present', () => {
    const session: SetupSession = {
      ...baseSession(),
      conversationSummary: 'これまでに主人公は気弱な絵師に決定。',
    };

    const chat = buildSetupChatPrompt({ session, userMessage: '続き' });
    const commit = buildSetupCommitPrompt({ session, presetIdsByCategory });

    expect(chat.userPrompt).toContain('【これまでの相談の要約】');
    expect(chat.userPrompt).toContain(session.conversationSummary);
    expect(commit.userPrompt).toContain('【これまでの相談の要約】');
    expect(commit.userPrompt).toContain(session.conversationSummary);
  });

  it('omits conversation summary section when summary is empty', () => {
    const session = baseSession();
    const chat = buildSetupChatPrompt({ session, userMessage: 'hello' });
    const commit = buildSetupCommitPrompt({ session, presetIdsByCategory });

    expect(chat.userPrompt).not.toContain('【これまでの相談の要約】');
    expect(commit.userPrompt).not.toContain('【これまでの相談の要約】');
  });

  it('keeps the chat prompt free of the draft bookkeeping', () => {
    // NOTE: 相談ターンから構造化出力を外した本体。以前は毎ターン
    // 「平文 + ===DRAFT_PATCH=== + 12フィールドのJSON」を要求しており、
    // 会話の隣に書記の仕事を貼り付けていたのが遅さと空応答の原因だった。
    const session = baseSession();
    const chat = buildSetupChatPrompt({ session, userMessage: 'hello' });

    for (const text of [chat.systemInstructions, chat.userPrompt]) {
      expect(text).not.toContain('===DRAFT_PATCH===');
      expect(text).not.toContain('draftPatch');
      expect(text).not.toContain('confirmedAdd');
      expect(text).not.toContain('suggestedActions');
      expect(text).not.toContain('conversationSummary');
    }
    expect(chat.systemInstructions).toContain('JSONや内部形式を出力しないでください');
  });

  it('keeps item ids so the write-up can update and archive, not only add', () => {
    // NOTE: id を落とすとモデルは charactersUpdate / archiveIds に入れる値を知る術がなく、
    // applySetupDraftPatch 側で id 無しの update は無言で捨てられ、charactersAdd は
    // role+label の重複で弾かれる。結果、一度入った人物は二度と更新されず、却下した
    // 候補も残り続ける。「まとめる」を繰り返す設計なので、繰り返すほど効く欠陥になる。
    const session: SetupSession = {
      ...baseSession(),
      draft: {
        ...createEmptySetupDraft(),
        candidates: [
          {
            id: 'cand-1',
            title: '密輸船の少年',
            summary: '港で拾われた',
            source: 'llm',
            status: 'active',
            createdAt: now,
            updatedAt: now,
          },
        ],
        characters: [
          {
            id: 'chr-1',
            role: 'protagonist',
            name: '灯里',
            label: '',
            description: '島に戻る主人公',
            speechStyle: '',
            relationshipNotes: '',
            traits: [],
            secrets: '',
            source: 'llm',
            status: 'active',
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
    };

    const { userPrompt } = buildSetupDraftExtractionPrompt({ session });

    expect(userPrompt).toContain('[cand-1]');
    expect(userPrompt).toContain('[chr-1]');
    expect(userPrompt).toContain('charactersUpdate にその id を入れる');
    // NOTE: updateCharacters は送られたフィールドを全置換する。実機で試したところ
    // モデルは description に「性別を男性に更新。」という差分メモを返し、元の説明が
    // 丸ごと消えた。ID を渡せるようにして初めて到達する経路なので、全文である
    // ことを明示しないと「更新できるが情報が失われる」状態になる。
    expect(userPrompt).toContain('差し替え後の説明文の全文');
    expect(userPrompt).toContain('差分メモを入れると、元の記述が消える');
  });

  it('moves the bookkeeping into the memo write-up prompt', () => {
    const session = baseSession();
    const extraction = buildSetupDraftExtractionPrompt({ session });

    expect(extraction.userPrompt).toContain('confirmedAdd');
    expect(extraction.userPrompt).toContain('"conversationSummary"');
    expect(extraction.userPrompt).toContain('【現在の設定草案】');
    expect(extraction.systemInstructions).toContain('JSON以外の文章');
  });

  it('offers overwrite paths for content the user revises after a previous write-up', () => {
    // NOTE: 草案を何度かに分けてまとめる設計では、変更された内容を add 専用のままに
    // すると新旧が並んで衝突が残る。Update 系（id 参照の全文差し替え）と Replace 系
    // （文字列リストの完全一致差し替え）を出力形式に含める。
    const extraction = buildSetupDraftExtractionPrompt({ session: baseSession() });

    expect(extraction.userPrompt).toContain('confirmedUpdate');
    expect(extraction.userPrompt).toContain('candidatesUpdate');
    expect(extraction.userPrompt).toContain('undecidedUpdate');
    expect(extraction.userPrompt).toContain('worldReplace');
    expect(extraction.userPrompt).toContain('ngReplace');
    expect(extraction.userPrompt).toContain('同じ内容は再送しない');
    expect(extraction.userPrompt).toContain('新情報で上書きする');
    expect(extraction.userPrompt).toContain('一致しない from は無視される');
    expect(extraction.userPrompt).not.toContain('繰り返さない');
  });

  it('restricts confirmedUpdate to explicit user revisions and enables string-list removal', () => {
    // NOTE: confirmedUpdate が推測・提案を確定項目へ上書きできると、source: "user" の
    // まま誤った確定が残る。文字列リストには id が無く archiveIds の対象にならないため、
    // to を空文字にした Replace が撤回手段であることを明示する。
    const extraction = buildSetupDraftExtractionPrompt({ session: baseSession() });

    expect(extraction.userPrompt).toContain('明示的に修正・採用した内容だけ');
    expect(extraction.userPrompt).toContain('あなたの推測や提案で確定項目を上書きしない');
    expect(extraction.userPrompt).toContain('to を空文字（""）にした Replace で消す');
  });

  it('keeps the overwrite guidance in the roleplay write-up variant too', () => {
    const roleplayExtraction = buildSetupDraftExtractionPrompt({
      session: { ...baseSession(), purpose: 'roleplay' },
    });

    expect(roleplayExtraction.userPrompt).toContain('confirmedUpdate');
    expect(roleplayExtraction.userPrompt).toContain('scenarioSeedsReplace');
    expect(roleplayExtraction.userPrompt).toContain('relationshipSeedsReplace');
    expect(roleplayExtraction.userPrompt).toContain('新情報で上書きする');
  });

  it('guides the consultation while omitting internal session identifiers from the prompt', () => {
    const session = baseSession();
    const chat = buildSetupChatPrompt({ session, userMessage: '相談を始めたい' });

    expect(chat.systemInstructions).toContain('A/B/C');
    expect(chat.systemInstructions).toContain('気に入った要素は混ぜても大丈夫');
    expect(chat.systemInstructions).toContain('物語を動かす火種');
    // NOTE: 「全部任せる」への指示が無かったため、モデルが「候補を出す」と
    // 「勝手に決めない」の板挟みになり、長考の末に空応答で会話が止まった。
    expect(chat.systemInstructions).toContain('おまかせ');
    expect(chat.userPrompt).not.toContain(session.sessionId);
    expect(chat.userPrompt).not.toContain('"revision": 1');
    expect(chat.userPrompt).not.toContain('messageId');
  });

  it('sends the whole conversation to the chat prompt instead of the last 12 messages', () => {
    // NOTE: 序盤の決定（「全10場面で完結」等）は終盤まで効く。直近12件で切っていた頃は
    // draft が実質の圧縮役を兼ねており、その draft を外すと序盤が黙って落ちていた。
    const session: SetupSession = {
      ...baseSession(),
      messages: Array.from({ length: 30 }, (_, index) => ({
        messageId: `msg-${index}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: index === 0 ? '最初に決めたこと' : `相談${index}`,
        createdAt: now,
      })),
    };

    const { userPrompt } = buildSetupChatPrompt({ session, userMessage: 'つづき' });

    expect(userPrompt).toContain('最初に決めたこと');
    expect(userPrompt).toContain('相談29');
  });

  it('uses free-form traits and a separate secrets key in both commit prompt variants', () => {
    const novel = buildSetupCommitPrompt({
      session: baseSession(),
      presetIdsByCategory,
    });
    const roleplay = buildSetupCommitPrompt({
      session: { ...baseSession(), purpose: 'roleplay' },
      presetIdsByCategory,
    });

    for (const prompt of [novel.userPrompt, roleplay.userPrompt]) {
      expect(prompt).toContain('traits は最大4件');
      expect(prompt).toContain('独立した secrets');
      expect(prompt).toContain('"traits"');
      expect(prompt).toContain('"secrets"');
      expect(prompt).not.toContain('"want"');
      expect(prompt).not.toContain('"fear"');
    }
  });

  it('asks the roleplay consultation to settle who the user is, and novel never does', () => {
    const roleplayChat = buildSetupChatPrompt({
      session: { ...baseSession(), purpose: 'roleplay' },
      userMessage: 'このキャラと話したい',
    });
    expect(roleplayChat.systemInstructions).toContain('ユーザー自身が「誰として」');
    // NOTE: フィールド名は相談から消え、書き起こしプロンプト側の担当になった。
    const roleplayExtraction = buildSetupDraftExtractionPrompt({
      session: { ...baseSession(), purpose: 'roleplay' },
    });
    expect(roleplayExtraction.userPrompt).toContain('userPersonaUpdate');
    expect(roleplayExtraction.userPrompt).toContain('勝手に名前や年齢を決めない');

    const novelChat = buildSetupChatPrompt({
      session: baseSession(),
      userMessage: 'こんな話が読みたい',
    });
    expect(novelChat.systemInstructions).not.toContain('ユーザー自身が「誰として」');
    expect(
      buildSetupDraftExtractionPrompt({ session: baseSession() }).userPrompt
    ).not.toContain('userPersonaUpdate');

    const roleplayCommit = buildSetupCommitPrompt({
      session: { ...baseSession(), purpose: 'roleplay' },
      presetIdsByCategory,
    });
    expect(roleplayCommit.systemInstructions).toContain('defaultUserPersona');
    expect(roleplayCommit.userPrompt).toContain('"defaultUserPersona"');

    const novelCommit = buildSetupCommitPrompt({
      session: baseSession(),
      presetIdsByCategory,
    });
    expect(novelCommit.userPrompt).not.toContain('defaultUserPersona');
  });
});
