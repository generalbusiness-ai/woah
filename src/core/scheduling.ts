/**
 * The scheduling envelope — CO16.6 / CO16.7.
 *
 * These live in core, not in the net layer, because BOTH ends enforce them
 * and the dependency runs core → net, never the reverse. The VM checks them
 * so an author gets a useful error at the call site; the committing scope
 * re-checks every one of them against recorded provenance, because it does
 * not trust the planner with its own rules. Neither check is redundant: the
 * first is ergonomics, the second is authority.
 */

/**
 * Minimum lead time on every scheduled delivery.
 *
 * This is a floor on each individual delay, not a rate limit between
 * deliveries of the same verb. Since a repeating chain re-arms only when it
 * fires, a floor on each delay is also a ceiling of one turn per minute on
 * the chain — the property actually worth bounding — and it is checkable
 * from the arming turn alone, with no durable last-delivery index to keep or
 * clean up.
 *
 * A minute is deliberate. Every delivery is a full committed turn: a
 * sequencer transaction, a fanout pass, an audit record, a projection fold.
 * The committed plane is not for animation.
 */
export const SCHEDULE_MIN_LEAD_MS = 60_000;

/** Furthest future a schedule may name. Rests on host alarms firing reliably
 * across multi-day boundaries — untested past the smoke lanes' horizons and
 * a deploy-only signal (tasks.md §16.2). */
export const SCHEDULE_MAX_HORIZON_MS = 365 * 24 * 60 * 60 * 1000;

export const SCHEDULE_MAX_PER_SCOPE = 1000;
export const SCHEDULE_MAX_PER_OBJECT = 32;
export const SCHEDULE_MAX_PER_TURN = 16;

/**
 * Byte caps. Counts alone do not bound storage: ids, verb names and args are
 * author-supplied, so a thousand entries across many scheduling objects can
 * accumulate megabytes of durable scope state that no cell accounting sees.
 * The counts bound the alarm's work per firing; these bound the disk.
 */
export const SCHEDULE_MAX_ENTRY_BYTES = 8 * 1024;
export const SCHEDULE_MAX_SCOPE_BYTES = 2 * 1024 * 1024;

/**
 * The logical-input name under which a turn records its scheduling clock.
 *
 * Producer and validator MUST agree on this string, and both import it from
 * here for that reason: an earlier cut had the VM record `schedule.base` /
 * `schedule.now` while the commit scope searched for `now`, so no real
 * scheduling transcript could pass validation at all. The unit tests did not
 * catch it because they hand-built the transcript shape instead of driving
 * the producer.
 */
export const SCHEDULE_CLOCK_INPUT = "schedule.now";
