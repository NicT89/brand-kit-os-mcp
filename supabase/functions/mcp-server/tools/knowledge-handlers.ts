import type { ToolHandler } from "./types.ts";
import { ACCESS_DENIED_RECOVERY, SCOPE_DENIED_RECOVERY, toolError } from "../tool-errors.ts";
import { AI_GATEWAY_TIMEOUT_MS, WRITE_SCOPE } from "../constants.ts";
import { assertBrandKitMcpWriteAllowed, assertMcpWriteConfirmation, validateUuidParam } from "../validation.ts";
import { verifyBrandKitAccess } from "../brand-access.ts";

export const knowledgeHandlers: Record<string, ToolHandler> = {
  list_logo_assets: async (ctx) => {
    const { args, userId, supabaseAdmin, scopes } = ctx;
          const { brand_kit_id } = args;
          if (!brand_kit_id) return toolError("brand_kit_id is required", { code: "validation_error", recovery: "Pass the UUID returned by list_brand_kits as the brand_kit_id argument." });
          const hasAccess = await verifyBrandKitAccess(brand_kit_id, userId, supabaseAdmin);
          if (!hasAccess) return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
          const { data, error } = await supabaseAdmin.from('brand_kit_logo_assets')
            .select('id, asset_key, label, url, description, long_description, usage_guidelines, image_width, image_height, file_type, is_default, sort_order, created_at')
            .eq('brand_kit_id', brand_kit_id)
            .order('sort_order', { ascending: true });
          if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", retryable: true });
          return { content: [{ type: "text", text: JSON.stringify(data || [], null, 2) }] };
  },

  get_logo_asset: async (ctx) => {
    const { args, userId, supabaseAdmin, scopes } = ctx;
          const { asset_id: rawAssetId } = args;
          const assetRes = validateUuidParam(rawAssetId, 'asset_id');
          if (!('ok' in assetRes)) return assetRes;
          const asset_id = assetRes.value;
    
          const { data, error } = await supabaseAdmin
            .from('brand_kit_logo_assets')
            .select('*')
            .eq('id', asset_id)
            .maybeSingle();
    
          if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", retryable: true });
          if (!data) return toolError("Asset not found", { code: "not_found", recovery: "Verify the asset_id by calling list_logo_assets for the relevant brand kit." });
    
          const hasAccess = await verifyBrandKitAccess(data.brand_kit_id, userId, supabaseAdmin);
          if (!hasAccess) return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
    
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },

  list_knowledge_files: async (ctx) => {
    const { args, userId, supabaseAdmin, scopes } = ctx;
          const { brand_kit_id, category, platform_context, tags } = args as {
            brand_kit_id?: string; category?: string; platform_context?: string; tags?: string[];
          };
          if (!brand_kit_id) return toolError("brand_kit_id is required", { code: "validation_error", recovery: "Pass the UUID returned by list_brand_kits as the brand_kit_id argument." });
          const hasAccess = await verifyBrandKitAccess(brand_kit_id, userId, supabaseAdmin);
          if (!hasAccess) return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
          let query = supabaseAdmin
            .from('user_knowledge_file_uploads')
            .select('id, title, original_file_name, description, relevance_hint, file_type, tags, category, sensitivity, department, version, source, platform_context, created_at')
            .eq('brand_kit_id', brand_kit_id)
            .order('created_at', { ascending: false });
          if (category) query = query.eq('category', category);
          if (platform_context) query = query.eq('platform_context', platform_context);
          const { data, error } = await query;
          if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", retryable: true });
          // Post-filter by tags (jsonb ANY-match) since PostgREST jsonb array overlap is awkward
          let filtered = data ?? [];
          if (Array.isArray(tags) && tags.length) {
            const wanted = tags.map((t) => String(t).toLowerCase());
            filtered = filtered.filter((row: Record<string, unknown>) => {
              const rowTags = Array.isArray(row.tags) ? (row.tags as unknown[]).map((t) => String(t).toLowerCase()) : [];
              return wanted.some((w) => rowTags.includes(w));
            });
          }
          return { content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }] };
  },

  get_knowledge_file: async (ctx) => {
    const { args, userId, supabaseAdmin, scopes } = ctx;
          const { file_id: rawFileId } = args;
          const fileRes = validateUuidParam(rawFileId, 'file_id');
          if (!('ok' in fileRes)) return fileRes;
          const file_id = fileRes.value;
          const { data, error } = await supabaseAdmin.from('user_knowledge_file_uploads').select('*').eq('id', file_id).maybeSingle();
          if (error) return toolError(`Database error: ${error.message}`, { code: "db_error", retryable: true });
          if (!data) return toolError("Knowledge file not found", { code: "not_found", recovery: "Verify the file_id by calling list_knowledge_files for the relevant brand kit." });
          const hasAccess = await verifyBrandKitAccess(data.brand_kit_id, userId, supabaseAdmin);
          if (!hasAccess) return toolError("Access denied to this knowledge file", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
    
          let file_content: string | null = null;
          if (data.extracted_data) {
            file_content = typeof data.extracted_data === 'string' ? data.extracted_data : JSON.stringify(data.extracted_data);
          } else if (data.storage_path && (data.file_type === 'markdown' || data.file_type === 'json')) {
            const { data: fileBlob, error: downloadError } = await supabaseAdmin.storage
              .from('user-knowledge-files')
              .download(data.storage_path);
            if (!downloadError && fileBlob) {
              file_content = await fileBlob.text();
            }
          }
    
          const result = { ...data, file_content };
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },

  upload_knowledge_file: async (ctx) => {
    const { args, userId, supabaseAdmin, scopes } = ctx;
          if (!scopes.includes(WRITE_SCOPE)) {
            return toolError(`This tool requires the '${WRITE_SCOPE}' scope. Mint a new API key with write access to use it.`, { code: "scope_denied", recovery: SCOPE_DENIED_RECOVERY(WRITE_SCOPE) });
          }
          const {
            brand_kit_id,
            title,
            original_file_name,
            file_type,
            content,
            description,
            relevance_hint,
            tags,
            department,
            category,
            platform_context,
            sensitivity,
            audience,
            version,
            source,
            attribution,
            related_projects,
          } = args;
          if (!brand_kit_id || !title || !file_type || !content) {
            return toolError("brand_kit_id, title, file_type, and content are required", { code: "validation_error" });
          }
          if (typeof original_file_name !== 'string' || !original_file_name.trim()) {
            return toolError("original_file_name is required and must be a non-empty string (e.g. 'brand-guidelines.pdf').", { code: "validation_error", recovery: "Pass the original source filename, including its extension, as `original_file_name`." });
          }
          if (!['markdown', 'json', 'pdf'].includes(file_type)) {
            return toolError("file_type must be one of: markdown, json, pdf", { code: "validation_error" });
          }
          const hasAccess = await verifyBrandKitAccess(brand_kit_id, userId, supabaseAdmin);
          if (!hasAccess) return toolError("Access denied to this brand kit", { code: "access_denied", recovery: ACCESS_DENIED_RECOVERY });
          const mcpWriteGate = await assertBrandKitMcpWriteAllowed(brand_kit_id, userId, supabaseAdmin);
          if (mcpWriteGate) return mcpWriteGate;
          const confirmGate = await assertMcpWriteConfirmation(args, userId, supabaseAdmin);
          if (confirmGate) return confirmGate;
    
          let bytes: Uint8Array;
          let mime: string;
          let extension: string;
          if (file_type === 'pdf') {
            try {
              const binary = atob(content);
              bytes = new Uint8Array(binary.length);
              for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            } catch {
              return toolError("content must be base64-encoded for pdf uploads", { code: "validation_error", recovery: "Encode the PDF binary as base64 (without truncation) before passing it as the `content` argument." });
            }
            mime = 'application/pdf';
            extension = 'pdf';
          } else if (file_type === 'json') {
            bytes = new TextEncoder().encode(content);
            mime = 'application/json';
            extension = 'json';
          } else {
            bytes = new TextEncoder().encode(content);
            mime = 'text/markdown';
            extension = 'md';
          }
    
          const safeTitle = title.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled';
          const now = new Date();
          const storagePath = `${brand_kit_id}/${userId}/mcp/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${Date.now()}-${safeTitle}.${extension}`;
          // Mirror the app's KnowledgeFileUploadWizard doc-id format (DOC-YYYY-MM-XXXX) so
          // MCP-uploaded files participate in the same doc-id system as UI uploads.
          const docId = `DOC-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;

          const { error: uploadError } = await supabaseAdmin.storage
            .from('user-knowledge-files')
            .upload(storagePath, bytes, { contentType: mime, upsert: false });
          if (uploadError) return toolError(`Storage upload failed: ${uploadError.message}`, { code: "db_error", retryable: true });
    
          const { data: row, error: insertError } = await supabaseAdmin
            .from('user_knowledge_file_uploads')
            .insert({
              brand_kit_id,
              user_id: userId,
              title,
              original_file_name: original_file_name.trim(),
              description: description ?? null,
              relevance_hint: relevance_hint ?? null,
              file_type,
              storage_path: storagePath,
              tags: Array.isArray(tags) ? tags : [],
              department: department ?? null,
              category: category ?? null,
              platform_context: platform_context ?? null,
              sensitivity: sensitivity ?? null,
              audience: audience ?? null,
              version: version ?? null,
              attribution: attribution ?? null,
              related_projects: Array.isArray(related_projects) ? related_projects : null,
              file_size_bytes: bytes.byteLength,
              source: source ?? 'mcp',
              doc_id: docId,
              // MCP uploads are user-directed uploads of real documents, not AI-auto-generated baseline docs.
              is_ai_generated_metadata: false,
            })
            .select('id, title, doc_id, file_type, storage_path, created_at')
            .single();
    
          if (insertError) {
            await supabaseAdmin.storage.from('user-knowledge-files').remove([storagePath]);
            return toolError(`Database insert failed: ${insertError.message}`, { code: "db_error", retryable: true });
          }
    
          return { content: [{ type: "text", text: JSON.stringify({ success: true, file: row }, null, 2) }] };
  },
};
