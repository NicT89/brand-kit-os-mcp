# Brand Kit OS — MCP Server

**Give ChatGPT, Claude, and Cursor structured, governed access to your brand.**

Brand Kit OS MCP is a hosted [Model Context Protocol](https://modelcontextprotocol.io) server
that exposes **82 tools** for reading and writing your brand voice, audience, personas,
messaging, governance rules, knowledge files, and visual identity — so AI output stays on-brand,
every time, across every tool.

- **Server version:** `v1.5.0` · MCP protocol `2024-11-05`
- **Remote endpoint:** `https://www.brandkitos.com/mcp`
- **Auth:** OAuth 2.0 (recommended) or API key (`Authorization: Bearer bk_...`)

---

## ⚠️ This is a hosted server, not a self-hostable package

The code in this repository is published for **transparency and validation** — so you (and the
tools that list us) can review exactly what each tool does, how access is scoped, and how your
data is handled **before** you connect.

It runs **only against the managed Brand Kit OS backend** (its database, auth, storage, and
hosted services). It **cannot be cloned and run on your own infrastructure**. To use it, sign up
for Brand Kit OS and connect your AI client to the hosted endpoint below. See
[`MIRROR.md`](./MIRROR.md) for how this repository is produced and kept in sync.

---

## Quick start

### 1. Create a Brand Kit OS account
Sign up at **https://www.brandkitos.com**, then build or import at least one brand kit.

### 2. Get your MCP credentials
In the app, open **Settings → Integrations / MCP** and either:
- start the **OAuth** connection from your AI client (recommended — no key to manage), or
- generate a scoped **API key** (`bk_...`) with the read/write scopes you want to grant.

### 3. Connect your AI client to the remote endpoint

```
https://www.brandkitos.com/mcp
```

<details>
<summary><b>Claude</b> (claude.ai / Claude Desktop)</summary>

**Settings → Connectors → Add custom connector**, paste `https://www.brandkitos.com/mcp`, and complete the
OAuth sign-in. Your granted brand kits and tools appear automatically.
</details>

<details>
<summary><b>ChatGPT</b> (Developer mode / custom connectors)</summary>

Add a custom MCP connector pointing at `https://www.brandkitos.com/mcp` and authenticate. If you use an API key
instead of OAuth, supply it as an `Authorization: Bearer bk_...` header.
</details>

<details>
<summary><b>Cursor</b></summary>

Add to `~/.cursor/mcp.json`:

```jsonc
{
  "mcpServers": {
    "brand-kit-os": {
      "url": "https://www.brandkitos.com/mcp",
      "headers": { "Authorization": "Bearer bk_your_api_key" }
    }
  }
}
```
</details>

---

## What you can do

The catalog spans read, write, generate, and preview tools. Highlights:

| Area | Example tools |
|------|---------------|
| **Read brand context** | `get_brand_context_for_agent`, `get_brand_kit`, `get_agent_briefing`, `get_persona_system_prompt` |
| **Section reads** | `get_brand_kit_core` / `_personality` / `_expression` / `_governance` / `_audience` / `_seo` / `_visuals` |
| **Write / upsert** | `upsert_brand_kit_core` / `_personality` / `_expression` / `_governance` / `_seo`, `update_brand_kit` |
| **CRUD** | products, audience personas, brand personas, competitors, expression examples, logo & knowledge files |
| **AI generation** | `generate_audience_persona`, `generate_ai_persona`, `generate_disclosure_statement` |
| **Safe previews** | `preview_brand_kit_*_update`, `preview_generate_*` (dry-run, no writes, no token spend) |
| **Discovery** | `list_brand_kits`, `list_brand_kit_tools`, `list_governance_platforms` |

The **live, authoritative catalog** is always available at runtime via `list_brand_kit_tools`,
and documented at **https://www.brandkitos.com/mcp-documentation**.

## Access, scopes & safety

- Every **write** requires an API key scoped to the section (`brand_kit:write:<section>`) **and**
  verified membership on the target brand kit.
- Write tools accept **`dry_run`** to preview the exact change first; destructive tools require a
  **two-step confirmation**.
- All writes are **audit-logged** server-side.
- Reads are gated by the same brand-kit membership checks the app uses.

## Versioning

The server is versioned with `SERVER_VERSION` (currently `v1.5.0`). Client tool caches are
keyed to it — reconnect (or the version bump) refreshes the tool list. See
[`CHANGELOG.md`](./CHANGELOG.md). This repository is re-published on every server release.

## This repository

This is a **read-only mirror generated from the Brand Kit OS monorepo** (the single source of
truth). Do not open code PRs against files here — see [`MIRROR.md`](./MIRROR.md) for how fixes
are made upstream and flow back. **Bug reports and questions are welcome** via the issue tracker.

## Support

- Product, docs & sign-up: **https://www.brandkitos.com**
- Tool reference: **https://www.brandkitos.com/mcp-documentation**
- Issues: this repository's tracker

## License

MIT © RealBlockAI — see [`LICENSE`](./LICENSE).
