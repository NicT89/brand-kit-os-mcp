import { SESSION_TTL_MS } from "./constants.ts";
import { DEFAULT_LOG_LEVEL, type LogLevel } from "./notify.ts";

// In-memory sessions: each request is authenticated via API key; map is per isolate.
export const sessions = new Map<
  string,
  { userId: string; createdAt: number; logLevel: LogLevel }
>();

export function generateSessionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function cleanExpiredSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) sessions.delete(id);
  }
}

export function getSessionLogLevel(sessionId: string | null | undefined): LogLevel {
  if (!sessionId) return DEFAULT_LOG_LEVEL;
  return sessions.get(sessionId)?.logLevel ?? DEFAULT_LOG_LEVEL;
}
