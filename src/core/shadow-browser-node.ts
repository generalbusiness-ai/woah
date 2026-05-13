import type { SerializedObject, SerializedWorld } from "./repository";
import { createShadowCommitScope, type ShadowCommitAccepted, type ShadowCommitConflict, type ShadowCommitScope } from "./shadow-commit-scope";
import {
  createShadowExecutionNode,
  installShadowCachedObjectRecords,
  shadowObjectRecordHash,
  type ShadowExecutionNode,
  type ShadowStateTransfer,
  type ShadowTurnExecRequest,
  type ShadowTurnExecutionResult
} from "./shadow-turn-exec";
import { runShadowTurnCall, type ShadowTurnCall } from "./shadow-turn-call";
import { buildShadowTurnExecAd, executeShadowTurnCallAcrossInProcessNetwork, type ShadowInProcessNetworkResult } from "./shadow-turn-network";
import { shadowTurnKeyFromTranscript, type ShadowTurnKey } from "./turn-key";
import type { EffectTranscript } from "./effect-transcript";
import { stableShadowJson } from "./shadow-cell-version";
import { constantTimeEqual, hashSource } from "./source-hash";
import type { ObjRef, Observation, WooValue } from "./types";

const DEFAULT_SHADOW_BROWSER_STATE_AUTHORITY = "shadow-relay";
const DEFAULT_SHADOW_BROWSER_STATE_KEY_ID = "shadow-browser-dev";
const DEFAULT_SHADOW_BROWSER_STATE_SECRET = "shadow-browser-dev-secret";

export type ShadowLiveAudience = {
  actors?: ObjRef[];
  sessions?: string[];
  scope?: ObjRef;
};

export type ShadowLiveEvent = {
  kind: "woo.live.event.shadow.v1";
  id: string;
  source: ObjRef;
  actor?: ObjRef;
  scope?: ObjRef;
  audience?: ShadowLiveAudience;
  observation: Observation;
  coalesce?: string;
};

export type ShadowProjectionTransfer = {
  kind: "woo.state.transfer.shadow.v1";
  mode: "projection";
  scope: ObjRef;
  to: ShadowCommitAccepted["position"];
  projection: WooValue;
  proof: ShadowBrowserStateProof;
};

export type ShadowDeltaTransfer = {
  kind: "woo.state.transfer.shadow.v1";
  mode: "delta";
  scope: ObjRef;
  to: ShadowCommitAccepted["position"];
  applied: ShadowCommitAccepted[];
  transcript_tail: EffectTranscript[];
  projection: WooValue;
  proof: ShadowBrowserStateProof;
};

export type ShadowBrowserStateTransfer = ShadowStateTransfer | ShadowProjectionTransfer | ShadowDeltaTransfer;

export type ShadowBrowserStateProof = {
  kind: "woo.state_proof.shadow.v1";
  scheme: "shadow.relay_mac.v1";
  authority: string;
  key_id: string;
  recipient: string;
  scope: ObjRef;
  mode: ShadowProjectionTransfer["mode"] | ShadowDeltaTransfer["mode"];
  root: string;
  head: ShadowCommitAccepted["position"];
  signature: string;
};

export type ShadowBrowserLiveInput = {
  id?: string;
  source: ObjRef;
  actor?: ObjRef;
  scope?: ObjRef;
  audience?: ShadowLiveAudience;
  observation: Observation;
  coalesce?: string;
  deliver_to_self?: boolean;
};

export type ShadowBrowserNodeCache = {
  kind: "woo.browser_cache.shadow.v1";
  object_pages: Map<string, SerializedObject>;
  object_page_refs: Map<ObjRef, string>;
  projections: Map<ObjRef, WooValue>;
  transcript_tail: EffectTranscript[];
  pending_turns: Map<string, ShadowBrowserPendingTurn>;
  applied_frames: ShadowCommitAccepted[];
  conflicts: ShadowCommitConflict[];
  transfers: ShadowBrowserStateTransfer[];
  live_events: ShadowLiveEvent[];
};

export type ShadowBrowserPendingTurn = {
  id: string;
  call: ShadowTurnCall;
  key: ShadowTurnKey;
  planned_transcript: EffectTranscript;
};

export type ShadowBrowserRelayShim = {
  kind: "woo.browser_relay.shadow.v1";
  node: string;
  commit_scope: ShadowCommitScope;
  executors: ShadowExecutionNode[];
  subscriptions: Map<ObjRef, Set<string>>;
  browsers: Map<string, ShadowBrowserNode>;
  live_events: ShadowLiveEvent[];
  state_signing: ShadowBrowserStateSigning;
};

export type ShadowBrowserNode = {
  kind: "woo.browser_node.shadow.v1";
  node: string;
  scope: ObjRef;
  actor: ObjRef;
  session: string | null;
  execution_node: ShadowExecutionNode;
  relay: ShadowBrowserRelayShim;
  cache: ShadowBrowserNodeCache;
  trusted_state_authorities: Map<string, string>;
  next_turn: number;
  next_live: number;
};

export type ShadowBrowserStateSigning = {
  authority: string;
  key_id: string;
  secret: string;
};

export type ShadowBrowserOpenScopeResult = {
  projection: WooValue;
  preseeded_objects: number;
};

export type ShadowBrowserTurnInput = {
  id?: string;
  route?: ShadowTurnCall["route"];
  scope?: ObjRef;
  target: ObjRef;
  verb: string;
  args?: WooValue[];
  commit_policy?: ShadowTurnExecRequest["commit_policy"];
};

export type ShadowBrowserTurnResult = {
  id: string;
  call: ShadowTurnCall;
  key: ShadowTurnKey;
  planned_transcript: EffectTranscript;
  network: ShadowInProcessNetworkResult;
  result: ShadowTurnExecutionResult;
};

export function createShadowBrowserRelayShim(input: {
  node: string;
  scope: ObjRef;
  serialized: SerializedWorld;
  executors?: ShadowExecutionNode[];
  state_signing?: Partial<ShadowBrowserStateSigning>;
}): ShadowBrowserRelayShim {
  return {
    kind: "woo.browser_relay.shadow.v1",
    node: input.node,
    commit_scope: createShadowCommitScope({
      node: input.node,
      scope: input.scope,
      serialized: input.serialized
    }),
    executors: input.executors ?? [],
    subscriptions: new Map(),
    browsers: new Map(),
    live_events: [],
    state_signing: {
      authority: input.state_signing?.authority ?? DEFAULT_SHADOW_BROWSER_STATE_AUTHORITY,
      key_id: input.state_signing?.key_id ?? DEFAULT_SHADOW_BROWSER_STATE_KEY_ID,
      secret: input.state_signing?.secret ?? DEFAULT_SHADOW_BROWSER_STATE_SECRET
    }
  };
}

export function createShadowBrowserNode(input: {
  node: string;
  scope: ObjRef;
  actor: ObjRef;
  session?: string | null;
  relay: ShadowBrowserRelayShim;
  cached_objects?: SerializedObject[];
  trusted_state_authorities?: Record<string, string>;
}): ShadowBrowserNode {
  const executionNode = createShadowExecutionNode({
    node: input.node,
    scope: input.scope,
    cached_objects: input.cached_objects
  });
  const cache = createShadowBrowserNodeCache();
  cacheObjectPages(cache, input.cached_objects ?? []);
  return {
    kind: "woo.browser_node.shadow.v1",
    node: input.node,
    scope: input.scope,
    actor: input.actor,
    session: input.session ?? null,
    execution_node: executionNode,
    relay: input.relay,
    cache,
    trusted_state_authorities: trustedBrowserStateAuthorities(input.trusted_state_authorities),
    next_turn: 1,
    next_live: 1
  };
}

export function createShadowBrowserNodeCache(): ShadowBrowserNodeCache {
  return {
    kind: "woo.browser_cache.shadow.v1",
    object_pages: new Map(),
    object_page_refs: new Map(),
    projections: new Map(),
    transcript_tail: [],
    pending_turns: new Map(),
    applied_frames: [],
    conflicts: [],
    transfers: [],
    live_events: []
  };
}

export function shadowBrowserCatalogObjects(serialized: SerializedWorld): SerializedObject[] {
  return serialized.objects
    .filter((obj) => obj.id.startsWith("$"))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function openShadowBrowserScope(
  browser: ShadowBrowserNode,
  options: { preseed_catalog_pages?: boolean } = {}
): Promise<ShadowBrowserOpenScopeResult> {
  const serialized = browser.relay.commit_scope.serialized;
  const preseed = options.preseed_catalog_pages === true ? shadowBrowserCatalogObjects(serialized) : [];
  if (preseed.length > 0) {
    installShadowCachedObjectRecords(browser.execution_node, preseed);
    cacheObjectPages(browser.cache, preseed);
  }
  subscribeShadowBrowserNode(browser, browser.scope);
  // Scope open enters the state plane even for display-only projection data, so
  // every cache fill goes through the same recipient-bound verification path.
  const transfer = buildShadowBrowserProjectionTransfer(browser.relay, browser.scope, browser.node);
  applyShadowBrowserTransfer(browser, transfer);
  return {
    projection: transfer.projection,
    preseeded_objects: preseed.length
  };
}

export function subscribeShadowBrowserNode(browser: ShadowBrowserNode, scope: ObjRef = browser.scope): void {
  browser.relay.browsers.set(browser.node, browser);
  let subscribers = browser.relay.subscriptions.get(scope);
  if (!subscribers) {
    subscribers = new Set();
    browser.relay.subscriptions.set(scope, subscribers);
  }
  subscribers.add(browser.node);
}

export function unsubscribeShadowBrowserNode(browser: ShadowBrowserNode, scope: ObjRef = browser.scope): void {
  browser.relay.subscriptions.get(scope)?.delete(browser.node);
}

export function emitShadowBrowserLiveEvent(browser: ShadowBrowserNode, input: ShadowBrowserLiveInput): ShadowLiveEvent {
  const event: ShadowLiveEvent = {
    kind: "woo.live.event.shadow.v1",
    id: input.id ?? `${browser.node}:live:${browser.next_live++}`,
    source: input.source,
    actor: input.actor ?? browser.actor,
    scope: input.scope ?? browser.scope,
    audience: input.audience,
    observation: input.observation,
    coalesce: input.coalesce
  };
  publishShadowBrowserLiveEvent(browser.relay, event, {
    except: input.deliver_to_self === true ? null : browser.node
  });
  return event;
}

export function publishShadowBrowserLiveEvent(
  relay: ShadowBrowserRelayShim,
  event: ShadowLiveEvent,
  options: { except?: string | null } = {}
): void {
  relay.live_events.push(structuredClone(event) as ShadowLiveEvent);
  for (const browser of relay.browsers.values()) {
    if (options.except && browser.node === options.except) continue;
    if (!shadowLiveEventMatchesBrowser(relay, browser, event)) continue;
    receiveShadowBrowserLiveEvent(browser, event);
  }
}

function receiveShadowBrowserLiveEvent(browser: ShadowBrowserNode, event: ShadowLiveEvent): void {
  const cloned = structuredClone(event) as ShadowLiveEvent;
  if (event.coalesce) {
    const index = browser.cache.live_events.findIndex((item) => item.coalesce === event.coalesce);
    if (index >= 0) {
      browser.cache.live_events[index] = cloned;
      return;
    }
  }
  browser.cache.live_events.push(cloned);
}

function shadowLiveEventMatchesBrowser(
  relay: ShadowBrowserRelayShim,
  browser: ShadowBrowserNode,
  event: ShadowLiveEvent
): boolean {
  const audience = event.audience;
  if (audience?.sessions?.includes(browser.session ?? "")) return true;
  if (audience?.actors?.includes(browser.actor)) return true;
  const scope = audience?.scope ?? event.scope;
  return typeof scope === "string" && relay.subscriptions.get(scope)?.has(browser.node) === true;
}

export async function executeShadowBrowserTurn(
  browser: ShadowBrowserNode,
  input: ShadowBrowserTurnInput
): Promise<ShadowBrowserTurnResult> {
  const id = input.id ?? `${browser.node}:turn:${browser.next_turn++}`;
  const call: ShadowTurnCall = {
    kind: "woo.turn_call.shadow.v1",
    id,
    route: input.route ?? "sequenced",
    scope: input.scope ?? browser.scope,
    session: browser.session,
    actor: browser.actor,
    target: input.target,
    verb: input.verb,
    args: input.args ?? []
  };
  const planned = await runShadowTurnCall(browser.relay.commit_scope.serialized, call);
  const key = shadowTurnKeyFromTranscript(planned.transcript);
  const pending: ShadowBrowserPendingTurn = {
    id,
    call,
    key,
    planned_transcript: planned.transcript
  };
  browser.cache.pending_turns.set(id, pending);

  const request: ShadowTurnExecRequest = {
    kind: "woo.turn_exec_request.shadow.v1",
    id,
    call,
    key,
    expected: browser.relay.commit_scope.head,
    auth: {
      mode: "shadow_local",
      actor: browser.actor,
      session: browser.session
    },
    commit_policy: input.commit_policy ?? "execute_and_commit"
  };

  const network = await executeShadowTurnCallAcrossInProcessNetwork({
    request,
    nodes: [browser.execution_node, ...browser.relay.executors],
    // Browser nodes do not broadcast broad capability in production. This ad is
    // the relay's local optimistic route back to the actor node; exact inventory
    // is still checked before VM execution.
    ads: [buildShadowTurnExecAd({ node: browser.execution_node.node, scope: key.scope, key, factor: 0.1 })],
    anchor: {
      node: browser.relay.node,
      serialized: browser.relay.commit_scope.serialized
    },
    commitScope: browser.relay.commit_scope
  });

  for (const transfer of network.transfers) applyShadowBrowserTransfer(browser, transfer);
  if (network.result.ok) {
    browser.cache.pending_turns.delete(id);
    if (network.result.commit) publishShadowBrowserAcceptedFrame(browser.relay, network.result.commit, network.result.transcript);
    else browser.cache.transcript_tail.push(network.result.transcript);
  } else if (network.result.reason === "commit_rejected") {
    browser.cache.pending_turns.delete(id);
    if (network.result.commit) applyShadowBrowserConflict(browser, network.result.commit);
  }

  return {
    id,
    call,
    key,
    planned_transcript: planned.transcript,
    network,
    result: network.result
  };
}

export function buildShadowBrowserProjectionTransfer(relay: ShadowBrowserRelayShim, scope: ObjRef, recipient = "*"): ShadowProjectionTransfer {
  // Projection transfer replaces direct cache mutation on scope-open so display
  // state obeys the same recipient-bound relay authority check as deltas.
  const transfer = {
    kind: "woo.state.transfer.shadow.v1",
    mode: "projection",
    scope,
    to: structuredClone(relay.commit_scope.head) as ShadowCommitAccepted["position"],
    projection: shadowScopeProjection(relay.commit_scope.serialized, scope)
  } satisfies Omit<ShadowProjectionTransfer, "proof">;
  return { ...transfer, proof: signShadowBrowserStateTransfer(transfer, relay.state_signing, recipient) };
}

export function buildShadowBrowserDeltaTransfer(
  relay: ShadowBrowserRelayShim,
  accepted: ShadowCommitAccepted,
  transcript: EffectTranscript,
  recipient = "*"
): ShadowDeltaTransfer {
  // Delta transfer carries the committed frame plus transcript tail needed by
  // browser caches to catch up without receiving executable closure state.
  const transfer = {
    kind: "woo.state.transfer.shadow.v1",
    mode: "delta",
    scope: accepted.position.scope,
    to: structuredClone(accepted.position) as ShadowCommitAccepted["position"],
    applied: [structuredClone(accepted) as ShadowCommitAccepted],
    transcript_tail: [structuredClone(transcript) as EffectTranscript],
    projection: shadowScopeProjection(relay.commit_scope.serialized, accepted.position.scope)
  } satisfies Omit<ShadowDeltaTransfer, "proof">;
  return { ...transfer, proof: signShadowBrowserStateTransfer(transfer, relay.state_signing, recipient) };
}

export function publishShadowBrowserAcceptedFrame(
  relay: ShadowBrowserRelayShim,
  accepted: ShadowCommitAccepted,
  transcript: EffectTranscript
): void {
  // Commit fan-out is subscription-gated; browsers outside the scope must ask
  // for later state transfer rather than receiving every accepted frame.
  for (const browser of relay.browsers.values()) {
    if (relay.subscriptions.get(accepted.position.scope)?.has(browser.node) !== true) continue;
    // The originator is often subscribed too; accepted-frame dedup below makes
    // that round trip harmless while preserving one relay fan-out path.
    const transfer = buildShadowBrowserDeltaTransfer(relay, accepted, transcript, browser.node);
    applyShadowBrowserTransfer(browser, transfer);
  }
}

export function applyShadowBrowserAcceptedFrame(browser: ShadowBrowserNode, accepted: ShadowCommitAccepted): void {
  if (browser.cache.applied_frames.some((frame) => frame.id === accepted.id && frame.position.hash === accepted.position.hash)) return;
  browser.cache.applied_frames.push(accepted);
  browser.cache.projections.set(browser.scope, shadowScopeProjection(accepted.serialized_after, browser.scope));
}

export function applyShadowBrowserConflict(browser: ShadowBrowserNode, conflict: ShadowCommitConflict): void {
  browser.cache.conflicts.push(conflict);
}

export function applyShadowBrowserTransfer(browser: ShadowBrowserNode, transfer: ShadowBrowserStateTransfer): void {
  verifyShadowBrowserStateTransfer(browser, transfer);
  browser.cache.transfers.push(structuredClone(transfer) as ShadowBrowserStateTransfer);
  switch (transfer.mode) {
    case "projection":
      browser.cache.projections.set(transfer.scope, structuredClone(transfer.projection) as WooValue);
      return;
    case "delta":
      browser.cache.projections.set(transfer.scope, structuredClone(transfer.projection) as WooValue);
      for (const transcript of transfer.transcript_tail) {
        if (!browser.cache.transcript_tail.some((item) => item.hash === transcript.hash)) {
          browser.cache.transcript_tail.push(structuredClone(transcript) as EffectTranscript);
        }
      }
      for (const accepted of transfer.applied) applyShadowBrowserAcceptedFrame(browser, accepted);
      return;
    case "closure":
      // Closure and object-record transfers keep the execution-plane
      // shadow.anchor_mac.v1 proof; this browser cache path only stores pages.
      cacheObjectPages(browser.cache, transfer.serialized.objects);
      return;
    case "object_records":
      cacheObjectPages(browser.cache, transfer.objects);
      return;
  }
  assertNeverTransfer(transfer);
}

function cacheObjectPages(cache: ShadowBrowserNodeCache, objects: SerializedObject[]): void {
  for (const obj of objects) {
    const hash = shadowObjectRecordHash(obj);
    cache.object_pages.set(hash, structuredClone(obj) as SerializedObject);
    cache.object_page_refs.set(obj.id, hash);
  }
}

function shadowScopeProjection(serialized: SerializedWorld, scope: ObjRef): WooValue {
  const scopeObj = serialized.objects.find((obj) => obj.id === scope);
  return {
    kind: "woo.scope_projection.shadow.v1",
    scope,
    title: scopeObj?.name ?? scope,
    object_count: serialized.objects.length,
    contents: scopeObj?.contents ?? [],
    seq: serialized.logs.find(([space]) => space === scope)?.[1].reduce((max, entry) => Math.max(max, entry.seq), 0) ?? 0
  };
}

function trustedBrowserStateAuthorities(input: Record<string, string> | undefined): Map<string, string> {
  return new Map(Object.entries(input ?? { [DEFAULT_SHADOW_BROWSER_STATE_AUTHORITY]: DEFAULT_SHADOW_BROWSER_STATE_SECRET }));
}

function signShadowBrowserStateTransfer(
  transfer: Omit<ShadowProjectionTransfer, "proof"> | Omit<ShadowDeltaTransfer, "proof">,
  signing: ShadowBrowserStateSigning,
  recipient: string
): ShadowBrowserStateProof {
  // Browser projection/delta state is signed by the relay shim rather than by
  // the execution anchor. This is still shadow-local authority, but unlike a
  // checksum it binds the payload to a trusted relay key and recipient node.
  const root = shadowBrowserStateTransferRoot(transfer, { recipient });
  return {
    kind: "woo.state_proof.shadow.v1",
    scheme: "shadow.relay_mac.v1",
    authority: signing.authority,
    key_id: signing.key_id,
    recipient,
    mode: transfer.mode,
    scope: transfer.scope,
    head: structuredClone(transfer.to) as ShadowCommitAccepted["position"],
    root,
    signature: shadowBrowserStateSignature(root, signing.secret)
  };
}

function shadowBrowserStateTransferRoot(
  transfer: Omit<ShadowProjectionTransfer, "proof"> | Omit<ShadowDeltaTransfer, "proof"> | ShadowProjectionTransfer | ShadowDeltaTransfer,
  proof: Pick<ShadowBrowserStateProof, "recipient">
): string {
  // The proof root names only projection/delta cache material. Transcript body
  // hashes are recomputed during verification before this root is trusted.
  const material = {
    kind: "woo.browser_state_proof_material.shadow.v1",
    mode: transfer.mode,
    scope: transfer.scope,
    recipient: proof.recipient,
    head: transfer.to,
    projection: transfer.projection,
    applied: transfer.mode === "delta" ? transfer.applied.map((frame) => ({
      id: frame.id,
      position: frame.position,
      transcript_hash: frame.transcript_hash,
      post_state_hash: frame.post_state_hash
    })) : [],
    transcript_hashes: transfer.mode === "delta" ? transfer.transcript_tail.map((transcript) => transcript.hash) : []
  };
  return hashSource(stableShadowJson(material as unknown as WooValue));
}

function verifyShadowBrowserStateTransfer(browser: ShadowBrowserNode, transfer: ShadowBrowserStateTransfer): void {
  if (transfer.mode !== "projection" && transfer.mode !== "delta") return;
  // Verification is intentionally before cache install: transcript bodies must
  // match their hashes, then the relay MAC must match a trusted authority.
  verifyShadowBrowserTranscriptHashes(transfer);
  const expectedRoot = shadowBrowserStateTransferRoot(transfer, transfer.proof);
  if (transfer.proof.scope !== transfer.scope || transfer.proof.mode !== transfer.mode) {
    throw new Error("shadow browser state proof scope/mode mismatch");
  }
  if (transfer.proof.recipient !== "*" && transfer.proof.recipient !== browser.node) {
    throw new Error(`shadow browser state proof recipient mismatch: proof=${transfer.proof.recipient} node=${browser.node}`);
  }
  const secret = browser.trusted_state_authorities.get(transfer.proof.authority);
  if (!secret) throw new Error(`untrusted shadow browser state authority: ${transfer.proof.authority}`);
  if (!constantTimeEqual(expectedRoot, transfer.proof.root)) throw new Error("shadow browser state proof root mismatch");
  const signature = shadowBrowserStateSignature(expectedRoot, secret);
  if (!constantTimeEqual(signature, transfer.proof.signature)) throw new Error("shadow browser state proof signature mismatch");
}

function verifyShadowBrowserTranscriptHashes(transfer: ShadowProjectionTransfer | ShadowDeltaTransfer): void {
  if (transfer.mode !== "delta") return;
  const transcriptHashes = new Set<string>();
  for (const transcript of transfer.transcript_tail) {
    const actual = effectTranscriptHash(transcript);
    if (actual !== transcript.hash) throw new Error(`shadow browser transcript hash mismatch: ${transcript.id}`);
    transcriptHashes.add(transcript.hash);
  }
  for (const applied of transfer.applied) {
    if (!transcriptHashes.has(applied.transcript_hash)) {
      throw new Error(`shadow browser applied transcript missing: ${applied.id}`);
    }
  }
}

function effectTranscriptHash(transcript: EffectTranscript): string {
  const { hash: _hash, ...withoutHash } = transcript;
  return hashSource(stableShadowJson(withoutHash as unknown as WooValue));
}

function shadowBrowserStateSignature(root: string, secret: string): string {
  return hashSource(`shadow.relay_mac.v1:${secret}:${root}`);
}

function assertNeverTransfer(transfer: never): never {
  throw new Error(`unsupported shadow browser state transfer mode: ${(transfer as { mode?: string }).mode}`);
}
