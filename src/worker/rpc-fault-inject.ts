// RPC-seam fault injection for test/worker layer.
//
// Provides deterministic latency, timeout, error, and kill_after_commit fault
// injection at the three cross-DO RPC seams that matter for plan Track C/B/D:
//
//   authority-slice  /__internal/authority-slice  (cold-owner 5s timeout cascade)
//   envelope         /v2/envelope                 (dominant turn cost)
//   mcp-commit-fanout /__internal/mcp-commit-fanout (post-commit peer delivery)
//
// Usage: set WOO_FAULT_INJECT to a JSON array of FaultSpec objects. Each spec
// targets one route and fires on matching calls, controlled by `p` (probability,
// default 1.0) and `nth` (only fire on the nth call, 1-based). These two
// controls are designed for deterministic test use — no Date.now-based randomness;
// `p` is compared against a per-spec counter for call-N selection when combined
// with `nth`. For true random sampling supply a seeded RNG before parsing the
// config (not needed by current tests).
//
// Layering: this module lives in src/worker/, not src/core/. It may reference
// specific route strings and env shapes. src/core/ must never import it.
//
// Modes:
//   latency         — add `ms` delay before the real call
//   timeout         — never resolve (simulates 5s authority-slice cold-owner hang)
//   error           — throw a synthetic 5xx-style E_TIMEOUT error without a call
//   kill_after_commit — for the /v2/envelope seam only: commit is durably applied
//                      but the process "dies" before fanout/reply delivery. Hook
//                      point for plan item D1 (tail-driven peer delivery).
//                      Implemented by throwing a KillAfterCommitError at the seam;
//                      the caller catches it, suppresses fanout, and returns the
//                      durable commit result with a dead-delivery marker.
//
// Determinism controls:
//   p    — fire probability in [0,1] (default 1.0 = always fire when matched)
//   nth  — only fire on the nth call to this seam (1-based; default = all calls)
//
// Design note: `p` is applied as a deterministic step function over a per-spec
// call counter so the same config produces the same outcome on the same call
// sequence. For a test that needs "fire on every other call", use `nth` plus
// separate specs. For random sampling in production chaos (not the current use
// case), wire in a seeded PRNG at the `shouldFire` boundary.

import { wooError } from "../core/types";

// Route keys recognised by this module. Keep in sync with the three seams.
export type FaultRoute = "authority-slice" | "envelope" | "mcp-commit-fanout";

// Fault mode names.
export type FaultMode = "latency" | "timeout" | "error" | "kill_after_commit";

// One fault specification. Serialised as JSON in WOO_FAULT_INJECT.
export type FaultSpec = {
  // Which RPC seam to target.
  route: FaultRoute;
  // What to do when triggered.
  mode: FaultMode;
  // Delay in milliseconds. Required for `latency`; meaningful for nothing else.
  ms?: number;
  // Fire probability in [0,1]. Default 1.0.
  p?: number;
  // If set, only fire on this specific call number (1-based). Counted per-spec.
  nth?: number;
};

// Thrown by the kill_after_commit hook so the caller can catch it at the seam
// boundary and suppress fanout/reply while preserving the durable commit result.
export class KillAfterCommitError extends Error {
  override readonly name = "KillAfterCommitError";
  constructor() {
    super("kill_after_commit: simulating DO death after durable commit, before fanout/reply");
  }
}

// Parsed and executable fault configuration. One instance per worker binding.
// The call counters are mutable state so `nth` and deterministic-`p` work
// across multiple calls within a single test.
export class FaultInjector {
  // Map from route → list of (spec, call counter) pairs.
  private readonly specs: Map<FaultRoute, Array<{ spec: FaultSpec; calls: number }>> = new Map();

  private constructor() {}

  // Parse WOO_FAULT_INJECT env var. Returns a no-op injector when unset or empty.
  // Throws on malformed JSON so a misconfigured test fails loudly.
  static fromEnv(envValue: string | undefined): FaultInjector {
    const fi = new FaultInjector();
    if (!envValue) return fi;
    const parsed = JSON.parse(envValue) as unknown;
    if (!Array.isArray(parsed)) throw new Error("WOO_FAULT_INJECT must be a JSON array");
    for (const item of parsed) {
      fi.add(item as FaultSpec);
    }
    return fi;
  }

  // Add one spec. Validates required fields.
  private add(spec: FaultSpec): void {
    if (!spec.route) throw new Error(`FaultSpec missing 'route': ${JSON.stringify(spec)}`);
    if (!spec.mode) throw new Error(`FaultSpec missing 'mode': ${JSON.stringify(spec)}`);
    if (spec.mode === "latency" && (spec.ms === undefined || spec.ms < 0)) {
      throw new Error(`FaultSpec mode=latency requires a non-negative 'ms' field: ${JSON.stringify(spec)}`);
    }
    if (spec.mode === "kill_after_commit" && spec.route !== "envelope") {
      throw new Error(`FaultSpec mode=kill_after_commit is only valid for route=envelope`);
    }
    const list = this.specs.get(spec.route) ?? [];
    list.push({ spec, calls: 0 });
    this.specs.set(spec.route, list);
  }

  // True when at least one spec is configured for the given route.
  hasRoute(route: FaultRoute): boolean {
    return (this.specs.get(route)?.length ?? 0) > 0;
  }

  // True when this injector has no specs at all (fast-path for the common case).
  isEmpty(): boolean {
    return this.specs.size === 0;
  }

  // Evaluate all pre-call specs for `route` and return the first that fires,
  // or null. Skips kill_after_commit specs — those fire via applyKillAfterCommit,
  // not applyPreCall, and must not have their call counter incremented here.
  // Side-effect: increments call counters for non-kill_after_commit specs.
  nextPreCallFault(route: FaultRoute): FaultSpec | null {
    const entries = this.specs.get(route);
    if (!entries) return null;
    for (const entry of entries) {
      if (entry.spec.mode === "kill_after_commit") continue;
      entry.calls += 1;
      if (!shouldFire(entry.spec, entry.calls)) continue;
      return entry.spec;
    }
    return null;
  }

  // Apply the pre-call fault for a route (latency / timeout / error).
  // Returns a promise that resolves when the pre-call effect is done (for
  // latency), or never resolves (for timeout), or throws (for error).
  // kill_after_commit specs are ignored here — they fire via applyKillAfterCommit.
  // Returns null when no fault is configured for this route.
  async applyPreCall(route: FaultRoute, signal?: AbortSignal): Promise<void | null> {
    if (this.isEmpty()) return null;
    const fault = this.nextPreCallFault(route);
    if (!fault) return null;
    return applyPreCallFault(fault, signal);
  }

  // Apply the post-commit fault for the envelope seam.
  // Throws KillAfterCommitError when kill_after_commit is configured and fires.
  // No-op for all other modes and all other routes. Counter is independent of
  // applyPreCall's counter (kill_after_commit specs are skipped by nextPreCallFault).
  applyKillAfterCommit(): void {
    if (this.isEmpty()) return;
    const entries = this.specs.get("envelope");
    if (!entries) return;
    for (const entry of entries) {
      if (entry.spec.mode !== "kill_after_commit") continue;
      entry.calls += 1;
      if (!shouldFire(entry.spec, entry.calls)) continue;
      throw new KillAfterCommitError();
    }
  }
}

// True when the spec should fire on call number `callN` (1-based).
function shouldFire(spec: FaultSpec, callN: number): boolean {
  // nth filter: only fire on the exact nth call.
  if (spec.nth !== undefined && spec.nth !== callN) return false;
  // Probability filter: deterministic step function over call count.
  // p=1.0 always fires; p=0.5 fires on odd calls; p=0.0 never fires.
  const p = spec.p ?? 1.0;
  if (p <= 0) return false;
  if (p >= 1) return true;
  // Deterministic: fire when (callN * p) crosses an integer boundary.
  return Math.floor(callN * p) > Math.floor((callN - 1) * p);
}

// Delay for `ms` milliseconds, respecting an optional AbortSignal.
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const handle = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(handle); reject(signal!.reason); }, { once: true });
  });
}

// Apply a pre-call fault effect. Throws for error/timeout; resolves for latency.
async function applyPreCallFault(spec: FaultSpec, signal?: AbortSignal): Promise<void> {
  switch (spec.mode) {
    case "latency":
      await delay(spec.ms ?? 0, signal);
      return;
    case "timeout":
      // Hang forever (or until the caller's AbortController fires).
      // This simulates the 5s cold-owner RPC that prod currently sees.
      // The test's RPC timeout will abort this via signal.
      await new Promise<never>((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal!.reason), { once: true });
      });
      return;
    case "error":
      throw wooError("E_TIMEOUT", "fault-injected: simulated RPC failure", { route: spec.route });
    case "kill_after_commit":
      // Pre-call hook is a no-op for kill_after_commit; the post-commit hook fires instead.
      return;
  }
}
