import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callDatabase } from "./db-client.js";
import type { DbOperation } from "./db-protocol.js";
import { MAX_ROWS, MAX_SQL_CHARS, QUERY_TIMEOUT_MS, SAMPLE_ROW_COUNT } from "./limits.js";

const READ_ONLY_TOOL = { readOnlyHint: true, openWorldHint: false };

export function createServer(dbPath: string): McpServer {
  const server = new McpServer({ name: "mcp-sql-analyst", version: "0.1.0" });

  // McpServer turns any error thrown here into a tool error for the client.
  const respondWith = async (operation: DbOperation) => {
    const result = await callDatabase({ dbPath, ...operation });
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  };

  server.registerTool(
    "list_tables",
    {
      description: "List every table and view, with row counts for tables.",
      annotations: READ_ONLY_TOOL,
    },
    () => respondWith({ op: "list_tables" }),
  );

  server.registerTool(
    "describe_table",
    {
      description:
        `Show a table's columns, foreign keys, and ${SAMPLE_ROW_COUNT} sample rows. ` +
        "Call this before writing a query.",
      inputSchema: { table: z.string().min(1).max(256) },
      annotations: READ_ONLY_TOOL,
    },
    ({ table }) => respondWith({ op: "describe_table", table }),
  );

  server.registerTool(
    "run_query",
    {
      description:
        `Run one read-only SQLite SELECT statement. Returns at most ${MAX_ROWS} rows ` +
        `and stops after ${QUERY_TIMEOUT_MS / 1000} seconds. ` +
        "Each row is an array aligned with `columns`. " +
        "If `truncated` is true, the result is incomplete: aggregate or filter instead.",
      inputSchema: { sql: z.string().min(1).max(MAX_SQL_CHARS) },
      annotations: READ_ONLY_TOOL,
    },
    ({ sql }) => respondWith({ op: "run_query", sql }),
  );

  return server;
}
