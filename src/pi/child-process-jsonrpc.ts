/**
 * Shared child-process JSON-RPC helpers for process-backed executors.
 *
 * Used by isolated Pi and ACP adapters. Not domain state.
 */

import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

/**
 * Streaming UTF-8 JSONL line reader for stdio JSON-RPC.
 *
 * Decodes raw buffer chunks through StringDecoder so multi-byte characters that
 * span chunk boundaries stay intact. Splits only on LF (`\n`) and strips a
 * trailing CR. Incomplete lines remain buffered until a later chunk arrives.
 */
export class JsonlUtf8LineReader {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";

  /**
   * Decode one raw chunk and return complete lines (without the LF delimiter).
   */
  push(chunk: Buffer): string[] {
    this.buffer += this.decoder.write(chunk);
    return this.drainCompleteLines();
  }

  /**
   * Flush decoder end state and return any remaining complete lines.
   * A trailing incomplete line without LF is left in the buffer and not returned.
   */
  end(): string[] {
    this.buffer += this.decoder.end();
    return this.drainCompleteLines();
  }

  /** Text still buffered after the last push/end (incomplete final line). */
  pending(): string {
    return this.buffer;
  }

  /**
   * Flush decoder and return complete lines plus any final non-blank pending line.
   * Use on stdout end so agents that omit a trailing newline still deliver the
   * last JSON-RPC message.
   */
  flushIncludingPending(): string[] {
    const lines = this.end();
    const rest = this.buffer.trim();
    this.buffer = "";
    if (rest.length > 0) {
      lines.push(rest);
    }
    return lines;
  }

  private drainCompleteLines(): string[] {
    const lines: string[] = [];
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const rawLine = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      lines.push(rawLine);
    }
    return lines;
  }
}

function childHasExited(child: ChildProcess): boolean {
  // exitCode is set for normal exit. signalCode is set when killed by signal.
  // child.killed only records whether this process called kill(); external kill
  // leaves killed false with signalCode set.
  return child.exitCode !== null
    || child.signalCode !== null
    || child.killed;
}

/**
 * Terminate a child process tree with bounded wait.
 * Idempotent for already-exited children (exit code or signal code set).
 * forceTimer and a final deadline always resolve so callers cannot hang.
 */
export async function terminateChildProcessTree(
  child: ChildProcess,
  options: { graceMs?: number; forceMs?: number; reason?: string } = {},
): Promise<void> {
  if (childHasExited(child)) return;

  const graceMs = options.graceMs ?? 2_000;
  const forceMs = options.forceMs ?? 1_000;

  await new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      clearTimeout(deadlineTimer);
      child.removeListener("exit", onExit);
      resolve();
    };

    const onExit = (): void => {
      done();
    };

    const forceTimer = setTimeout(() => {
      if (childHasExited(child)) {
        done();
        return;
      }
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, graceMs);

    // Final bound: resolve even if the process never emits exit after SIGKILL.
    const deadlineTimer = setTimeout(() => {
      done();
    }, graceMs + forceMs);

    child.once("exit", onExit);

    if (childHasExited(child)) {
      done();
      return;
    }

    try {
      child.kill("SIGTERM");
    } catch {
      done();
      return;
    }

    // Race: process may have exited between checks.
    if (childHasExited(child)) {
      done();
    }
  });
}
