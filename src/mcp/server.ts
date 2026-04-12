#!/usr/bin/env node
// MCP server for Project Dispatcher — runs as a subprocess per agent run.
//
// Claude spawns this via the --mcp-config flag. It communicates with Claude
// over stdio (JSON-RPC). It opens the same SQLite database as the daemon
// and provides ticket-manipulation tools scoped to the specific run.
//
// Expected environment variables (set by the agent runner):
//   DISPATCH_RUN_ID      — UUID of the agent_runs row
//   DISPATCH_TICKET_ID   — UUID of the ticket the agent is working on
//   DISPATCH_PROJECT_ID  — UUID of the project
//   DISPATCH_AGENT_TYPE  — slug of the agent type (for author strings)
//   DISPATCH_DB_PATH     — path to the SQLite database file

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openDatabase } from '../db/index.js';
import { registerTools } from './tools.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    process.stderr.write(`Fatal: missing required env var ${name}\n`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const runId = requireEnv('DISPATCH_RUN_ID');
  const ticketId = requireEnv('DISPATCH_TICKET_ID');
  const projectId = requireEnv('DISPATCH_PROJECT_ID');
  const dbPath = requireEnv('DISPATCH_DB_PATH');
  // DISPATCH_AGENT_TYPE is optional (used for author strings, defaults in tools.ts)

  const db = openDatabase(dbPath);

  const server = new McpServer({
    name: 'project-dispatcher',
    version: '0.0.1',
  });

  registerTools(server, db, { runId, ticketId, projectId });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // The transport keeps the process alive until Claude disconnects.
  // On disconnect, clean up:
  transport.onclose = () => {
    db.close();
    process.exit(0);
  };
}

main().catch((err) => {
  process.stderr.write(`MCP server fatal: ${String(err)}\n`);
  process.exit(1);
});
