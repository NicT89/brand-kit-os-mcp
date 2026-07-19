// Live notifications for tool handlers: `ctx.log()` and `ctx.progress()`.
// Each handler call receives a fresh closure with its own throttle counters,
// so cross-call rate limits never starve one tool of notifications because
// another tool just sent some. Urgent log levels (warning+) and progress
// completion events bypass the throttle.

import type { SseWriter } from "./sse-writer.ts";

export type LogLevel =
  | "debug"
  | "info"
  | "notice"
  | "warning"
  | "error"
  | "critical"
  | "alert"
  | "emergency";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  notice: 2,
  warning: 3,
  error: 4,
  critical: 5,
  alert: 6,
  emergency: 7,
};

const URGENT_LEVELS = new Set<LogLevel>([
  "warning",
  "error",
  "critical",
  "alert",
  "emergency",
]);

const THROTTLE_MS = 100;
const LOG_DATA_MAX_BYTES = 8 * 1024;
const LOG_DATA_PREVIEW_CHARS = 500;

export const DEFAULT_LOG_LEVEL: LogLevel = "info";

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && value in LEVEL_ORDER;
}

export function meetsLevel(level: LogLevel, minLevel: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];
}

function truncateLogData(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return { _truncated: true, _reason: "not_serializable" };
  }
  if (json.length <= LOG_DATA_MAX_BYTES) return value;
  return {
    _truncated: true,
    _original_size: json.length,
    _preview: json.slice(0, LOG_DATA_PREVIEW_CHARS),
  };
}

export interface NotifyContext {
  log: (level: LogLevel, message: string, data?: unknown) => Promise<void>;
  progress: (current: number, total?: number, message?: string) => Promise<void>;
}

export const NOOP_NOTIFY: NotifyContext = {
  log: async () => {},
  progress: async () => {},
};

export function buildNotifyContext(opts: {
  writer: SseWriter | null;
  requestId: string;
  progressToken: string | number | undefined;
  sessionLogLevel: LogLevel;
}): NotifyContext {
  let lastLog = 0;
  let lastProgress = 0;
  return {
    log: async (level, message, data) => {
      if (!opts.writer || opts.writer.isClosed()) return;
      if (!meetsLevel(level, opts.sessionLogLevel)) return;
      const urgent = URGENT_LEVELS.has(level);
      const now = Date.now();
      if (!urgent && now - lastLog < THROTTLE_MS) return;
      lastLog = now;
      const params: Record<string, unknown> = {
        level,
        logger: "mcp-server",
        data: message,
      };
      if (data !== undefined) params.meta = truncateLogData(data);
      opts.writer.notification("notifications/message", params);
    },
    progress: async (current, total, message) => {
      if (!opts.writer || opts.writer.isClosed()) return;
      const isComplete = total !== undefined && current >= total;
      const now = Date.now();
      if (!isComplete && now - lastProgress < THROTTLE_MS) return;
      lastProgress = now;
      const params: Record<string, unknown> = {
        progressToken: opts.progressToken ?? opts.requestId,
        progress: current,
      };
      if (total !== undefined) params.total = total;
      if (message !== undefined) params.message = message;
      opts.writer.notification("notifications/progress", params);
    },
  };
}
