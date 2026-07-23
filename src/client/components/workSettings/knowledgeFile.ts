export async function decodeKnowledgeFile(file: File): Promise<string> {
  const lower = file.name.toLowerCase();
  if (!lower.endsWith('.md') && !lower.endsWith('.txt')) {
    throw new Error(`${file.name}: md / txt のみ追加できます`);
  }
  const buffer = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    const decoded = new TextDecoder('shift_jis').decode(buffer);
    const chars = [...decoded];
    const replacementCount = chars.filter((char) => char === '\uFFFD').length;
    const ratio = chars.length === 0 ? 0 : replacementCount / chars.length;
    if (ratio > 0.005) {
      throw new Error(`${file.name}: 文字コードを判定できませんでした`);
    }
    return decoded;
  }
}
