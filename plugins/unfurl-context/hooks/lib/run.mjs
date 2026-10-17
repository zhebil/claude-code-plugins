import { spawn } from "node:child_process";

export const DEFAULT_TIMEOUT_MS = 20000;

/**
 * @typedef {Object} CommandResult
 * @property {number} code Exit code (124 on timeout, 127 on spawn error).
 * @property {string} stdout Captured stdout.
 * @property {string} stderr Captured stderr.
 */

/**
 * Run a child process and capture its output. Never throws - failures are
 * surfaced via a non-zero `code`. Times out and SIGKILLs hung processes.
 *
 * @param {string} command Executable name, resolved against PATH.
 * @param {string[]} args  Argument vector.
 * @param {Object} [options]
 * @param {string} [options.cwd=process.cwd()] Working directory for the child.
 * @param {number} [options.timeout=DEFAULT_TIMEOUT_MS] Timeout in milliseconds.
 * @returns {Promise<CommandResult>}
 */
export function runCommand(command, args, { cwd = process.cwd(), timeout = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000).unref();
    }, timeout);
    timer.unref();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr || String(error) });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? (signal ? 124 : 1), stdout, stderr });
    });
  });
}
