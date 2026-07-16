import { hashSource } from "../core/source-hash";

/**
 * Public correlation token for one client turn.
 *
 * A turn's idempotency key is a replay credential: the scope returns the
 * recorded reply to anyone presenting that key. It therefore must never ride
 * peer fanout. Browsers still need a value they can compute before submitting
 * so an echo that beats the turn reply can be buffered. A one-way digest gives
 * them that correlation without disclosing the replay key.
 */
export function turnEchoId(idempotencyKey: string): string {
  return `echo:${hashSource(`woo.net.turn-echo.v1\0${idempotencyKey}`)}`;
}
