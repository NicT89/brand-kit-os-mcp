# Changelog

All notable changes to the Brand Kit OS MCP server are recorded here. Versions track
`SERVER_VERSION` in the server. This repository is a generated mirror; releases are cut
from the Brand Kit OS monorepo (see [`MIRROR.md`](./MIRROR.md)).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.7.0]

### Added

- Two platform-expression tools: `get_platform_expression`, which returns the
  per-platform voice overrides for one brand kit and platform, and
  `list_platform_expressions`, which lists the platforms that have overrides.
  Together they expose the per-platform layer over the global voice returned by
  `get_brand_kit_expression`.

### Fixed

- `WWW-Authenticate` is now listed in `Access-Control-Expose-Headers`, so a
  browser-based client can actually read the `resource_metadata` pointer in the
  401 challenge. The header was always sent, but CORS hid it from `fetch()`,
  breaking OAuth discovery for browser clients.

## [1.6.0]

### Added

- Eight AI-workflow delegate tools, giving an agent parity with the app's
  Personas & Audience and Current customers actions: `scrape_brand_kit_website`,
  `detect_target_audiences`, `generate_target_audience`, `enrich_audience_persona`,
  `detect_brand_kit_customers`, `scrape_customer_profile`, `enrich_company_profile`
  and `generate_company_icp`. Each is scoped, credit-metered and follows the
  `dry_run` → `confirm` contract.

## [1.7.0]

- Current published server release. Exposes 96 tools over the remote endpoint
  `https://www.brandkitos.com/mcp` (MCP protocol `2024-11-05`), with OAuth 2.0 and scoped API-key auth.

> Earlier history lived in the monorepo prior to this repository being published. Future
> releases will each get their own entry here as the mirror is re-published.
