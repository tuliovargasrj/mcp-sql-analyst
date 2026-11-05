import { fork } from "node:child_process";
import type { DbRequest, DbResponse } from "./db-protocol.js";
import { QUERY_TIMEOUT_MS } from "./limits.js";

const DB_PROCESS_URL = new URL("./db-process.js", import.meta.url);

// A child stuck in native code never notices that its parent left, so the
// server has to kill any running child on the way out.
const serverExit = new AbortController();
process.once("exit", () => serverExit.abort());

/**
 * Runs one database operation in a disposable process.
 *
 * `node:sqlite` blocks inside native code, so a runaway query cannot be stopped
 * from JavaScript, and `worker.terminate()` waits for it forever. Killing a
 * process is the one reliable way to enforce the time limit.
 */
export function callDatabase(request: DbRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = fork(DB_PROCESS_URL, {
      // The child stays off stdout, which carries the MCP protocol.
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      timeout: QUERY_TIMEOUT_MS,
      killSignal: "SIGKILL",
      signal: serverExit.signal,
    });

    child.once("message", (message) => {
      const response = message as DbResponse;
      if (response.ok) resolve(response.result);
      else reject(new Error(response.error));
    });

    // A child can emit "error" more than once, such as a failed start and then
    // the failed send below, and an unhandled one would stop the server.
    child.on("error", () => {
      reject(new Error("The database process failed to run."));
    });

    // "close" fires after the IPC channel drains, so it cannot overtake the
    // reply. Rejecting after a reply has no effect on the settled promise.
    child.once("close", (_code, signal) => {
      const message =
        signal === "SIGKILL"
          ? `Query stopped: exceeded ${QUERY_TIMEOUT_MS} ms.`
          : "The database process stopped unexpectedly.";
      reject(new Error(message));
    });

    child.send(request);
  });
}
