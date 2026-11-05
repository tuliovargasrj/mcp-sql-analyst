/**
 * Entry point of the disposable process that `db-client.ts` starts for each
 * database operation. It handles one request, replies, and exits.
 */
import { describeTable, listTables, openReadOnly, runQuery } from "./db.js";
import type { DbRequest, DbResponse } from "./db-protocol.js";

function handleRequest(request: DbRequest): unknown {
  const db = openReadOnly(request.dbPath);

  switch (request.op) {
    case "list_tables":
      return listTables(db);
    case "describe_table":
      return describeTable(db, request.table);
    case "run_query":
      return runQuery(db, request.sql);
  }
}

process.once("message", (request: DbRequest) => {
  let response: DbResponse;
  try {
    response = { ok: true, result: handleRequest(request) };
  } catch (error) {
    response = { ok: false, error: (error as Error).message };
  }
  process.send?.(response, () => process.exit(0));
});
