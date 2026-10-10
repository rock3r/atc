import { workerData } from "node:worker_threads";
import { withStateTransaction } from "./state.mjs";

const { stateDir, deviceKey, leaseId, timeoutMs, workerPid, stopFlag } = workerData;
const intervalMs = Math.max(250, Math.min(15_000, Math.floor((Number(timeoutMs) || 15_000) / 3)));
const shouldAbort = () => Atomics.load(stopFlag, 0) !== 0;

function runHeartbeatTick() {
  if (shouldAbort()) return;
  Atomics.store(stopFlag, 1, 1);
  try {
    if (shouldAbort()) return;
    withStateTransaction(
      stateDir,
      (state, { now }) => {
        if (shouldAbort()) {
          return { mutated: false };
        }
        const lease =
          state.leases[deviceKey]?.leaseId === leaseId
            ? state.leases[deviceKey]
            : Object.values(state.leases).find((l) => l.leaseId === leaseId);
        if (
          lease &&
          lease.workerPid === workerPid &&
          (lease.state === "starting" || lease.state === "stopping")
        ) {
          lease.deadlineMs = now + timeoutMs;
          return { mutated: true };
        }
        return { mutated: false };
      },
      {
        ancestorPids: [],
        lockTimeoutMs: Math.min(1000, intervalMs),
        shouldAbort,
      },
    );
  } catch {
    // Ignore transient lock contention or abort during background heartbeat
  } finally {
    Atomics.store(stopFlag, 1, 0);
    Atomics.notify(stopFlag, 1);
  }
}

try {
  runHeartbeatTick();
  Atomics.store(stopFlag, 2, 1);
  Atomics.notify(stopFlag, 2);

  while (!shouldAbort()) {
    Atomics.wait(stopFlag, 0, 0, intervalMs);
    if (shouldAbort()) {
      break;
    }
    runHeartbeatTick();
  }
} finally {
  Atomics.store(stopFlag, 1, 0);
  Atomics.notify(stopFlag, 1);
}
