/**
 * Free-slot lifetime protocol for isolated model workers (S4).
 *
 * Hold free slots only for start/register and settlement critical sections.
 * Release free slots before the long isolated process await.
 * MemberContext (and cancel mirrors) are the authority during unlocked await.
 *
 * Structure only: concurrent Promise.all of two non-root model members must not
 * install free host state for the duration of sibling process awaits.
 */

export type IsolatedFreeSlotCriticalPhase = "start" | "settle" | "error-cancel";

/**
 * Hooks for one isolated worker run under the free-slot protocol.
 * Callers supply lock, bind, and the three phases.
 */
export interface IsolatedFreeSlotProtocolHooks<TStarted, TWorkerResult> {
  /** Serialize free-slot critical sections across concurrent workers. */
  withLock: <T>(fn: () => Promise<T>) => Promise<T>;
  /**
   * Bind the member (or root) into free host slots.
   * release() must restore free slots (desk root for non-root members).
   */
  bindFreeSlots: () => { release: () => void };
  /**
   * Start critical section: prepare, start-node, register pool.
   * Runs while free slots are bound and the lock is held.
   */
  runStart: () => Promise<TStarted>;
  /**
   * Long worker await. Must not hold free slots or the free-slot lock.
   */
  awaitWorker: (started: TStarted) => Promise<TWorkerResult>;
  /**
   * Settle critical section: accept settlement, commit, free pool seat.
   * Runs while free slots are bound and the lock is held.
   */
  runSettle: (started: TStarted, workerResult: TWorkerResult) => Promise<boolean>;
  /**
   * Optional cancel after worker throw or start failure.
   * Runs under lock while free slots are bound when started is defined.
   */
  runErrorCancel?: (
    started: TStarted | undefined,
    error: unknown,
  ) => Promise<void>;
}

/**
 * Run one isolated worker with short free-slot holds only.
 *
 * Order:
 * 1. lock + bind + start + release bind + unlock
 * 2. await worker (no free slots)
 * 3. lock + bind + settle + release bind + unlock
 *
 * On worker throw: lock + bind + error-cancel + release + unlock, then rethrow
 * only when rethrowOnWorkerError is true (default false returns false via
 * onWorkerErrorResult).
 */
export async function runIsolatedWithFreeSlotProtocol<TStarted, TWorkerResult>(
  hooks: IsolatedFreeSlotProtocolHooks<TStarted, TWorkerResult>,
  options?: {
    /** When true, worker errors rethrow after error-cancel. Default false. */
    rethrowOnWorkerError?: boolean;
    /** Result when worker throws and rethrow is false. Default false. */
    onWorkerErrorResult?: boolean;
  },
): Promise<boolean> {
  const rethrowOnWorkerError = options?.rethrowOnWorkerError === true;
  const onWorkerErrorResult = options?.onWorkerErrorResult ?? false;

  let started: TStarted;
  try {
    started = await hooks.withLock(async () => {
      const binding = hooks.bindFreeSlots();
      try {
        return await hooks.runStart();
      } finally {
        binding.release();
      }
    });
  } catch (error) {
    await hooks.withLock(async () => {
      const binding = hooks.bindFreeSlots();
      try {
        await hooks.runErrorCancel?.(undefined, error);
      } finally {
        binding.release();
      }
    });
    throw error;
  }

  let workerResult: TWorkerResult;
  try {
    // Free slots and free-slot lock must not be held during this await.
    workerResult = await hooks.awaitWorker(started);
  } catch (error) {
    await hooks.withLock(async () => {
      const binding = hooks.bindFreeSlots();
      try {
        await hooks.runErrorCancel?.(started, error);
      } finally {
        binding.release();
      }
    });
    if (rethrowOnWorkerError) throw error;
    return onWorkerErrorResult;
  }

  return await hooks.withLock(async () => {
    const binding = hooks.bindFreeSlots();
    try {
      return await hooks.runSettle(started, workerResult);
    } finally {
      binding.release();
    }
  });
}

/**
 * Probe helper for tests: records whether free slots were bound at each phase.
 * Does not touch product state.
 */
export interface FreeSlotPhaseTrace {
  phase: IsolatedFreeSlotCriticalPhase | "await";
  freeSlotsBound: boolean;
  lockHeld: boolean;
}

/**
 * Run a concurrent pair of protocol instances and collect free-slot traces.
 * Used by S4 tests to prove await does not hold free slots while both run.
 */
export async function traceConcurrentIsolatedFreeSlotProtocol(input: {
  /** Simulated worker hold until release is called for that id. */
  workerHoldMs?: number;
}): Promise<{
  traces: FreeSlotPhaseTrace[];
  awaitOverlapBoundCount: number;
  peakConcurrentAwaits: number;
  bothCompleted: boolean;
}> {
  const traces: FreeSlotPhaseTrace[] = [];
  let freeSlotsOwner: string | undefined;
  let lockOwner: string | undefined;
  let concurrentAwaits = 0;
  let peakConcurrentAwaits = 0;
  let awaitOverlapBoundCount = 0;
  let chain: Promise<void> = Promise.resolve();

  const withLock = async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = chain;
    chain = previous.then(() => gate);
    await previous;
    lockOwner = id;
    try {
      return await fn();
    } finally {
      lockOwner = undefined;
      release();
    }
  };

  const runOne = async (id: string): Promise<boolean> => {
    return runIsolatedWithFreeSlotProtocol<{ id: string }, { id: string }>({
      withLock: (fn) => withLock(id, fn),
      bindFreeSlots: () => {
        freeSlotsOwner = id;
        return {
          release: () => {
            if (freeSlotsOwner === id) freeSlotsOwner = undefined;
          },
        };
      },
      runStart: async () => {
        traces.push({
          phase: "start",
          freeSlotsBound: freeSlotsOwner === id,
          lockHeld: lockOwner === id,
        });
        return { id };
      },
      awaitWorker: async (started) => {
        concurrentAwaits += 1;
        peakConcurrentAwaits = Math.max(peakConcurrentAwaits, concurrentAwaits);
        const boundDuringAwait = freeSlotsOwner !== undefined;
        if (boundDuringAwait) awaitOverlapBoundCount += 1;
        traces.push({
          phase: "await",
          freeSlotsBound: freeSlotsOwner === started.id,
          lockHeld: lockOwner === started.id,
        });
        await new Promise((resolve) => setTimeout(resolve, input.workerHoldMs ?? 15));
        concurrentAwaits -= 1;
        return { id: started.id };
      },
      runSettle: async (started) => {
        traces.push({
          phase: "settle",
          freeSlotsBound: freeSlotsOwner === started.id,
          lockHeld: lockOwner === started.id,
        });
        return true;
      },
    });
  };

  const [a, b] = await Promise.all([runOne("A"), runOne("B")]);
  return {
    traces,
    awaitOverlapBoundCount,
    peakConcurrentAwaits,
    bothCompleted: a && b,
  };
}
