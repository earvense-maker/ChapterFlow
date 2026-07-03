export async function* readServerSentEvents(
  body: ReadableStream<Uint8Array> | null
): AsyncGenerator<string> {
  if (!body) throw new Error('Streaming response body is empty');

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    yield* drainEventBuffer(buffer, (next) => {
      buffer = next;
    });
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    yield* parseEventBlock(buffer);
  }
}

function* drainEventBuffer(
  buffer: string,
  updateBuffer: (buffer: string) => void
): Generator<string> {
  let current = buffer;
  while (true) {
    const normalized = current.replace(/\r\n/g, '\n');
    const index = normalized.indexOf('\n\n');
    if (index < 0) {
      updateBuffer(current);
      return;
    }

    const block = normalized.slice(0, index);
    yield* parseEventBlock(block);
    current = normalized.slice(index + 2);
  }
}

function* parseEventBlock(block: string): Generator<string> {
  const dataLines = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart());

  if (dataLines.length > 0) {
    yield dataLines.join('\n');
  }
}
