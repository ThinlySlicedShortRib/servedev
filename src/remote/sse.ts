/** Reading server-sent events from another servedev (its event and log streams). */

export interface SseEvent {
  event: string;
  data: string;
}

/** Splits a text stream into events; returns the unconsumed remainder. */
export function parseSse(buffer: string, onEvent: (e: SseEvent) => void): string {
  let i;
  while ((i = buffer.indexOf("\n\n")) !== -1) {
    const chunk = buffer.slice(0, i);
    buffer = buffer.slice(i + 2);
    let event = "message";
    const data: string[] = [];
    for (const line of chunk.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (data.length) onEvent({ event, data: data.join("\n") });
  }
  return buffer;
}

/** Reads a response's events until it ends. */
export async function readSse(res: Response, onEvent: (e: SseEvent) => void): Promise<void> {
  if (!res.body) return;
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buf = parseSse(buf + value, onEvent);
  }
}

export function sseChunk(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
