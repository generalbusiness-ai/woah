// Library-shape entry point for applying an accepted v2 effect transcript
// against a host's local state, with the post-apply housekeeping the v2
// protocol implies.
//
// The four sites that previously duplicated this dance — the REST relay
// apply, the in-process REST fallback, the host write-through, and the
// satellite /__internal/apply-v2-commit handler — all collapse to one
// `runShadowApply(transcript, target, { sessionId, result })` call.
// CommitScopeDO doesn't apply through this path (it threads its planning
// world through the relay), but the interface is shaped so a future Node
// or browser consumer with a transcript and a WooWorld can use it directly.
//
// `ShadowApplyTarget` is the only adapter the consumer must provide. Every
// method except `applyTranscript` is optional: a satellite host receiving a
// fanout implements only `applyTranscript`; a gateway with session presence
// implements everything.

import type { EffectTranscript } from "./effect-transcript";
import type { WooValue } from "./types";

export interface ShadowApplyTarget {
  // Required. Apply the committed transcript to whatever local state this
  // target represents. Implementations choose between gateway-world apply
  // and host-scoped apply; the library does not need to know which.
  applyTranscript(transcript: EffectTranscript): void;

  // Optional. Snapshot the set of revoked api-key ids before the transcript
  // applies. The library forwards this to `cleanupRevokedApiKeys` after the
  // apply so the consumer can run side effects only on the *newly* revoked
  // ids. Targets that don't manage api keys (satellite hosts, planning
  // shims) omit both methods.
  revokedApiKeyIdsBefore?(): Set<string>;
  cleanupRevokedApiKeys?(revokedBefore: Set<string>): Promise<void> | void;

  // Optional. Per-session post-apply housekeeping: mirror the result room
  // into session.activeScope, update the directory route, etc. Called only
  // when `runShadowApply` is given a `sessionId`. Satellite consumers omit.
  sessionHousekeeping?(sessionId: string, result: WooValue | undefined): Promise<void> | void;
}

export type ShadowApplyOptions = {
  // The session this turn ran under, if any. Required for `sessionHousekeeping`
  // to fire. When the consumer is a fanout satellite (no session presence),
  // pass `null`/omit and only `applyTranscript` will run.
  sessionId?: string | null;
  // The turn's result, forwarded to `sessionHousekeeping`. Typically the
  // reply's `outcome.result` falling back to `transcript.result`.
  result?: WooValue;
};

export async function runShadowApply(
  transcript: EffectTranscript,
  target: ShadowApplyTarget,
  options: ShadowApplyOptions = {}
): Promise<void> {
  const revokedBefore = target.revokedApiKeyIdsBefore?.() ?? null;
  target.applyTranscript(transcript);
  if (revokedBefore && target.cleanupRevokedApiKeys) {
    await target.cleanupRevokedApiKeys(revokedBefore);
  }
  if (options.sessionId && target.sessionHousekeeping) {
    await target.sessionHousekeeping(options.sessionId, options.result);
  }
}
