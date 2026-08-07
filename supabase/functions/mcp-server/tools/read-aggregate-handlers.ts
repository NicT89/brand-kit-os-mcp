import type { ToolHandler } from "./types.ts";
import { readBrandKitHandlers } from "./read-brand-kit-handlers.ts";
import { readCompletenessHandlers } from "./read-completeness-handlers.ts";
import { readContextHandlers } from "./read-context-handlers.ts";

export const readAggregateHandlers: Record<string, ToolHandler> = {
  ...readBrandKitHandlers,
  ...readCompletenessHandlers,
  ...readContextHandlers,
};
