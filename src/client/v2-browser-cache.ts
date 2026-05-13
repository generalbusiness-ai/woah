import type { EffectTranscript } from "../core/effect-transcript";
import type { ShadowBrowserStateTransfer } from "../core/shadow-browser-node";
import type { ShadowCommitAccepted, ShadowScopeHead } from "../core/shadow-commit-scope";
import type { ShadowEnvelope } from "../core/shadow-envelope";
import type { WooValue } from "../core/types";

export type V2BrowserCacheMutation =
  | { kind: "meta"; key: string; value: unknown }
  | { kind: "pending_delete"; id: string }
  | { kind: "projection"; scope: string; head: ShadowScopeHead; projection: WooValue }
  | { kind: "applied_frame"; frame: ShadowCommitAccepted }
  | { kind: "transcript"; transcript: EffectTranscript };

export function v2BrowserCacheMutationsForEnvelope(envelope: ShadowEnvelope): V2BrowserCacheMutation[] {
  if (envelope.type === "woo.transport.hello.v1") {
    return [
      { kind: "meta", key: "hello", value: envelope.body },
      { kind: "meta", key: "catchup_required", value: false }
    ];
  }
  if (envelope.type === "woo.transport.error.v1") {
    const body = envelope.body as { code?: unknown };
    return body.code === "E_RESET" ? [{ kind: "meta", key: "catchup_required", value: true }] : [];
  }
  if (envelope.type === "woo.state.transfer.shadow.v1") {
    return stateTransferMutations(envelope.body as ShadowBrowserStateTransfer);
  }
  if (envelope.reply_to) return [{ kind: "pending_delete", id: envelope.reply_to }];
  return [];
}

function stateTransferMutations(transfer: ShadowBrowserStateTransfer): V2BrowserCacheMutation[] {
  if (transfer.kind !== "woo.state.transfer.shadow.v1") return [];
  if (transfer.mode !== "projection" && transfer.mode !== "delta") return [];
  const common: V2BrowserCacheMutation[] = [
    { kind: "projection", scope: transfer.scope, head: transfer.to, projection: transfer.projection },
    { kind: "meta", key: `head:${transfer.scope}`, value: transfer.to },
    { kind: "meta", key: "catchup_required", value: false }
  ];
  if (transfer.mode === "projection") return common;
  return [
    ...common,
    ...transfer.applied.map((frame) => ({ kind: "applied_frame" as const, frame })),
    ...transfer.transcript_tail.map((transcript) => ({ kind: "transcript" as const, transcript }))
  ];
}
