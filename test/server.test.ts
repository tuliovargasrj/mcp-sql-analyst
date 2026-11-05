import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { authorizeReadsOnly, openReadOnly, runQuery } from "../src/db.js";
import {
  MAX_CELL_CHARS,
  MAX_RESULT_CHARS,
  MAX_ROWS,
  MAX_SQL_CHARS,
  QUERY_TIMEOUT_MS,
  SAMPLE_ROW_COUNT,
} from "../src/limits.js";
import { createSampleDb } from "../src/seed.js";

/** Allows for the JSON around the rows, which the result limit does not count. */
const RESPONSE_OVERHEAD_CHARS = 1_000;

const INFINITE_NUMBERS =
  "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n)";

let folder: string;
let dbPath: string;
let dbBytesAtStart: Buffer;
let client: Client;

async function callTool(
  name: string,
  args: Record<string, unknown> = {},
  target: Client = client,
) {
  const result = await target.callTool({ name, arguments: args });
  const [content] = result.content as { text: string }[];
  return { isError: result.isError === true, text: content?.text ?? "" };
}

async function callToolOk(
  name: string,
  args: Record<string, unknown> = {},
  target: Client = client,
) {
  const { isError, text } = await callTool(name, args, target);
  expect(isError, text).toBe(false);
  return JSON.parse(text);
}

const query = (sql: string) => callToolOk("run_query", { sql });

/**
 * Starts a separate server for one test, running `preload` before its own code.
 * The server and its database processes all load it, and only the database
 * processes have `process.send`, so a preload can change how one of them behaves.
 */
async function startServerWith(preload: string) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js", dbPath],
    env: {
      NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(preload)}`,
    },
  });
  const connection = new Client({ name: "preload-client", version: "1.0.0" });
  await connection.connect(transport);
  onTestFinished(() => connection.close());

  return { connection, serverPid: transport.pid as number };
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  folder = mkdtempSync(join(tmpdir(), "mcp-sql-analyst-"));
  dbPath = join(folder, "sample.db");
  createSampleDb(dbPath);

  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE VIEW brazilian_customers AS
      SELECT * FROM customers WHERE country = 'Brazil';
    CREATE TABLE measurements (id INTEGER PRIMARY KEY, reading INTEGER);
    INSERT INTO measurements VALUES (1, 9007199254740993);
    CREATE TABLE "odd ""name" (id INTEGER PRIMARY KEY);
    INSERT INTO "odd ""name" VALUES (1);
  `);
  db.close();
  dbBytesAtStart = readFileSync(dbPath);

  client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({ command: "node", args: ["dist/index.js", dbPath] }),
  );
});

afterAll(async () => {
  await client.close();
  rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("tools", () => {
  it("exposes exactly three read-only tools", async () => {
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "describe_table",
      "list_tables",
      "run_query",
    ]);
    expect(tools.every((tool) => tool.annotations?.readOnlyHint)).toBe(true);
  });

  it("lists tables with row counts, and views without them", async () => {
    const entries = await callToolOk("list_tables");

    expect(entries).toContainEqual({ name: "customers", type: "table", rowCount: 200 });
    expect(entries).toContainEqual({
      name: "brazilian_customers",
      type: "view",
      rowCount: null,
    });
  });

  it("describes columns, foreign keys, and sample rows", async () => {
    const info = await callToolOk("describe_table", { table: "orders" });

    expect(info.columns.map((column: { name: string }) => column.name)).toEqual([
      "id",
      "customer_id",
      "order_date",
      "status",
    ]);
    expect(info.columns[0]).toMatchObject({ primaryKey: true });
    expect(info.foreignKeys).toContainEqual({
      column: "customer_id",
      references: "customers.id",
    });
    expect(info.sampleRows).toHaveLength(SAMPLE_ROW_COUNT);
  });

  it("describes a view", async () => {
    const info = await callToolOk("describe_table", { table: "brazilian_customers" });
    expect(info.columns).toHaveLength(3);
  });

  it("applies the safe read path to sample rows", async () => {
    const info = await callToolOk("describe_table", { table: "measurements" });
    expect(info.sampleRows).toEqual([[1, "9007199254740993"]]);
  });

  it("quotes table names that contain spaces and double quotes", async () => {
    const table = 'odd "name';
    const info = await callToolOk("describe_table", { table });

    expect(info.sampleRows).toEqual([[1]]);
    expect(await callToolOk("list_tables")).toContainEqual({
      name: table,
      type: "table",
      rowCount: 1,
    });
  });

  it("treats a malicious table name as an unknown table", async () => {
    const result = await callTool("describe_table", {
      table: 'orders"; DROP TABLE orders; --',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Unknown table");
  });

  it("runs a join with aggregation", async () => {
    const { columns, rows } = await query(`
      SELECT p.category, SUM(i.quantity * p.price) AS revenue
      FROM order_items i JOIN products p ON p.id = i.product_id
      GROUP BY p.category ORDER BY revenue DESC`);

    expect(columns).toEqual(["category", "revenue"]);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows[0][1]).toBeGreaterThan(rows.at(-1)[1]);
  });

  it("keeps both columns when a join repeats a column name", async () => {
    const { columns, rows } = await query(`
      SELECT c.id, o.id FROM customers c
      JOIN orders o ON o.customer_id = c.id
      WHERE o.id = 1`);

    expect(columns).toEqual(["id", "id"]);
    expect(rows[0]).toHaveLength(2);
    expect(rows[0][1]).toBe(1);
  });

  it("reports SQL mistakes as tool errors", async () => {
    const result = await callTool("run_query", { sql: "SELECT nope FROM customers" });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("no such column");
  });
});

describe("safety", () => {
  const rejectedStatements = [
    "INSERT INTO customers VALUES (9999, 'x', 'y')",
    "UPDATE customers SET name = 'x'",
    "DELETE FROM orders",
    "DROP TABLE orders",
    "CREATE TABLE stolen (a)",
    "WITH doomed AS (SELECT 1) DELETE FROM orders",
    "REPLACE INTO customers VALUES (1, 'x', 'y')",
    "PRAGMA writable_schema = ON",
    "PRAGMA journal_mode = DELETE",
    "VACUUM",
    "SELECT load_extension('anything')",
  ];

  it.each(rejectedStatements)("rejects: %s", async (sql) => {
    expect((await callTool("run_query", { sql })).isError).toBe(true);
  });

  it("leaves the database file unchanged after those attempts", () => {
    expect(readFileSync(dbPath).equals(dbBytesAtStart)).toBe(true);
  });

  it("blocks writes at the connection, without the authorizer", () => {
    const db = openReadOnly(dbPath);
    db.setAuthorizer(null);

    expect(() => db.exec("DELETE FROM orders")).toThrow("readonly");
    db.close();
  });

  it("blocks writes in the authorizer, without a read-only connection", () => {
    const writablePath = join(folder, "writable.db");
    copyFileSync(dbPath, writablePath);
    const db = new DatabaseSync(writablePath);
    db.setAuthorizer(authorizeReadsOnly);

    expect(() => runQuery(db, "DELETE FROM orders")).toThrow("read-only");
    db.setAuthorizer(null);
    expect(db.prepare("SELECT count(*) AS total FROM orders").get()).toEqual({
      total: 2_000,
    });
    db.close();
  });

  it("cannot read another database through ATTACH", async () => {
    const otherPath = dbPath.replaceAll("\\", "/");
    const result = await callTool("run_query", {
      sql: `ATTACH DATABASE '${otherPath}' AS other`,
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("read-only");
  });

  it.each([
    "SELECT 1; DELETE FROM orders",
    "SELECT 1; SELECT 2",
    "SELECT 1; -- trailing comment",
  ])("rejects anything after the first statement: %s", async (sql) => {
    const result = await callTool("run_query", { sql });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("one SQL statement");
  });

  it("accepts semicolons in strings and comments, and a trailing semicolon", async () => {
    const { columns, rows } = await query(`
      SELECT 'a;b' AS text, "id" FROM customers -- not; a statement
      WHERE id = 1 /* also; not one */ ;`);

    expect(columns).toEqual(["text", "id"]);
    expect(rows).toEqual([["a;b", 1]]);
  });

  it.each([";", "   ", "-- only a comment"])(
    "explains that a query is empty: %j",
    async (sql) => {
      const result = await callTool("run_query", { sql });

      expect(result.isError).toBe(true);
      expect(result.text).toContain("The query is empty");
    },
  );

  it("rejects SQL longer than the limit", async () => {
    const longestAllowed = "SELECT 1".padEnd(MAX_SQL_CHARS);
    expect((await query(longestAllowed)).rows).toEqual([[1]]);

    const result = await callTool("run_query", { sql: `${longestAllowed} ` });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Input validation error");
  });

  it("caps the number of rows and reports truncation", async () => {
    const result = await query(`${INFINITE_NUMBERS} SELECT x FROM n`);

    expect(result.rows).toHaveLength(MAX_ROWS);
    expect(result.truncated).toBe(true);
  });

  it("does not report truncation when a result fits exactly", async () => {
    const result = await query(`${INFINITE_NUMBERS} SELECT x FROM n LIMIT ${MAX_ROWS}`);

    expect(result.rows).toHaveLength(MAX_ROWS);
    expect(result.truncated).toBe(false);
  });

  it("caps oversized cells", async () => {
    const { rows } = await query(`SELECT printf('%.*c', 500000, 'x')`);

    expect(rows[0][0].length).toBeLessThan(MAX_CELL_CHARS + 50);
  });

  it("caps the response actually sent to the client", async () => {
    const { text } = await callTool("run_query", {
      sql: `${INFINITE_NUMBERS} SELECT printf('%.*c', ${MAX_CELL_CHARS}, 'x') FROM n`,
    });

    expect(JSON.parse(text).truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(MAX_RESULT_CHARS + RESPONSE_OVERHEAD_CHARS);
  });

  it("returns blobs and large integers as safe JSON", async () => {
    const { rows } = await query("SELECT zeroblob(4), 9007199254740993, 7");

    expect(rows).toEqual([["<blob 4 bytes>", "9007199254740993", 7]]);
  });

  it(
    "stops a runaway query and keeps serving",
    async () => {
      const startedAt = Date.now();
      const result = await callTool("run_query", {
        sql: `${INFINITE_NUMBERS} SELECT count(*) FROM n`,
      });

      expect(result.isError).toBe(true);
      expect(result.text).toContain("Query stopped");
      expect(Date.now() - startedAt).toBeLessThan(QUERY_TIMEOUT_MS + 2_000);
      expect((await query("SELECT 1")).rows).toEqual([[1]]);
    },
    QUERY_TIMEOUT_MS + 5_000,
  );
});

describe("database process", () => {
  it("cannot write to stdout, which carries the protocol", async () => {
    const { connection } = await startServerWith(
      'if (process.send) console.log("not a protocol message");',
    );
    const onProtocolError = vi.fn();
    connection.onerror = onProtocolError;

    await callToolOk("run_query", { sql: "SELECT 1" }, connection);

    expect(onProtocolError).not.toHaveBeenCalled();
  });

  it("reports a process that cannot start, and keeps serving", async () => {
    const { connection, serverPid } = await startServerWith(
      'if (!process.send) process.execPath = "/missing-node";',
    );

    const result = await callTool("run_query", { sql: "SELECT 1" }, connection);

    expect(result).toEqual({
      isError: true,
      text: "The database process failed to run.",
    });
    await expect(connection.listTools()).resolves.toBeDefined();

    // A failed start leaves the time limit's timer running, so closing the
    // connection alone would wait for it.
    process.kill(serverPid, "SIGTERM");
  });

  it(
    "stops a running query when the server is stopped",
    async () => {
      const pidPath = join(folder, "database-process.pid");
      // An idle child exits with its parent, so the PID is written only once
      // the query is starting, when the child can no longer notice anything.
      const { connection, serverPid } = await startServerWith(`
        import { writeFileSync } from "node:fs";
        import { DatabaseSync } from "node:sqlite";

        const { prepare } = DatabaseSync.prototype;
        DatabaseSync.prototype.prepare = function (sql) {
          writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
          return prepare.call(this, sql);
        };
      `);
      const sql = `${INFINITE_NUMBERS} SELECT count(*) FROM n`;
      callTool("run_query", { sql }, connection).catch(() => undefined);

      const childPid = await vi.waitFor(
        () => {
          const pid = Number(readFileSync(pidPath, "utf8"));
          expect(pid).toBeGreaterThan(0);
          return pid;
        },
        { timeout: QUERY_TIMEOUT_MS },
      );
      onTestFinished(() => {
        if (isRunning(childPid)) process.kill(childPid, "SIGKILL");
      });

      process.kill(serverPid, "SIGTERM");

      await vi.waitFor(() => expect(isRunning(childPid)).toBe(false), {
        timeout: 2_000,
      });
    },
    QUERY_TIMEOUT_MS + 5_000,
  );
});

describe("startup", () => {
  it("exits with a clear error when the database is missing", () => {
    const result = spawnSync("node", ["dist/index.js", join(folder, "missing.db")], {
      encoding: "utf8",
      timeout: 10_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Database not found");
  });
});
