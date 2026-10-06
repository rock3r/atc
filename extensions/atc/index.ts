import { execFileSync } from "node:child_process";

/**
 * Pi / Ohm / Tau Coding Agent Extension for Android Traffic Control (atc).
 * Intercepts bash tool invocations via `atc guard` and releases session leases on exit.
 */
export default function atcExtension(pi: any) {
  const sessionId = process.env.ATC_SESSION || `pi-${process.pid}`;

  pi.on("tool_call", async (event: any) => {
    if (event.name !== "bash" && event.name !== "shell") return;
    const command = event.input?.command ?? event.arguments?.command ?? "";
    if (!command) return;

    try {
      const stdout = execFileSync("atc", ["guard", "--session", sessionId, "--json"], {
        input: JSON.stringify({ command, env: { ATC_SESSION: sessionId } }),
        encoding: "utf8",
      });
      const decision = JSON.parse(stdout);
      if (decision.decision === "deny") {
        return { block: true, reason: decision.reason };
      }
      if (decision.env && event.input) {
        event.input.env = { ...(event.input.env || {}), ...decision.env };
      }
    } catch (err: any) {
      if (err.stdout) {
        try {
          const decision = JSON.parse(err.stdout.toString());
          if (decision.decision === "deny") {
            return { block: true, reason: decision.reason };
          }
        } catch {
          // ignore parse error
        }
      }
    }
  });

  pi.on("session_end", async () => {
    try {
      execFileSync("atc", ["free", "--session", sessionId], { stdio: "ignore" });
    } catch {
      // ignore if no active lease
    }
  });
}
