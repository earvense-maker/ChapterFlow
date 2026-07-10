import type { ReactNode } from 'react';

interface Props {
  text: string;
}

export default function LightMarkdown({ text }: Props) {
  const lines = text.replace(/\r/g, '').split('\n');
  const blocks: ReactNode[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (/^-{3,}$/.test(trimmed)) {
      blocks.push(<hr key={`hr-${index}`} />);
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const items: ReactNode[] = [];
      while (index < lines.length && /^[-*]\s+/.test(lines[index].trim())) {
        const item = lines[index].trim().replace(/^[-*]\s+/, '');
        items.push(<li key={`li-${index}`}>{renderInline(item, index)}</li>);
        index += 1;
      }
      index -= 1;
      blocks.push(<ul key={`ul-${index}`}>{items}</ul>);
      continue;
    }

    const heading = trimmed.match(/^#{1,4}\s+(.+)$/);
    if (heading) {
      blocks.push(
        <h3 className="light-markdown-heading" key={`heading-${index}`}>
          {renderInline(heading[1], index)}
        </h3>
      );
      continue;
    }

    blocks.push(<p key={`p-${index}`}>{renderInline(line, index)}</p>);
  }

  return <div className="light-markdown">{blocks}</div>;
}

function renderInline(text: string, lineIndex: number): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((part, index) =>
    part.startsWith('**') && part.endsWith('**') ? (
      <strong key={`${lineIndex}-${index}`}>{part.slice(2, -2)}</strong>
    ) : (
      part
    )
  );
}
