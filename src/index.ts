#!/usr/bin/env node
/**
 * CLI entry: stdio transport for the Alumni Grounding MCP server.
 *
 * Usage: alumni-grounding [--allow-private-egress]
 *
 * All protocol traffic is stdout; logs go to stderr.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createGroundingServer, SERVER_VERSION } from "./server.js";
import { BraveSearchBackend } from "./search/brave.js";

export interface CliOptions {
  allowPrivateEgress: boolean;
}

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { allowPrivateEgress: false };
  for (const arg of argv) {
    switch (arg) {
      case "--allow-private-egress":
        opts.allowPrivateEgress = true;
        break;
      case "-h":
      case "--help":
        process.stderr.write(
          [
            `alumni-grounding ${SERVER_VERSION} — MCP server for read-oriented web navigation`,
            "",
            "Usage: alumni-grounding [--allow-private-egress]",
            "",
            "Options:",
            "  --allow-private-egress  Allow fetching loopback/RFC-1918/link-local",
            "                          addresses (spec §8). Development use only.",
            "",
            "Environment:",
            "  BRAVE_API_KEY           Brave Search API key (search backend; v0.1 stub).",
            "",
          ].join("\n"),
        );
        process.exit(0);
        break;
      default:
        process.stderr.write(`Unknown argument: ${arg}\n`);
        process.exit(2);
    }
  }
  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  const { server, manager } = createGroundingServer({
    allowPrivateEgress: opts.allowPrivateEgress,
    searchBackend: new BraveSearchBackend(process.env.BRAVE_API_KEY),
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(
    `alumni-grounding ${SERVER_VERSION} listening on stdio ` +
      `(private egress ${opts.allowPrivateEgress ? "ALLOWED" : "denied"}; ` +
      `search backend: brave[stub])\n`,
  );

  const shutdown = () => {
    manager.close();
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void main();
}
