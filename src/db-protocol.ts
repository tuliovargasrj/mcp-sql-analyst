/** Messages exchanged between the server and the database process. */

export type DbOperation =
  | { op: "list_tables" }
  | { op: "describe_table"; table: string }
  | { op: "run_query"; sql: string };

export type DbRequest = DbOperation & { dbPath: string };

export type DbResponse = { ok: true; result: unknown } | { ok: false; error: string };
