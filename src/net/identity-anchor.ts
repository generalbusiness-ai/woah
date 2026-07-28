/**
 * Operator identity anchor seeding (AP11.9).
 *
 * A fresh net install contains no human and no account instance at all — they
 * are created by signup, and the net stack exposes no signup route. AP11
 * provisioning needs an existing human to anchor its wizard agent to, so on a
 * freshly cut-over world there is nothing to anchor TO and the whole runbook is
 * unexecutable.
 *
 * Creating that anchor is not a turn. A turn needs a target object whose scope
 * already has a head, and this operation's entire purpose is to bring a
 * never-before-seen authority cluster into existence. That is a GENESIS SUBMIT,
 * and the proven precedent is elastic guest provisioning (`guest.ts`): build one
 * transcript against `{seq: 0, hash: cellVersion(["genesis", scope])}` and hand
 * it to the new cluster's own sequencer. This module is that construction for an
 * account + human pair.
 *
 * IDENTITY POSTURE — the reason this does not weaken the model:
 *
 *  - The minted account carries NO `password_hash`, NO `password_salt`, and NO
 *    `oauth_identities`. `verifyPasswordCredential` therefore cannot match it
 *    and `/net-api/login` cannot produce a session for the human. Nothing can
 *    authenticate AS the anchor.
 *  - No api key and no session are minted here. Credentials only ever reach the
 *    AGENT that AP11 provisions, through the separate signed credential-ensure
 *    route, from a tuple generated on the operator machine.
 *  - The anchor is inert on its own: a human actor with an account and no
 *    credential is exactly the "manual provisioning" shape AP10 already
 *    sanctions, reachable before now only in-process.
 *
 * The ids are DERIVED from the operator's `anchor_id`, not allocated from a
 * counter. A genesis cluster has no counter to allocate from, and derivation is
 * what makes the operation idempotent across a lost reply: the same `anchor_id`
 * always names the same objects, so a replay is the same submit.
 */
import { PROP_CUSTOMER_OF } from "./attribution";
import { CellStore, cellVersion, type EpochStamp } from "./cells";
import { sessionWriter } from "./sessions";
import type { CommitSubmit, ScopeHead } from "./scope";
import { applyTranscript, type EffectTranscript, type TranscriptWrite } from "./transcript";

/** Account fields a signup would set that an operator anchor deliberately
 * OMITS, kept here as executable documentation of the credential posture. */
export const ANCHOR_OMITTED_CREDENTIAL_FIELDS = ["password_hash", "password_salt", "oauth_identities"] as const;

export type ProvisionAnchorInput = {
  /** Derived object ids (see identityAnchorIds). */
  human: string;
  account: string;
  /** Operator-chosen label, echoed as the account/human display name. */
  label: string;
  /** The seed classes to instantiate. Passed in rather than named here, the
   * same way the guest door takes its parent class from installed template
   * data: this module builds a genesis commit and has no business knowing
   * which identity classes a given world's seed graph provides. */
  humanClass: string;
  accountClass: string;
  now: number;
  epoch: string;
  /** Quota the anchor's account starts with. The AP11 provisioning turn grants
   * its own headroom afterwards, so these only need to be sane defaults. */
  agentQuota: number;
};

export type ProvisionAnchorResult = {
  submit: CommitSubmit;
  clusterScope: string;
};

/** Deterministic ids for one operator anchor. The `_op_` infix marks these as
 * operator-seeded rather than counter-allocated, so they can never collide with
 * a `human_<n>` an in-process signup would mint. */
export function identityAnchorIds(anchorHex: string): { human: string; account: string } {
  return { human: `human_op_${anchorHex}`, account: `account_op_${anchorHex}` };
}

/** Build the first commit for a never-before-seen operator anchor cluster.
 *
 * Both objects land in `cluster:<human>`: the human is anchorless and
 * actor-classed, so it IS the cluster root, and the account is anchored TO the
 * human exactly as `bindHumanToAccount` does at signup — which is what keeps a
 * later promote/demote/revoke turn single-scope and atomic. */
export function provisionAnchorSubmit(input: ProvisionAnchorInput): ProvisionAnchorResult {
  const clusterScope = `cluster:${input.human}`;
  const base: ScopeHead = { seq: 0, hash: cellVersion(["genesis", clusterScope]) };
  // Same writer shape every transcript uses; the anchor acts as itself.
  const writer = sessionWriter(input.human, "operator_anchor_provision");
  const prop = (object: string, name: string, value: unknown): TranscriptWrite => ({
    cell: { kind: "prop", object, name },
    value: value as TranscriptWrite["value"],
    op: "set",
    writer
  });
  const body: Omit<EffectTranscript, "hash"> = {
    kind: "woo.effect_transcript.shadow.v1",
    id: `operator-anchor:${input.human}`,
    route: "direct",
    scope: clusterScope,
    seq: 0,
    call: { actor: input.human, target: input.human, verb: "operator_anchor_provision", args: [], body: undefined },
    reads: [],
    creates: [
      {
        object: input.human,
        name: input.label,
        parent: input.humanClass,
        owner: "$wiz",
        // Anchorless: an actor-classed root with no anchor IS its own cluster
        // root (topology.ts step 3), which is what makes `cluster:<human>` the
        // scope this submit addresses.
        anchor: null,
        location: "$nowhere",
        flags: {},
        writer
      },
      {
        object: input.account,
        name: input.label,
        parent: input.accountClass,
        owner: "$wiz",
        // Anchored to its primary human, so the account's cells classify into
        // the SAME cluster (topology.ts step 1 walks the anchor first).
        anchor: input.human,
        location: null,
        flags: {},
        writer
      }
    ],
    writes: [
      prop(input.human, "name", input.label),
      prop(input.human, "account", input.account),
      prop(input.account, "name", input.label),
      prop(input.account, "primary_actor", input.human),
      prop(input.account, "actors", [input.human]),
      prop(input.account, "agent_quota", input.agentQuota),
      // Deliberately 0: AP11 grants exactly the headroom it consumes, and an
      // anchor that pre-granted programmer quota would hand every future agent
      // of this account authoring capability nobody asked for.
      prop(input.account, "programmer_grant_quota", 0),
      prop(input.account, "agent_count", 0),
      prop(input.account, "programmer_agent_count", 0),
      prop(input.account, "created_at", input.now),
      // Names the provenance of this identity in the durable record, so an
      // operator reading the world later can tell it from a signup.
      prop(input.account, "signup_method", "operator_anchor"),
      // AU3.1 rule 1: the human attributes to its own account from birth, so
      // no record it later mints is unattributed.
      prop(input.human, PROP_CUSTOMER_OF, {
        customer: input.account,
        derived_via: "account",
        bound_at: input.now
      })
    ],
    moves: [],
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
    submit: {
      kind: "woo.net.commit_submit.v1",
      scope: clusterScope,
      base,
      // Stable across replays: the ids are derived, so a lost reply resubmits
      // byte-identically and the sequencer's idempotency gate collapses it.
      idempotency_key: `operator-anchor:${input.human}`,
      transcript,
      post_state_version: applied.postStateVersion,
      stamp
    }
  };
}
