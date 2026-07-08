export function GeneratingLabel({ text = '生成中…' }: { text?: string }) {
  return (
    <span className="generating-label" role="status" aria-live="polite">
      <span className="generating-spinner" aria-hidden="true" />
      {text}
    </span>
  );
}
