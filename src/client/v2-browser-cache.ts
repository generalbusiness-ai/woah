import type { EffectTranscript } from "../core/effect-transcript";
import type { ShadowBrowserStateTransfer, ShadowScopeProjectionPatch } from "../core/shadow-browser-node";
import type { ShadowCapabilityAd } from "../core/capability-ad";
import type { ShadowCommitAccepted, ShadowScopeHead } from "../core/shadow-commit-scope";
import type { ShadowEnvelope } from "../core/shadow-envelope";
import type { ShadowTurnExecReply } from "../core/shadow-turn-exec";
import type { ShadowStatePage } from "../core/shadow-state-pages";
import type { SerializedObject } from "../core/repository";
import type { WooValue } from "../core/types";
import type { V2ExecutionAdRecord } from "./v2-browser-delegation";
import { v2ExecutionAdRecord } from "./v2-browser-delegation";
import type { V2ExecutableTransferRecord } from "./v2-browser-execution-cache";
import { v2ExecutableTransferRecord } from "./v2-browser-execution-cache";

export type V2BrowserCacheMutation =
  | { kind: "meta"; key: string; value: unknown }
  | { kind: "pending_delete"; id: string }
  | { kind: "projection"; scope: string; head: ShadowScopeHead; projection: WooValue }
  | { kind: "projection_patch"; scope: string; head: ShadowScopeHead; patch: ShadowScopeProjectionPatch }
  | { kind: "applied_frame"; frame: ShadowCommitAccepted; transcript?: EffectTranscript }
  | { kind: "transcript"; transcript: EffectTranscript }
  | { kind: "object_page"; hash: string; object: SerializedObject }
  | { kind: "state_page"; hash: string; ref: string; page: ShadowStatePage }
  | { kind: "execution_ad"; record: V2ExecutionAdRecord }
  | { kind: "execution_transfer"; record: V2ExecutableTransferRecord };

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
  if (envelope.type === "woo.exec_capability_ad.shadow.v1") {
    return [{ kind: "execution_ad", record: v2ExecutionAdRecord(envelope.body as ShadowCapabilityAd) }];
  }
  if (envelope.type === "woo.turn.exec.reply.shadow.v1") {
    const reply = envelope.body as ShadowTurnExecReply;
    // Missing-state replies are cache-warm prompts, not terminal answers. Keep
    // the pending envelope so the worker can replay it after the state transfer
    // has installed the requested executable pages.
    const mutations: V2BrowserCacheMutation[] = envelope.reply_to && !(reply.ok === false && reply.reason === "missing_state")
      ? [{ kind: "pending_delete", id: envelope.reply_to }]
      : [];
    if (reply.ok === true && reply.transcript) {
      if (reply.commit) mutations.push({ kind: "applied_frame" as const, frame: reply.commit as ShadowCommitAccepted, transcript: reply.transcript });
      mutations.push({ kind: "transcript" as const, transcript: reply.transcript });
      if (reply.commit) mutations.push({ kind: "meta" as const, key: `head:${reply.commit.position.scope}`, value: reply.commit.position });
    }
    if (reply.state_transfer) mutations.push(...stateTransferMutations(reply.state_transfer));
    for (const ad of reply.ads ?? []) mutations.push({ kind: "execution_ad" as const, record: v2ExecutionAdRecord(ad) });
    return mutations;
  }
  if (envelope.reply_to) return [{ kind: "pending_delete", id: envelope.reply_to }];
  return [];
}

function stateTransferMutations(transfer: ShadowBrowserStateTransfer): V2BrowserCacheMutation[] {
  if (transfer.kind !== "woo.state.transfer.shadow.v1") return [];
  if (transfer.mode === "object_records") {
    const hashByObject = new Map(transfer.object_pages.map((page) => [page.id, page.hash]));
    return [
      { kind: "execution_transfer" as const, record: v2ExecutableTransferRecord(transfer) },
      ...transfer.objects
      .map((object) => {
        const hash = hashByObject.get(object.id);
        return hash ? { kind: "object_page" as const, hash, object } : null;
      })
      .filter((item): item is Extract<V2BrowserCacheMutation, { kind: "object_page" }> => item !== null)
    ];
  }
  if (transfer.mode === "cell_pages") {
    const hashByRef = new Map(transfer.page_refs.map((ref) => [statePageRefKey(ref), ref.hash]));
    return [
      { kind: "execution_transfer" as const, record: v2ExecutableTransferRecord(transfer) },
      ...transfer.inline_pages
      .map((page) => {
        const ref = statePageRefKey(page);
        const hash = hashByRef.get(ref);
        return hash ? { kind: "state_page" as const, hash, ref, page } : null;
      })
      .filter((item): item is Extract<V2BrowserCacheMutation, { kind: "state_page" }> => item !== null)
    ];
  }
  if (transfer.mode === "closure") return [{ kind: "execution_transfer", record: v2ExecutableTransferRecord(transfer) }];
  if (transfer.mode !== "projection" && transfer.mode !== "delta") return [];
  const projectionMutation: V2BrowserCacheMutation | null = transfer.mode === "delta" && transfer.projection_patch
    ? { kind: "projection_patch", scope: transfer.scope, head: transfer.to, patch: transfer.projection_patch }
    : transfer.projection
      ? { kind: "projection", scope: transfer.scope, head: transfer.to, projection: transfer.projection }
      : null;
  if (!projectionMutation) return [];
  const common: V2BrowserCacheMutation[] = [
    projectionMutation,
    { kind: "meta", key: `head:${transfer.scope}`, value: transfer.to },
    { kind: "meta", key: "catchup_required", value: false }
  ];
  if (transfer.mode === "projection") return common;
  return [
    ...common,
    ...transfer.applied.map((frame, index) => ({ kind: "applied_frame" as const, frame, transcript: transfer.transcript_tail[index] })),
    ...transfer.transcript_tail.map((transcript) => ({ kind: "transcript" as const, transcript }))
  ];
}

function statePageRefKey(page: Pick<ShadowStatePage, "object" | "page"> & { name?: string }): string {
  return `${page.object}:${page.page}:${page.name ?? ""}`;
}
