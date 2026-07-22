export interface ActiveCheckExecutionInfo {
  workflowId: string;
  nodeId: string;
  attemptId: string;
  startedAt: string;
}

export interface RegisterCheckExecutionInput extends ActiveCheckExecutionInfo {
  upstreamSignal?: AbortSignal;
}

export interface CancelCheckExecutionInput {
  workflowId: string;
  nodeId?: string;
  attemptId?: string;
  reason?: string;
}

export interface ActiveCheckExecutionHandle extends ActiveCheckExecutionInfo {
  signal: AbortSignal;
  release(): void;
}

interface RegistryEntry {
  info: ActiveCheckExecutionInfo;
  controller: AbortController;
  releaseUpstream?: () => void;
}

const key = (value: ActiveCheckExecutionInfo): string => `${value.workflowId}\u0000${value.nodeId}\u0000${value.attemptId}`;

export class ActiveCheckExecutionRegistry {
  private readonly entries = new Map<string, RegistryEntry>();

  register(input: RegisterCheckExecutionInput): ActiveCheckExecutionHandle {
    const info: ActiveCheckExecutionInfo = {
      workflowId: input.workflowId,
      nodeId: input.nodeId,
      attemptId: input.attemptId,
      startedAt: input.startedAt,
    };
    const entryKey = key(info);
    if (this.entries.has(entryKey)) throw new Error(`Check attempt '${input.attemptId}' is already active.`);

    const controller = new AbortController();
    let releaseUpstream: (() => void) | undefined;
    if (input.upstreamSignal) {
      const abort = (): void => controller.abort(input.upstreamSignal?.reason);
      if (input.upstreamSignal.aborted) abort();
      else {
        input.upstreamSignal.addEventListener("abort", abort, { once: true });
        releaseUpstream = () => input.upstreamSignal?.removeEventListener("abort", abort);
      }
    }

    const entry: RegistryEntry = { info, controller, ...(releaseUpstream ? { releaseUpstream } : {}) };
    this.entries.set(entryKey, entry);
    let released = false;
    return {
      ...info,
      signal: controller.signal,
      release: () => {
        if (released) return;
        released = true;
        entry.releaseUpstream?.();
        if (this.entries.get(entryKey) === entry) this.entries.delete(entryKey);
      },
    };
  }

  hasActive(workflowId?: string): boolean {
    if (workflowId === undefined) return this.entries.size > 0;
    return [...this.entries.values()].some((entry) => entry.info.workflowId === workflowId);
  }

  list(workflowId?: string): ActiveCheckExecutionInfo[] {
    return [...this.entries.values()]
      .map((entry) => structuredClone(entry.info))
      .filter((entry) => workflowId === undefined || entry.workflowId === workflowId)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.nodeId.localeCompare(right.nodeId));
  }

  cancel(input: CancelCheckExecutionInput): ActiveCheckExecutionInfo[] {
    const cancelled: ActiveCheckExecutionInfo[] = [];
    for (const entry of this.entries.values()) {
      if (entry.info.workflowId !== input.workflowId) continue;
      if (input.nodeId !== undefined && entry.info.nodeId !== input.nodeId) continue;
      if (input.attemptId !== undefined && entry.info.attemptId !== input.attemptId) continue;
      if (!entry.controller.signal.aborted) entry.controller.abort(input.reason ?? "The check was cancelled by the host.");
      cancelled.push(structuredClone(entry.info));
    }
    return cancelled;
  }

  cancelAll(reason = "The session stopped."): ActiveCheckExecutionInfo[] {
    const cancelled: ActiveCheckExecutionInfo[] = [];
    for (const entry of this.entries.values()) {
      if (!entry.controller.signal.aborted) entry.controller.abort(reason);
      cancelled.push(structuredClone(entry.info));
    }
    return cancelled;
  }
}
