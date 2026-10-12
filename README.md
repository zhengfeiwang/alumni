# Alumni Grounding

An MCP server that gives LLM agents a read-oriented web loop: **search → open → find → click**. Modeled on OpenAI's o3 `web.run` tool contract, redesigned clean-room for the MCP ecosystem.

The authoritative contract is [docs/specs/grounding-tool-contract-spec.md](docs/specs/grounding-tool-contract-spec.md). Host integrators should also see [docs/host-prompt-snippet.md](docs/host-prompt-snippet.md).

## Requirements

- Node.js ≥ 20

## Install, build, run

```bash
npm install
npm run build
npm start          # serves MCP over stdio
```

### Registering with an MCP client

Example `claude_desktop_config.json` entry:

```json
{
  "mcpServers": {
    "alumni-grounding": {
      "command": "node",
      "args": ["/path/to/alumni/dist/index.js"],
      "env": { "BRAVE_API_KEY": "..." }
    }
  }
}
```

### Flags and environment

- `--allow-private-egress` — allow fetching loopback / RFC-1918 / link-local addresses. Denied by default (spec §8). Development use only.
- `BRAVE_API_KEY` — Brave Search API key. **Search is a stub in v0.1**: with or without the key, queries return a per-item `BACKEND_ERROR`. The `SearchBackend` interface (`src/search/backend.ts`) is the plug-in point for a real backend.

## Development

```bash
npm run dev        # tsx, no build step
npm test           # vitest unit tests (no network)
npm run smoke      # end-to-end check over stdio (spins up a local fixture
                   # server; runs the server with --allow-private-egress)
```

## Current limitations (v0.1)

- **Search backend is a stub.** The four-tool surface works; `search` returns structured `BACKEND_ERROR` results until a real backend lands.
- **No JS rendering.** Pages that need a headless browser fail with `EXTRACTION_FAILED`. The extension point is `src/engine/jsrender.ts` (Playwright deliberately not a dependency yet).
- Sessions are in-memory only; a restart ends all sessions (spec §7.1).

## Layout

```
src/
  index.ts          CLI entry (stdio transport, flags)
  server.ts         MCP tool registration (transport-independent)
  tools/            one module per tool (input schema + handler + description)
  session/          sessions, ref registry, windows (all state lives here)
  engine/           fetch (§8 policy), extract (Readability), render, pipeline
  search/           SearchBackend interface + Brave stub
test/               vitest, no network
scripts/smoke.mjs   end-to-end stdio check
```
