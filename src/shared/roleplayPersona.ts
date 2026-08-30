import type { RoleplayUserActionPolicy, RoleplayUserPersona } from './types/roleplay.js';

// NOTE: ユーザーペルソナは「セッション開始時の入力」「作品の既定値」「相談draft」「作品化プラン」
// の4箇所を行き来する。上限と既定方針がずれると、どこかで黙って切り詰められたり弾かれたり
// するので、正本をここに1つ置いてクライアント・サーバー双方から引く。
export const ROLEPLAY_USER_PERSONA_LIMITS = {
  name: 80,
  relationship: 200,
  preferredAddress: 80,
  knownFacts: 1000,
} as const;

export const ROLEPLAY_USER_ACTION_POLICY_VALUES: readonly RoleplayUserActionPolicy[] = [
  'strict',
  'collaborative',
  // NOTE: 旧「控えめに補完」。新規UIでは選べず、正規化時に collaborative へ移行する。
  'conservative',
];

export const DEFAULT_ROLEPLAY_USER_ACTION_POLICY: RoleplayUserActionPolicy = 'collaborative';

export function isRoleplayUserActionPolicy(value: unknown): value is RoleplayUserActionPolicy {
  return (
    typeof value === 'string' &&
    ROLEPLAY_USER_ACTION_POLICY_VALUES.includes(value as RoleplayUserActionPolicy)
  );
}

export function normalizeRoleplayUserActionPolicy(
  value: unknown
): RoleplayUserActionPolicy {
  if (value === 'strict') return 'strict';
  // NOTE: 旧「控えめに補完」は補完を許可していた利用者意図を保ち、強化後の
  // 「自然に補完」へ寄せる。未知値・欠損も現行既定へ落とす。
  if (value === 'collaborative' || value === 'conservative') return 'collaborative';
  return DEFAULT_ROLEPLAY_USER_ACTION_POLICY;
}

/**
 * Normalizes persona-ish input without throwing: trims, truncates to the shared
 * limits, and drops empty fields.
 *
 * NOTE: 相談LLMの出力や保存済みデータのように「壊れていても会話を止めたくない」入力に使う。
 * セッション開始APIのように 400 を返して知らせたい経路では、呼び出し側の検証を使うこと。
 */
export function normalizeUserPersonaFields(value: unknown): RoleplayUserPersona | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const persona: RoleplayUserPersona = {
    name: normalizePersonaText(source.name, ROLEPLAY_USER_PERSONA_LIMITS.name),
    relationship: normalizePersonaText(source.relationship, ROLEPLAY_USER_PERSONA_LIMITS.relationship),
    preferredAddress: normalizePersonaText(
      source.preferredAddress,
      ROLEPLAY_USER_PERSONA_LIMITS.preferredAddress
    ),
    knownFacts: normalizePersonaText(source.knownFacts, ROLEPLAY_USER_PERSONA_LIMITS.knownFacts),
    actionPolicy: normalizeRoleplayUserActionPolicy(source.actionPolicy),
  };
  // NOTE: actionPolicy だけの既定値ペルソナは「未設定」と同じ意味なので保存しない。
  return isEmptyUserPersona(persona) ? undefined : persona;
}

export function isEmptyUserPersona(persona: RoleplayUserPersona | undefined): boolean {
  if (!persona) return true;
  return (
    !persona.name?.trim() &&
    !persona.relationship?.trim() &&
    !persona.preferredAddress?.trim() &&
    !persona.knownFacts?.trim() &&
    normalizeRoleplayUserActionPolicy(persona.actionPolicy) ===
      DEFAULT_ROLEPLAY_USER_ACTION_POLICY
  );
}

function normalizePersonaText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}
