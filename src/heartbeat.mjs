import { workerData } from "node:worker_threads";
import { withStateTransaction } from "./state.mjs";

const { stateDir, deviceKey, leaseId, timeoutMs, workerPid, stopFlag } = workerData;
const intervalMs = Math.max(250, Math.min(15_000, Math.floor((Number(timeoutMs) || 15_000) / 3)));

while (Atomics.load(stopFlag, 0) === 0) {
  Atomics.wait(stopFlag, 0, 0, intervalMs);
  if (Atomics.load(stopFlag, 0) !== 0) {
    break;
  }
  Atomics.store(stopFlag, 1, 1);
  try {
    if (Atomics.load(stopFlag, 0) !== 0) {
      break;
    }
    withStateTransaction(stateDir, (state, { now }) => {
      if (Atomics.load(stopFlag, 0) !== 0) {
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
    });
  } catch {
    // Ignore transient lock contention during background heartbeat
  } finally {
    Atomics.store(stopFlag, 1, 0);
    Atomics.notify(stopFlag, 1);
  }
}
