import { describe, expect, it } from "vitest";
import { v2BrowserCacheMutationsForEnvelope } from "../src/client/v2-browser-cache";
import type { ShadowEnvelope } from "../src/core/shadow-envelope";
import type { ShadowStatePage } from "../src/core/shadow-state-pages";

describe("v2 browser cache reducer", () => {
  it("persists projection transfers as projection head and clears catch-up-required", () => {
    const envelope = envelopeFor("woo.state.transfer.shadow.v1", {
      kind: "woo.state.transfer.shadow.v1",
      mode: "projection",
      scope: "the_dubspace",
      to: { kind: "woo.scope_head.shadow.v1", scope: "the_dubspace", epoch: 1, seq: 3, hash: "h3" },
      projection: { kind: "projection", seq: 3 },
      proof: { kind: "test" }
    });

    expect(v2BrowserCacheMutationsForEnvelope(envelope)).toEqual([
      { kind: "projection", scope: "the_dubspace", head: envelope.body.to, projection: envelope.body.projection, reset_execution_overlay: true },
      { kind: "meta", key: "head:the_dubspace", value: envelope.body.to },
      { kind: "meta", key: "catchup_required", value: false }
    ]);
  });

  it("persists delta transfers as projection, applied frames, and transcript tail", () => {
    const accepted = {
      kind: "woo.commit.accepted.shadow.v1",
      id: "turn-1",
      position: { kind: "woo.scope_head.shadow.v1", scope: "the_dubspace", epoch: 1, seq: 1, hash: "h1" },
      receipt: { kind: "woo.commit_receipt.shadow.v1", id: "turn-1", accepted: true },
      transcript_hash: "t1",
      pre_state_hash: "p0",
      post_state_hash: "p1",
      observations: []
    };
    const transcript = {
      kind: "woo.effect_transcript.shadow.v1",
      id: "turn-1",
      scope: "the_dubspace",
      seq: 1,
      hash: "t1",
      complete: true
    };
    const envelope = envelopeFor("woo.state.transfer.shadow.v1", {
      kind: "woo.state.transfer.shadow.v1",
      mode: "delta",
      scope: "the_dubspace",
      to: accepted.position,
      projection: { kind: "projection", seq: 1 },
      applied: [accepted],
      transcript_tail: [transcript],
      proof: { kind: "test" }
    });

    expect(v2BrowserCacheMutationsForEnvelope(envelope)).toEqual([
      { kind: "projection", scope: "the_dubspace", head: accepted.position, projection: envelope.body.projection },
      { kind: "meta", key: "head:the_dubspace", value: accepted.position },
      { kind: "meta", key: "catchup_required", value: false },
      { kind: "applied_frame", frame: accepted, transcript },
      { kind: "transcript", transcript }
    ]);
  });

  it("persists delta projection patches as patch mutations", () => {
    const accepted = {
      kind: "woo.commit.accepted.shadow.v1",
      id: "turn-patch",
      position: { kind: "woo.scope_head.shadow.v1", scope: "the_dubspace", epoch: 1, seq: 2, hash: "h2" },
      receipt: { kind: "woo.commit_receipt.shadow.v1", id: "turn-patch", accepted: true },
      transcript_hash: "tp",
      post_state_hash: "p2",
      observations: []
    };
    const transcript = {
      kind: "woo.effect_transcript.shadow.v1",
      id: "turn-patch",
      scope: "the_dubspace",
      seq: 2,
      hash: "tp",
      complete: true
    };
    const patch = {
      kind: "woo.scope_projection_patch.shadow.v1",
      scope: "the_dubspace",
      base: { kind: "woo.scope_head.shadow.v1", scope: "the_dubspace", epoch: 1, seq: 1, hash: "h1" },
      to: accepted.position,
      fields: { seq: 2 },
      objects: { order: ["the_dubspace"], upsert: [], remove: [] }
    };
    const envelope = envelopeFor("woo.state.transfer.shadow.v1", {
      kind: "woo.state.transfer.shadow.v1",
      mode: "delta",
      scope: "the_dubspace",
      to: accepted.position,
      projection_patch: patch,
      applied: [accepted],
      transcript_tail: [transcript],
      proof: { kind: "test" }
    });

    expect(v2BrowserCacheMutationsForEnvelope(envelope)).toEqual([
      { kind: "projection_patch", scope: "the_dubspace", head: accepted.position, patch },
      { kind: "meta", key: "head:the_dubspace", value: accepted.position },
      { kind: "meta", key: "catchup_required", value: false },
      { kind: "applied_frame", frame: accepted, transcript },
      { kind: "transcript", transcript }
    ]);
  });

  it("persists empty current-head deltas as head freshness markers", () => {
    const head = { kind: "woo.scope_head.shadow.v1", scope: "the_dubspace", epoch: 1, seq: 4, hash: "h4" };
    const envelope = envelopeFor("woo.state.transfer.shadow.v1", {
      kind: "woo.state.transfer.shadow.v1",
      mode: "delta",
      scope: "the_dubspace",
      to: head,
      applied: [],
      transcript_tail: [],
      proof: { kind: "test" }
    });

    expect(v2BrowserCacheMutationsForEnvelope(envelope)).toEqual([
      { kind: "meta", key: "head:the_dubspace", value: head },
      { kind: "meta", key: "catchup_required", value: false }
    ]);
  });

  it("marks reset errors as requiring catch-up and clears pending replies on replies", () => {
    expect(v2BrowserCacheMutationsForEnvelope(envelopeFor("woo.transport.error.v1", {
      kind: "woo.transport.error.v1",
      code: "E_RESET",
      message: "reset"
    }))).toEqual([{ kind: "meta", key: "catchup_required", value: true }]);

    expect(v2BrowserCacheMutationsForEnvelope({
      ...envelopeFor("woo.turn.exec.reply.shadow.v1", { kind: "woo.turn.exec.reply.shadow.v1", ok: true }),
      reply_to: "pending-1"
    })).toEqual([{ kind: "pending_delete", id: "pending-1" }]);

    expect(v2BrowserCacheMutationsForEnvelope({
      ...envelopeFor("woo.turn.exec.reply.shadow.v1", {
        kind: "woo.turn.exec.reply.shadow.v1",
        ok: false,
        reason: "missing_state",
        missing_atoms: [{ hash: "needed" }]
      }),
      reply_to: "pending-missing"
    })).toEqual([]);
  });

  it("reduces successful turn replies into applied frame and transcript cache mutations", () => {
    const accepted = {
      kind: "woo.commit.accepted.shadow.v1",
      id: "turn-2",
      position: { kind: "woo.scope_head.shadow.v1", scope: "the_dubspace", epoch: 1, seq: 2, hash: "h2" },
      receipt: { kind: "woo.commit_receipt.shadow.v1", id: "turn-2", accepted: true },
      transcript_hash: "t2",
      post_state_hash: "p2",
      observations: []
    };
    const transcript = {
      kind: "woo.effect_transcript.shadow.v1",
      id: "turn-2",
      scope: "the_dubspace",
      seq: 2,
      hash: "t2",
      complete: true
    };
    expect(v2BrowserCacheMutationsForEnvelope({
      ...envelopeFor("woo.turn.exec.reply.shadow.v1", {
        kind: "woo.turn.exec.reply.shadow.v1",
        ok: true,
        transcript,
        commit: accepted
      }),
      reply_to: "pending-2"
    })).toEqual([
      { kind: "pending_delete", id: "pending-2" },
      { kind: "applied_frame", frame: accepted, transcript },
      { kind: "transcript", transcript },
      { kind: "meta", key: "head:the_dubspace", value: accepted.position }
    ]);
  });

  it("persists reply-bundled executable transfers and capability ads", () => {
    const transfer = {
      kind: "woo.state.transfer.shadow.v1",
      mode: "closure",
      scope: "the_dubspace",
      atom_hashes: ["atom-1"],
      serialized: {
        objects: [],
        sessions: [],
        logs: [],
        snapshots: [],
        parkedTasks: [],
        tombstones: [],
        objectCounter: 0,
        sessionCounter: 0,
        parkedTaskCounter: 0
      },
      proof: { root: "transfer-root" }
    };
    const ad = {
      kind: "woo.exec_capability_ad.shadow.v1",
      node: "near-executor",
      scope: "the_dubspace",
      epoch: "1",
      covers: { m: 8, k: 1, bits_hex: "ff" },
      accepts: { m: 8, k: 1, bits_hex: "ff" },
      effects: 0,
      factor: 0.1
    };

    const mutations = v2BrowserCacheMutationsForEnvelope({
      ...envelopeFor("woo.turn.exec.reply.shadow.v1", {
        kind: "woo.turn.exec.reply.shadow.v1",
        ok: true,
        transcript: {
          kind: "woo.effect_transcript.shadow.v1",
          id: "turn-with-transfer",
          scope: "the_dubspace",
          seq: 1,
          hash: "t-transfer",
          complete: true
        },
        state_transfer: transfer,
        ads: [ad]
      }),
      reply_to: "pending-transfer"
    });

    expect(mutations).toEqual([
      { kind: "pending_delete", id: "pending-transfer" },
      { kind: "transcript", transcript: expect.objectContaining({ hash: "t-transfer" }) },
      { kind: "execution_transfer", record: expect.objectContaining({ scope: "the_dubspace", mode: "closure", transfer }) },
      { kind: "execution_ad", record: expect.objectContaining({ node: "near-executor", scope: "the_dubspace", ad }) }
    ]);
  });

  it("persists standalone capability-ad frames from gossip", () => {
    const ad = {
      kind: "woo.exec_capability_ad.shadow.v1",
      node: "gossip-executor",
      scope: "the_dubspace",
      epoch: "1",
      covers: { m: 8, k: 1, bits_hex: "ff" },
      accepts: { m: 8, k: 1, bits_hex: "ff" },
      effects: 0,
      factor: 0.2
    };

    expect(v2BrowserCacheMutationsForEnvelope(envelopeFor("woo.exec_capability_ad.shadow.v1", ad))).toEqual([
      { kind: "execution_ad", record: expect.objectContaining({ node: "gossip-executor", scope: "the_dubspace", ad }) }
    ]);
  });

  it("persists executable cell pages for later browser-side planning", () => {
    const page: ShadowStatePage = {
      kind: "woo.state_page.object_live.shadow.v1",
      page: "object_live",
      object: "#room",
      location: null,
      children: [],
      contents: ["#note"]
    };
    const envelope = envelopeFor("woo.state.transfer.shadow.v1", {
      kind: "woo.state.transfer.shadow.v1",
      mode: "cell_pages",
      scope: "#room",
      atom_hashes: [],
      page_refs: [{ object: "#room", page: "object_live", hash: "page-hash", bytes: 10, inline: true }],
      inline_pages: [page],
      sessions: [],
      logs: [],
      snapshots: [],
      parkedTasks: [],
      tombstones: [],
      counters: { objectCounter: 1, parkedTaskCounter: 1, sessionCounter: 1 },
      source_object_count: 1,
      source_page_count: 1,
      proof: { kind: "test" }
    });

    const mutations = v2BrowserCacheMutationsForEnvelope(envelope);
    expect(mutations[0]).toMatchObject({
      kind: "execution_transfer",
      record: {
        scope: "#room",
        mode: "cell_pages",
        transfer: envelope.body
      }
    });
    expect(mutations.slice(1)).toEqual([
      { kind: "state_page", hash: "page-hash", ref: "#room:object_live:", page }
    ]);
  });
});

function envelopeFor<T>(type: string, body: T): ShadowEnvelope<T> {
  return {
    v: 2,
    type,
    id: `${type}:1`,
    from: "relay",
    to: "browser",
    auth: { mode: "session", token: "token" },
    body
  } as ShadowEnvelope<T>;
}
