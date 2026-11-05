import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const [pathArgument] = process.argv.slice(2);

if (!pathArgument) {
  console.error("Usage: node dist/index.js <path-to-database.db>");
  process.exit(1);
}

const dbPath = resolve(pathArgument);

if (!existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`);
  process.exit(1);
}

// Signals skip the "exit" event by default, and db-client.ts relies on it to
// kill running queries.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => process.exit());
}

await createServer(dbPath).connect(new StdioServerTransport());
