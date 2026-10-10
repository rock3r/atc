import { workerData } from "node:worker_threads";
import { withStateTransaction } from "./state.mjs";

const { stateDir, deviceKey, leaseId, timeoutMs, workerPid } = workerData;
const intervalMs = Math.max(250, Math.min(15_000, Math.floor((Number(timeoutMs) || 15_000) / 3)));

setInterval(() => {
  try {
    withStateTransaction(stateDir, (state, { now }) => {
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
  }
}, intervalMs);
