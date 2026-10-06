import { execFileSync } from "node:child_process";

/**
 * Pi / Ohm / Tau Coding Agent Extension for Android Traffic Control (atc).
 * Intercepts bash tool invocations via `atc guard` and releases session leases on exit.
 */
export default function atcExtension(pi: any) {
  const sessionId =
    process.env.ATC_SESSION_ID || process.env.ATC_SESSION || `pi-${process.pid}`;

  pi.on("tool_call", async (event: any) => {
    if (event.name !== "bash" && event.name !== "shell") return;
    const command = event.input?.command ?? event.arguments?.command ?? "";
    if (!command) return;

    const handleDecision = (rawStdout: string) => {
      const decision = JSON.parse(rawStdout);
      if (decision.allowed === false || decision.decision === "deny") {
        return { block: true, reason: decision.reason };
      }
      if (decision.rewrittenCommand) {
        if (event.input && typeof event.input === "object") {
          event.input.command = decision.rewrittenCommand;
        } else if (event.arguments && typeof event.arguments === "object") {
          event.arguments.command = decision.rewrittenCommand;
        }
      }
      return undefined;
    };

    try {
      const stdout = execFileSync(
        "atc",
        ["guard", "--session", sessionId, "--format=json", "--", command],
        { encoding: "utf8" }
      );
      const outcome = handleDecision(stdout);
      if (outcome) return outcome;
    } catch (err: any) {
      if (err.stdout) {
        try {
          const outcome = handleDecision(err.stdout.toString());
          if (outcome) return outcome;
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
