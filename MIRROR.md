# About this repository

This repository is a **one-way, generated mirror** of the Brand Kit OS MCP server.

- **Single source of truth:** the private Brand Kit OS monorepo. All code changes, review,
  tests, and deployment happen there.
- **What lives here:** the MCP server source (`supabase/functions/mcp-server/**`) and the small
  set of shared modules it imports (`supabase/functions/_shared/*.ts`), plus public docs, a
  registry manifest (`server.json`), and CI that type-checks and runs the contract tests.
- **How it updates:** on every server release, an automated job in the monorepo re-assembles this
  tree (stamping the current version, tool count, and endpoints) and opens a pull request here, which
  a maintainer reviews and merges — this repo is never pushed to directly. A PII/secret gate runs
  before every sync, so credentials and customer identifiers never reach this repo.

## Contributing

Because this is generated, **please do not open code PRs that edit files here** — they would be
overwritten on the next release. Instead:

- **Found a bug or have a question?** Open an issue. It's the right place and we watch it.
- **Have a fix?** Describe it in an issue; the change is applied upstream in the monorepo and flows
  back here on the next mirror.

## Running against the hosted server

This code is not self-hostable — it depends on the managed Brand Kit OS backend. See
[`README.md`](./README.md) to sign up and connect your AI client to the hosted endpoint.
