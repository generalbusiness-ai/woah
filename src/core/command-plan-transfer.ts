import type { ObjRef, WooValue } from "./types";
import type { TurnRecorderEvent } from "./turn-recorder";

/**
 * A sequenced command selected at the terminal `execute_command_plan()` call
 * cannot run as a nested turn: doing so would let the direct wrapper and the
 * target each own a recorder envelope, rollback boundary, and durable result.
 * This opaque host-language signal unwinds the wrapper without entering Woo's
 * exception vocabulary. Trusted core imports may call the factory, but only
 * the exact object identities it returns pass the predicate: ordinary Woo
 * maps, thrown errors, and native Proxy traps cannot impersonate one.
 */
const mintedCommandPlanTransfers = new WeakSet<object>();

export type TerminalCommandPlan = {
  space: ObjRef;
  target: ObjRef;
  verb: string;
  verb_definer: ObjRef;
  verb_slot: number;
  args: WooValue[];
};

export type CommandPlanTransfer = {
  readonly plan: TerminalCommandPlan;
  readonly actor: ObjRef;
  readonly session: string;
  readonly proofEvents: TurnRecorderEvent[];
};

export function commandPlanTransfer(
  plan: TerminalCommandPlan,
  actor: ObjRef,
  session: string,
  proofEvents: TurnRecorderEvent[]
): CommandPlanTransfer {
  const transfer = Object.freeze({
    plan: Object.freeze({
      ...plan,
      args: structuredClone(plan.args) as WooValue[]
    }),
    actor,
    session,
    proofEvents: structuredClone(proofEvents) as TurnRecorderEvent[]
  });
  mintedCommandPlanTransfers.add(transfer);
  return transfer;
}

export function isCommandPlanTransfer(value: unknown): value is CommandPlanTransfer {
  return typeof value === "object" && value !== null && mintedCommandPlanTransfers.has(value);
}
