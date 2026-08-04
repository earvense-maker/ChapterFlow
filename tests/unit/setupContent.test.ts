import { describe, expect, it } from 'vitest';
import {
  SETUP_DRAFT_NUDGE_CHARS,
  SETUP_DRAFT_NUDGE_MIN_NEW_MESSAGES,
  hasMeaningfulSetupContent,
  hasSetupDraftContent,
  shouldSuggestDraftWriteUp,
} from '../../src/shared/setupContent';
import type { SetupDraft, SetupSession } from '../../src/shared/types';

const now = '2026-07-23T00:00:00.000Z';

function draft(patch: Partial<SetupDraft> = {}): SetupDraft {
  return {
    coreConcept: '',
    confirmed: [],
    candidates: [],
    undecided: [],
    characters: [],
    relationshipSeeds: [],
    world: [],
    tone: [],
    ng: [],
    openingSeeds: [],
    scenarioSeeds: [],
    ...patch,
  };
}

function session(
  draftPatch: Partial<SetupDraft> = {},
  messages: SetupSession['messages'] = []
): SetupSession {
  return {
    draft: draft(draftPatch),
    messages,
  } as SetupSession;
}

describe('hasMeaningfulSetupContent', () => {
  it('rejects a completely empty setup session', () => {
    expect(hasMeaningfulSetupContent(session())).toBe(false);
  });

  it('accepts user-authored chat or roleplay scenario content', () => {
    expect(
      hasMeaningfulSetupContent(
        session({}, [
          {
            role: 'user',
            content: '静かなミステリーにしたい',
            createdAt: '2026-07-23T00:00:00.000Z',
          },
        ])
      )
    ).toBe(true);
    expect(hasMeaningfulSetupContent(session({ scenarioSeeds: ['雨宿り中の会話'] }))).toBe(true);
  });

  it('accepts a draft that only defines who the user plays', () => {
    expect(hasMeaningfulSetupContent(session({ userPersona: { name: '結衣' } }))).toBe(true);
    expect(hasMeaningfulSetupContent(session({ userPersona: { name: '  ' } }))).toBe(false);
  });
});

describe('hasSetupDraftContent', () => {
  it('does not count consultation messages as draft content', () => {
    // NOTE: 作品化の可否を分ける境目。相談ターンが草案を書かなくなったので、
    // 「相談した」だけで作品化できると、草案が空のまま作品が生成される。
    const consulted = session({}, [
      { role: 'user', content: '静かなミステリーにしたい', createdAt: now },
      { role: 'assistant', content: '良いですね。', createdAt: now },
    ]);

    expect(hasMeaningfulSetupContent(consulted)).toBe(true);
    expect(hasSetupDraftContent(consulted)).toBe(false);
  });

  it('counts anything actually written into the draft', () => {
    expect(hasSetupDraftContent(session({ coreConcept: '閉ざされた研究島' }))).toBe(true);
    expect(hasSetupDraftContent(session({ world: ['近未来'] }))).toBe(true);
    expect(hasSetupDraftContent(session({ world: ['  '] }))).toBe(false);
  });
});

describe('shouldSuggestDraftWriteUp', () => {
  function longConversation(totalChars: number, count = 10): SetupSession['messages'] {
    return Array.from({ length: count }, () => ({
      role: 'user' as const,
      content: 'あ'.repeat(Math.ceil(totalChars / count)),
      createdAt: now,
    }));
  }

  it('stays quiet while the conversation still fits the prompt budget', () => {
    expect(
      shouldSuggestDraftWriteUp(session({}, longConversation(SETUP_DRAFT_NUDGE_CHARS - 1000)))
    ).toBe(false);
  });

  it('asks for a write-up once the conversation is close to overflowing', () => {
    expect(
      shouldSuggestDraftWriteUp(session({}, longConversation(SETUP_DRAFT_NUDGE_CHARS + 1000)))
    ).toBe(true);
  });

  it('goes quiet after a write-up and waits for a couple of exchanges before asking again', () => {
    // NOTE: 1件増えるたびに再点灯すると、閾値超過後は毎ターン催促が出続ける。
    // 常時表示は警告として機能せず、押すたびにモデル呼び出しの費用もかかる。
    const messages = longConversation(SETUP_DRAFT_NUDGE_CHARS + 1000, 10);
    const justWritten = {
      ...session({}, messages),
      draftWrittenUpMessageCount: messages.length,
    } as SetupSession;
    const withMore = (count: number) =>
      ({
        ...justWritten,
        messages: [
          ...messages,
          ...Array.from({ length: count }, () => ({
            role: 'user' as const,
            content: 'つづき',
            createdAt: now,
          })),
        ],
      }) as SetupSession;

    expect(shouldSuggestDraftWriteUp(justWritten)).toBe(false);
    expect(shouldSuggestDraftWriteUp(withMore(SETUP_DRAFT_NUDGE_MIN_NEW_MESSAGES - 1))).toBe(false);
    expect(shouldSuggestDraftWriteUp(withMore(SETUP_DRAFT_NUDGE_MIN_NEW_MESSAGES))).toBe(true);
  });
});
