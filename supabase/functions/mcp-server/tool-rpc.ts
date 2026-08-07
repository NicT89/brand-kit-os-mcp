export function toolErrorToRpc(toolResult: any, extraData?: Record<string, unknown>) {
  if (!toolResult || toolResult.isError !== true) return null;
  const base = toolResult._meta && typeof toolResult._meta === "object" ? toolResult._meta : undefined;
  const mergedData = extraData
    ? { ...(base ?? {}), ...extraData }
    : base;
  return {
    error: {
      code: -32603,
      message: toolResult.content?.[0]?.text || "Resource read failed",
      data: mergedData || undefined,
    },
  };
}
