import type { ToolHandler, ToolHandlerContext, ToolHandlerResult } from "./types.ts";
import { sectionReadHandlers } from "./section-read-handlers.ts";
import { listHandlers } from "./list-handlers.ts";
import { previewHandlers } from "./preview-handlers.ts";
import { readAggregateHandlers } from "./read-aggregate-handlers.ts";
import { knowledgeHandlers } from "./knowledge-handlers.ts";
import { upsertHandlers } from "./upsert-handlers.ts";
import { mutateHandlers } from "./mutate-handlers.ts";
import { generateHandlers } from "./generate-handlers.ts";
import { brandWriteHandlers } from "./brand-write-handlers.ts";
import { competitorHandlers } from "./competitor-handlers.ts";
import { deleteHandlers } from "./delete-handlers.ts";
import { briefingHandlers } from "./briefing-handlers.ts";
import { historyHandlers } from "./history-handlers.ts";
import { batchHandlers } from "./batch-handlers.ts";
import { companyProfileHandlers } from "./company-profile-handlers.ts";
import { webDiscoveryHandlers } from "./web-discovery-handlers.ts";
import { socialHandlers } from "./social-handlers.ts";
import { aiWorkflowHandlers } from "./ai-workflow-handlers.ts";
import { platformExpressionHandlers } from "./platform-expression-handlers.ts";


const ALL_HANDLERS: Record<string, ToolHandler> = {
  ...sectionReadHandlers,
  ...listHandlers,
  ...previewHandlers,
  ...readAggregateHandlers,
  ...knowledgeHandlers,
  ...upsertHandlers,
  ...mutateHandlers,
  ...generateHandlers,
  ...brandWriteHandlers,
  ...competitorHandlers,
  ...deleteHandlers,
  ...briefingHandlers,
  ...historyHandlers,
  ...batchHandlers,
  ...companyProfileHandlers,
  ...webDiscoveryHandlers,
  ...socialHandlers,
  ...aiWorkflowHandlers,
  ...platformExpressionHandlers,
};


export async function dispatchTool(
  toolName: string,
  ctx: ToolHandlerContext,
): Promise<ToolHandlerResult | undefined> {
  const handler = ALL_HANDLERS[toolName];
  if (!handler) return undefined;
  return handler(ctx);
}
