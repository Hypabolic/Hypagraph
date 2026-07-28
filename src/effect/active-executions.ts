export interface ActiveEffectExecutionInfo {
  workflowId: string;
  nodeId: string;
  attemptId: string;
  startedAt: string;
  phase: "effect" | "reconcile";
}

export interface RegisterEffectExecutionInput extends ActiveEffectExecutionInfo {
  upstreamSignal?: AbortSignal;
}

export interface ActiveEffectExecutionHandle extends ActiveEffectExecutionInfo {
  signal: AbortSignal;
  release(): void;
}

interface RegistryEntry {
  info: ActiveEffectExecutionInfo;
  controller: AbortController;
  releaseUpstream?: () => void;
}

const key = (value: ActiveEffectExecutionInfo): string =>
  `${value.workflowId}\u0000${value.nodeId}\u0000${value.attemptId}\u0000${value.phase}`;

/** In-flight guard for concurrent external effects and reconciliation. */
export class ActiveEffectExecutionRegistry {
  private readonly entries = new Map<string, RegistryEntry>();

  register(input: RegisterEffectExecutionInput): ActiveEffectExecutionHandle {
    const info: ActiveEffectExecutionInfo = {
      workflowId: input.workflowId,
      nodeId: input.nodeId,
      attemptId: input.attemptId,
      startedAt: input.startedAt,
      phase: input.phase,
    };
    const entryKey = key(info);
    if (this.entries.has(entryKey)) {
      throw new Error(`Effect attempt '${input.attemptId}' phase '${input.phase}' is already active.`);
    }

    // Reject concurrent effect programs for the same node even across phases.
    for (const entry of this.entries.values()) {
      if (entry.info.workflowId === info.workflowId && entry.info.nodeId === info.nodeId) {
        throw new Error(`Effect node '${input.nodeId}' already has an in-flight '${entry.info.phase}' execution.`);
      }
    }

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

  list(workflowId?: string): ActiveEffectExecutionInfo[] {
    return [...this.entries.values()]
      .map((entry) => structuredClone(entry.info))
      .filter((entry) => workflowId === undefined || entry.workflowId === workflowId)
      .sort((left, right) =>
        left.startedAt.localeCompare(right.startedAt) || left.nodeId.localeCompare(right.nodeId));
  }

  cancel(input: { workflowId: string; nodeId?: string; attemptId?: string; reason?: string }): number {
    let count = 0;
    for (const [entryKey, entry] of this.entries) {
      if (entry.info.workflowId !== input.workflowId) continue;
      if (input.nodeId !== undefined && entry.info.nodeId !== input.nodeId) continue;
      if (input.attemptId !== undefined && entry.info.attemptId !== input.attemptId) continue;
      entry.controller.abort(input.reason ?? "cancelled");
      entry.releaseUpstream?.();
      this.entries.delete(entryKey);
      count += 1;
    }
    return count;
  }

  cancelAll(reason = "session_shutdown"): number {
    let count = 0;
    for (const [entryKey, entry] of this.entries) {
      entry.controller.abort(reason);
      entry.releaseUpstream?.();
      this.entries.delete(entryKey);
      count += 1;
    }
    return count;
  }
}
