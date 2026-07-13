/**
 * Elastic guest provisioning. One fresh actor cluster owns the actor,
 * its mutable properties, and its first session; all are created by one
 * ordinary sequenced submit. Catalog-specific identities arrive only in
 * GuestTemplate data installed at $system.guest_template.
 */
import { CellStore, cellVersion, type EpochStamp } from "./cells";
import { sessionWriter, type SessionCellValue } from "./sessions";
import type { CommitSubmit, ScopeHead } from "./scope";
import { applyTranscript, type EffectTranscript, type TranscriptWrite } from "./transcript";

export type GuestTemplate = {
  version: 1;
  parent: string;
  owner: string;
  description: string;
  home: string;
  initial_room: string;
};

export type ProvisionGuestInput = {
  actor: string;
  session: string;
  ttl_ms: number;
  now: number;
  epoch: string;
  template: GuestTemplate;
};

export type ProvisionGuestResult = {
  submit: CommitSubmit;
  value: SessionCellValue;
  clusterScope: string;
};

/** Build the first commit for a never-before-seen actor cluster. */
export function provisionGuestSubmit(input: ProvisionGuestInput): ProvisionGuestResult {
  if (!Number.isFinite(input.ttl_ms) || input.ttl_ms <= 0) {
    throw new Error(`guest provision requires a positive finite ttl_ms: ${input.ttl_ms}`);
  }
  const clusterScope = `cluster:${input.actor}`;
  const base: ScopeHead = { seq: 0, hash: cellVersion(["genesis", clusterScope]) };
  const value: SessionCellValue = {
    id: input.session,
    actor: input.actor,
    started: input.now,
    expiresAt: input.now + input.ttl_ms,
    activeScope: input.template.initial_room,
    ephemeralActor: true
  };
  const writer = sessionWriter(input.actor, "guest_provision");
  const body: Omit<EffectTranscript, "hash"> = {
    kind: "woo.effect_transcript.shadow.v1",
    id: `guest-provision:${input.session}`,
    route: "direct",
    scope: clusterScope,
    seq: 0,
    session: input.session,
    call: { actor: input.actor, target: input.actor, verb: "guest_provision", args: [], body: undefined },
    exclusiveMint: true,
    sessionScopeTransition: {
      session: input.session,
      actor: input.actor,
      actorName: `Guest ${input.actor.slice(-8)}`,
      from: null,
      to: input.template.initial_room
    },
    reads: [],
    creates: [{
      object: input.actor,
      name: `Guest ${input.actor.slice(-8)}`,
      parent: input.template.parent,
      owner: input.template.owner,
      anchor: null,
      location: input.template.initial_room,
      flags: {},
      writer
    }],
    writes: [
      {
        cell: { kind: "prop", object: input.actor, name: "description" },
        value: input.template.description as TranscriptWrite["value"],
        op: "set",
        writer
      },
      {
        cell: { kind: "prop", object: input.actor, name: "home" },
        value: input.template.home as TranscriptWrite["value"],
        op: "set",
        writer
      },
      {
        cell: { kind: "session", object: input.session },
        value: value as unknown as TranscriptWrite["value"],
        op: "set",
        writer
      }
    ],
    moves: [{ object: input.actor, from: null, to: input.template.initial_room, writer }],
    observations: [],
    logicalInputs: [],
    untrackedEffects: [],
    complete: true,
    incompleteReasons: []
  };
  const transcript: EffectTranscript = { ...body, hash: cellVersion(body) };
  const stamp: EpochStamp = { scope_head: "planner", catalog_epoch: input.epoch };
  const applied = applyTranscript(new CellStore("authority"), transcript, stamp);
  return {
    clusterScope,
    value,
    submit: {
      kind: "woo.net.commit_submit.v1",
      scope: clusterScope,
      base,
      idempotency_key: `guest-provision:${input.session}:${value.expiresAt}`,
      transcript,
      post_state_version: applied.postStateVersion,
      stamp
    }
  };
}
