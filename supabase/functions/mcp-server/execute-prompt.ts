import { formatPersonality } from "./ai-gateway.ts";
import { verifyBrandKitAccess } from "./brand-access.ts";
import { ACCESS_DENIED_RECOVERY, toolError } from "./tool-errors.ts";
import { validateUuidParam } from "./validation.ts";

export async function executePrompt(promptName: string, args: Record<string, string>, userId: string, supabaseAdmin: any) {
  const rawBk = args.brand_kit_id;
  let brandKitId: string | undefined;
  if (rawBk !== undefined && rawBk !== null && String(rawBk).trim() !== '') {
    const bkRes = validateUuidParam(rawBk, 'brand_kit_id');
    if (!('ok' in bkRes)) return bkRes;
    brandKitId = bkRes.value;
  }

  if (brandKitId) {
    const hasAccess = await verifyBrandKitAccess(brandKitId, userId, supabaseAdmin);
    if (!hasAccess) {
      return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
    }
  }

  switch (promptName) {
    case "social_profile_scrape_followup": {
      if (!brandKitId) {
        return toolError("brand_kit_id is required", {
          code: "validation_error",
          recovery: "Pass the brand_kit_id whose social profile scrape you started.",
        });
      }
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `A social profile scrape was started in the background for brand kit ${brandKitId} via request_social_profile_scrape. It usually finishes within ~45 seconds.\n\nInstructions:\n1. Do NOT block — keep helping the user with other things in the meantime.\n2. After about 90 seconds have passed, call get_brand_kit_social_profiles(brand_kit_id: "${brandKitId}").\n3. Check the relevant profile's "status": if it is "active", the scrape succeeded — read the populated fields. If still "pending", wait a little longer and check again. If "error", tell the user the scrape failed and offer to retry.\n4. Do not call request_social_profile_scrape again for the same profile while one is still pending.`,
            },
          },
        ],
      };
    }

    case "brand_voice_check": {
      const text = args.text;
      if (!brandKitId || !text) {
        return toolError("brand_kit_id and text are required", {
          code: "validation_error",
          recovery: "Pass brand_kit_id from list_brand_kits and the text to evaluate.",
        });
      }

      const [{ data: expression }, { data: personality }, { data: governance }] = await Promise.all([
        supabaseAdmin.from('brand_kit_expression').select('*').eq('brand_kit_id', brandKitId).maybeSingle(),
        supabaseAdmin.from('brand_kit_personality').select('*').eq('brand_kit_id', brandKitId).maybeSingle(),
        supabaseAdmin.from('brand_kit_governance').select('behavioral_constraints, writing_constraints').eq('brand_kit_id', brandKitId).maybeSingle(),
      ]);

      const resolvedPersonality = personality ? formatPersonality(personality) : null;

      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `You are a brand voice analyst. Evaluate the following text against this brand's voice guidelines and provide detailed feedback.\n\n## Brand Voice Guidelines\n\n### Expression & Tone\n${JSON.stringify(expression, null, 2)}\n\n### Personality\n${JSON.stringify(resolvedPersonality, null, 2)}\n\n### Governance Constraints\n${JSON.stringify(governance, null, 2)}\n\n## Text to Evaluate\n${text}\n\n## Instructions\n1. Rate overall brand voice alignment (1-10)\n2. Identify specific phrases that align well with the brand voice\n3. Identify phrases that deviate from the brand voice\n4. Provide specific rewrite suggestions for misaligned sections\n5. Check for governance constraint violations`,
            },
          },
        ],
      };
    }

    case "generate_brand_copy": {
      const { channel, topic } = args;
      if (!brandKitId || !channel || !topic) {
        return toolError("brand_kit_id, channel, and topic are required", {
          code: "validation_error",
          recovery: "Pass brand_kit_id from list_brand_kits plus channel (e.g. email) and topic.",
        });
      }

      const [{ data: bk }, { data: expression }, { data: personality }, { data: governance }, { data: audience }] = await Promise.all([
        supabaseAdmin.from('brand_kits').select('name, tagline, description, brand_voice').eq('id', brandKitId).maybeSingle(),
        supabaseAdmin.from('brand_kit_expression').select('*').eq('brand_kit_id', brandKitId).maybeSingle(),
        supabaseAdmin.from('brand_kit_personality').select('*').eq('brand_kit_id', brandKitId).maybeSingle(),
        supabaseAdmin.from('brand_kit_governance').select('*').eq('brand_kit_id', brandKitId).maybeSingle(),
        supabaseAdmin.from('brand_kit_target_audience').select('persona_name, persona_type, demographics, psychographics').eq('brand_kit_id', brandKitId),
      ]);

      const resolvedPersonality = personality ? formatPersonality(personality) : null;

      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `You are a brand copywriter for "${bk?.name || 'this brand'}". Generate on-brand marketing copy.\n\n## Brand Context\n- Name: ${bk?.name || ''}\n- Tagline: ${bk?.tagline || ''}\n- Voice: ${bk?.brand_voice || ''}\n\n## Tone & Expression\n${JSON.stringify(expression, null, 2)}\n\n## Personality\n${JSON.stringify(resolvedPersonality, null, 2)}\n\n## Governance Rules\n${JSON.stringify(governance, null, 2)}\n\n## Target Audience\n${JSON.stringify(audience, null, 2)}\n\n## Request\n- Channel: ${channel}\n- Topic: ${topic}\n\nGenerate 3 copy variations for the ${channel} channel about "${topic}". Each variation should reflect a slightly different aspect of the brand personality while staying within governance constraints. Include appropriate calls to action.`,
            },
          },
        ],
      };
    }

    case "brand_intro": {
      const format = args.format || "elevator_pitch";
      if (!brandKitId) {
        return toolError("brand_kit_id is required", {
          code: "validation_error",
          recovery: "Call list_brand_kits first and pass the id as brand_kit_id.",
        });
      }

      const [{ data: bk }, { data: core }, { data: personality }, { data: expression }] = await Promise.all([
        supabaseAdmin.from('brand_kits').select('name, tagline, description, brand_voice').eq('id', brandKitId).maybeSingle(),
        supabaseAdmin.from('brand_kit_core').select('*').eq('brand_kit_id', brandKitId).maybeSingle(),
        supabaseAdmin.from('brand_kit_personality').select('*').eq('brand_kit_id', brandKitId).maybeSingle(),
        supabaseAdmin.from('brand_kit_expression').select('tone_of_voice, tone_dimensions').eq('brand_kit_id', brandKitId).maybeSingle(),
      ]);

      const resolvedPersonality = personality ? formatPersonality(personality) : null;

      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `You are a brand strategist. Create a brand introduction in the "${format}" format.\n\n## Brand Identity\n- Name: ${bk?.name || ''}\n- Tagline: ${bk?.tagline || ''}\n- Description: ${bk?.description || ''}\n\n## Core Identity\n${JSON.stringify(core, null, 2)}\n\n## Personality\n${JSON.stringify(resolvedPersonality, null, 2)}\n\n## Tone\n${JSON.stringify(expression, null, 2)}\n\n## Format: ${format}\n${format === 'elevator_pitch' ? 'Write a compelling 30-second elevator pitch (2-3 sentences).' : format === 'bio' ? 'Write a professional bio suitable for social media profiles (150-300 characters).' : format === 'about_page' ? 'Write an About page section (2-3 paragraphs) that tells the brand story.' : 'Generate 5 tagline options that capture the brand essence.'}`,
            },
          },
        ],
      };
    }

    case "competitor_positioning": {
      if (!brandKitId) {
        return toolError("brand_kit_id is required", {
          code: "validation_error",
          recovery: "Call list_brand_kits first and pass the id as brand_kit_id.",
        });
      }

      const [{ data: bk }, { data: core }, { data: competitors }, { data: products }] = await Promise.all([
        supabaseAdmin.from('brand_kits').select('name, tagline, description').eq('id', brandKitId).maybeSingle(),
        supabaseAdmin.from('brand_kit_core').select('mission, vision').eq('brand_kit_id', brandKitId).maybeSingle(),
        supabaseAdmin.from('brand_kit_competitors').select('name, url, description, tagline, value_propositions, brand_personality, color_scheme').eq('brand_kit_id', brandKitId),
        supabaseAdmin.from('brand_kit_products').select('name, type, usp, description').eq('brand_kit_id', brandKitId),
      ]);

      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `You are a competitive strategy analyst. Analyze how this brand differentiates from its competitors.\n\n## Our Brand\n- Name: ${bk?.name || ''}\n- Tagline: ${bk?.tagline || ''}\n- Mission: ${core?.mission || ''}\n- Vision: ${core?.vision || ''}\n\n## Our Products\n${JSON.stringify(products, null, 2)}\n\n## Competitors\n${JSON.stringify(competitors, null, 2)}\n\n## Instructions\n1. Summarize each competitor's positioning\n2. Identify our unique differentiators\n3. Highlight positioning gaps and opportunities\n4. Recommend messaging angles that emphasize our strengths vs competitors\n5. Flag any areas where competitors have stronger positioning`,
            },
          },
        ],
      };
    }

    case "audience_persona_brief": {
      if (!brandKitId) {
        return toolError("brand_kit_id is required", {
          code: "validation_error",
          recovery: "Call list_brand_kits first and pass the id as brand_kit_id.",
        });
      }

      const { data: audience } = await supabaseAdmin
        .from('brand_kit_target_audience')
        .select('*')
        .eq('brand_kit_id', brandKitId);

      const filteredAudience = args.persona_name
        ? (audience || []).filter((a: any) => a.persona_name?.toLowerCase().includes(args.persona_name.toLowerCase()))
        : audience;

      const [{ data: bk }, { data: products }] = await Promise.all([
        supabaseAdmin.from('brand_kits').select('name, tagline').eq('id', brandKitId).maybeSingle(),
        supabaseAdmin.from('brand_kit_products').select('name, type, usp').eq('brand_kit_id', brandKitId),
      ]);

      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `You are a marketing strategist. Generate a concise persona brief for campaign planning.\n\n## Brand\n- Name: ${bk?.name || ''}\n- Tagline: ${bk?.tagline || ''}\n\n## Products\n${JSON.stringify(products, null, 2)}\n\n## Audience Data\n${JSON.stringify(filteredAudience, null, 2)}\n\n## Instructions\nFor each persona:\n1. One-sentence persona summary\n2. Key pain points and motivations\n3. Preferred channels and content formats\n4. Messaging hooks that would resonate\n5. Campaign angle recommendations`,
            },
          },
        ],
      };
    }

    case "create_target_audience": {
      const personaType = args.persona_type;
      const personaName = args.persona_name;
      if (!brandKitId || !personaType || !personaName) {
        return toolError("brand_kit_id, persona_type, and persona_name are required", {
          code: "validation_error",
          recovery: "Pass brand_kit_id from list_brand_kits, persona_type (b2b or b2c), and persona_name.",
        });
      }

      const { data: bk } = await supabaseAdmin
        .from('brand_kits')
        .select('name, tagline, description')
        .eq('id', brandKitId)
        .maybeSingle();

      const isB2B = personaType.toLowerCase() === 'b2b';

      return {
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: `You are a brand strategist building a target audience persona for ${bk?.name || 'this brand'}.

**Persona:** ${personaName}
**Type:** ${personaType.toUpperCase()}
**Brand Kit ID:** ${brandKitId}

Run a structured interview to gather persona information. Follow these rules exactly:

1. Ask ONE question at a time. Wait for the user's full answer before asking the next.
2. Keep questions conversational — not clinical or form-like.
3. After all questions are answered, summarize the full persona in a readable card format.
4. Ask: "Does this look right? Any corrections before I save it?"
5. If confirmed: call generate_audience_persona with brand_kit_id "${brandKitId}", persona_name "${personaName}", persona_type "${personaType}", and a detailed description field incorporating all gathered answers.
6. Do NOT call any write tools until the user explicitly says the summary is correct.

Interview questions (in order):
1. What age range and location are most common for this type of customer?
2. What's their job title or role? ${isB2B ? 'What size and type of company do they work at?' : 'What does their daily life look like?'}
3. What does their typical week look like — what are their main responsibilities or priorities?
4. What are their top 3 goals that ${bk?.name || 'this brand'} could help them achieve?
5. What frustrates them most right now? What's the biggest problem they can't solve?
6. Where do they go to find information or solutions — specific sites, communities, newsletters, influencers?
7. How do they make purchase decisions — who else is involved, how long does it take, what matters most?
8. If they could describe their ideal outcome in one sentence, what would it be?

Start with question 1 now.`
          }
        }]
      };
    }

    case "create_ai_persona_guided": {
      const personaName = args.persona_name;
      const purposeType = args.purpose_type;
      if (!brandKitId || !personaName || !purposeType) {
        return toolError("brand_kit_id, persona_name, and purpose_type are required", {
          code: "validation_error",
          recovery: "Pass brand_kit_id from list_brand_kits, persona_name, and purpose_type.",
        });
      }

      const { data: bk } = await supabaseAdmin
        .from('brand_kits')
        .select('name, brand_voice')
        .eq('id', brandKitId)
        .maybeSingle();

      return {
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: `You are an AI persona architect building a new AI persona for ${bk?.name || 'this brand'}.

**Persona Name:** ${personaName}
**Purpose:** ${purposeType}
**Brand Kit ID:** ${brandKitId}
**Brand Voice:** ${bk?.brand_voice || 'Not set'}

Run a structured interview. Ask ONE question at a time. Wait for answers.

After all questions are answered:
1. Show a structured summary of the full persona definition
2. Ask: "Does this look right before I save it?"
3. Only call generate_ai_persona after explicit user confirmation
4. Include all gathered context in the description field

Interview questions (in order):
1. In one sentence, what is ${personaName}'s primary job — what does it exist to do?
2. Who is it talking to? Describe the audience it will serve.
3. What are the 3 most important things it must always do in every interaction?
4. What are the 3 things it must never do, say, or imply — hard limits?
5. How should it sound? Pick 3 words that describe its tone (e.g. warm, direct, expert, playful).
6. Are there any specific phrases, terms, or formats it should always use?
7. Are there any topics, questions, or requests it should always redirect or decline?
8. How verbose should it be — short punchy responses, detailed explanations, or context-dependent?

Start with question 1 now.`
          }
        }]
      };
    }

    default:
      return { error: { code: -32602, message: `Unknown prompt: ${promptName}` } };
  }
}
