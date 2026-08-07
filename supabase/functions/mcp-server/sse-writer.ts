// Minimal SSE serializer over a ReadableStream controller. Tool handlers call
// `.notification()` to push `notifications/message` and `notifications/progress`
// events; the request loop calls `.write()` to send the final JSON-RPC envelope
// before closing the stream. Enqueue failures (client disconnected mid-call)
// are caught and flip an internal `closed` flag so subsequent writes no-op
// without throwing.

type StreamController = ReadableStreamDefaultController<Uint8Array>;

const encoder = new TextEncoder();

export class SseWriter {
  private closed = false;

  constructor(private controller: StreamController) {}

  notification(method: string, params: Record<string, unknown>): void {
    if (this.closed) return;
    const event = { jsonrpc: "2.0", method, params };
    this.enqueue(`data: ${JSON.stringify(event)}\n\n`);
  }

  write(envelope: unknown, id?: string | number): void {
    if (this.closed) return;
    const idLine = id !== undefined ? `id: ${id}\n` : "";
    this.enqueue(`${idLine}data: ${JSON.stringify(envelope)}\n\n`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.controller.close();
    } catch {
      // Already closed by client disconnect — ignore.
    }
  }

  isClosed(): boolean {
    return this.closed;
  }

  private enqueue(payload: string): void {
    try {
      this.controller.enqueue(encoder.encode(payload));
    } catch {
      this.closed = true;
    }
  }
}
