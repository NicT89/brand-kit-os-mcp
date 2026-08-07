import { AI_GATEWAY_TIMEOUT_MS } from "./constants.ts";

// Personality fields are returned under their DB-native names
// (`personality_traits`, `brand_values`, `brand_principles`, `brand_moods`).
// Earlier versions of this function also exposed short aliases (`traits`,
// `values`, `principles`, `moods`) which doubled response payload size for
// no benefit — no consumer read the aliased keys.
export function formatPersonality(data: Record<string, unknown>) {
  return { ...data };
}

export async function callAIGateway(systemPrompt: string, userPrompt: string): Promise<unknown> {
  const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");
  if (!lovableApiKey) throw new Error("LOVABLE_API_KEY is not configured");

  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), AI_GATEWAY_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${lovableApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
      signal: controller.signal,
    });
  } catch (err: unknown) {
    clearTimeout(abortTimer);
    if ((err as { name?: string })?.name === "AbortError") {
      throw new Error(`AI gateway request timed out after ${Math.round(AI_GATEWAY_TIMEOUT_MS / 1000)}s`);
    }
    throw err;
  }
  clearTimeout(abortTimer);

  if (!response.ok) {
    if (response.status === 429) throw new Error("AI rate limit exceeded. Please try again later.");
    throw new Error(`AI gateway error: ${response.status}`);
  }

  const aiData = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = aiData.choices?.[0]?.message?.content || "";
  const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  return JSON.parse(cleaned);
}
