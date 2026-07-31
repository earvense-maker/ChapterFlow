import { ROLEPLAY_USER_PERSONA_LIMITS } from '@shared/roleplayPersona';

// NOTE: ユーザーペルソナの入力欄は相談メモ・作品化確認・会話開始モーダルの3画面に出る。
// ラベルと上限がずれると「片方では入るのに片方で切れる」ので、定義はここ1つに集める。
// 上限値は保存側（shared/roleplayPersona）の正本をそのまま使う。
export type UserPersonaFieldKey = 'name' | 'relationship' | 'preferredAddress' | 'knownFacts';

export interface UserPersonaFieldSpec {
  key: UserPersonaFieldKey;
  label: string;
  placeholder: string;
  maxLength: number;
  rows?: number;
}

export const USER_PERSONA_FIELDS: UserPersonaFieldSpec[] = [
  {
    key: 'name',
    label: '名前',
    placeholder: 'キャラクターに名乗る名前',
    maxLength: ROLEPLAY_USER_PERSONA_LIMITS.name,
  },
  {
    key: 'relationship',
    label: 'キャラクターとの関係',
    placeholder: '例: 幼馴染 / 部下 / 初対面の旅人',
    maxLength: ROLEPLAY_USER_PERSONA_LIMITS.relationship,
  },
  {
    key: 'preferredAddress',
    label: '呼ばれ方',
    placeholder: '例: 先輩、名前の呼び捨て',
    maxLength: ROLEPLAY_USER_PERSONA_LIMITS.preferredAddress,
  },
  {
    key: 'knownFacts',
    label: 'キャラクターが知っていること',
    placeholder: '会話が始まる時点で相手が知っているあなたの情報',
    maxLength: ROLEPLAY_USER_PERSONA_LIMITS.knownFacts,
    rows: 3,
  },
];
