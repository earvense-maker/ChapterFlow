import type { SetupSession } from './types/index.js';

/**
 * 相談ログをプロンプトへ載せる上限。これを超えた分は古い側から落ちる。
 *
 * NOTE: 相談ターンから設定草案の自動更新を外したので、草案が会話の圧縮役を
 * 兼ねなくなった。溢れた会話は本当に失われるため、下の NUDGE 側で
 * 「草案にまとめる」を促してから到達させる。
 */
export const SETUP_CHAT_LOG_BUDGET_CHARS = 24_000;

/** ここを超えたら、溢れる前に一度まとめるよう促す。 */
export const SETUP_DRAFT_NUDGE_CHARS = 20_000;

/**
 * 前回まとめてから再度促すまでに必要なメッセージ数（2往復）。
 *
 * NOTE: 「1件でも増えたら再点灯」だと、閾値を超えた後は毎ターン催促が出続ける。
 * 常時表示は警告として機能しなくなるうえ、押すたびにモデル呼び出しの費用がかかる。
 */
export const SETUP_DRAFT_NUDGE_MIN_NEW_MESSAGES = 4;

/** 相談ログの総文字数。プロンプト予算の判定と画面の促しで同じ数え方を使う。 */
export function setupConversationChars(session: SetupSession): number {
  return session.messages.reduce((total, message) => total + message.content.length, 0);
}

/**
 * 設定草案に中身があるか。作品化の可否はこれで決める。
 *
 * NOTE: hasMeaningfulSetupContent と分けているのは、あちらが「ユーザー発言が1つでも
 * あれば true」で、相談しただけの状態も含むため。相談ターンが草案を書かなくなった今、
 * それを作品化の条件にすると、草案が空のまま会話ログだけから作品が生成される。
 * 利用者が中身を確認・修正する機会が無いので、作品化には草案の実体を要求する。
 */
export function hasSetupDraftContent(session: SetupSession): boolean {
  const draft = session.draft;
  return Boolean(
    draft.coreConcept.trim() ||
      draft.confirmed.some((item) => item.status === 'active' && item.text.trim()) ||
      draft.candidates.some(
        (item) => item.status === 'active' && (item.title.trim() || item.summary.trim())
      ) ||
      draft.undecided.some((item) => item.status === 'active' && item.text.trim()) ||
      draft.characters.some(
        (item) =>
          item.status === 'active' &&
          (item.name.trim() || item.label.trim() || item.description.trim())
      ) ||
      draft.relationshipSeeds.some((item) => item.trim()) ||
      draft.world.some((item) => item.trim()) ||
      draft.tone.some((item) => item.trim()) ||
      draft.ng.some((item) => item.trim()) ||
      draft.openingSeeds.some((item) => item.trim()) ||
      (draft.scenarioSeeds ?? []).some((item) => item.trim()) ||
      // NOTE: ユーザーペルソナだけ埋めた状態でも「草案に書いた」ことに変わりはない。
      // ここに入れておかないと、画面に内容が見えているのに作品化ボタンが押せない。
      Object.values(draft.userPersona ?? {}).some((value) => value?.trim())
  );
}

/**
 * Returns whether a setup session contains enough user-authored material to
 * continue beyond the initial empty state.
 *
 * NOTE: This predicate is shared by the client and server so the cold-start UI
 * and commit validation cannot drift apart as draft fields evolve.
 */
export function hasMeaningfulSetupContent(session: SetupSession): boolean {
  return (
    session.messages.some((message) => message.role === 'user' && message.content.trim()) ||
    hasSetupDraftContent(session)
  );
}

/**
 * 「今の相談を草案にまとめる」を促すべきか。
 *
 * 促す条件は「溢れが近い」かつ「前回まとめてから2往復以上進んでいる」の両方。
 * 未実行のセッション（draftWrittenUpMessageCount 未設定）は0扱いなので、閾値を
 * 超えていれば初回は必ず promoted される。
 */
export function shouldSuggestDraftWriteUp(session: SetupSession): boolean {
  if (setupConversationChars(session) < SETUP_DRAFT_NUDGE_CHARS) return false;
  const newMessages = session.messages.length - (session.draftWrittenUpMessageCount ?? 0);
  return newMessages >= SETUP_DRAFT_NUDGE_MIN_NEW_MESSAGES;
}
