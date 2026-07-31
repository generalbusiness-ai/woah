// The COLLAPSED MCP projection (mcp.md §M9) — an opt-in alternative shape for
// the same dynamic tool surface the classic projection advertises.
//
// WHY THIS EXISTS. The classic projection mints one tool per (object, verb)
// pair in structural context. Measured on the seeded demo world
// (notes/2026-07-29-mcp-world-navigation-usability.md): 146 tools over 9
// objects but only 78 distinct verbs, `set_description` nine times and `look`
// eight. Two mounted workspaces the actor is not standing in contributed 80 of
// the 146, and 56 of those were a byte-identical repeat of the generic room
// block. An enumerating host pays that in context; a host that *searches* for
// a tool by keyword — Claude Code defers descriptors and searches — gets nine
// indistinguishable `say` hits and no basis to choose.
//
// WHAT IT DOES. Object identity moves out of the tool NAME and into an
// ARGUMENT, for exactly those verbs where the object is not the affordance.
// Which verbs those are is DERIVED FROM ANCESTRY, never from a list of verb
// names: core holds no opinion that `say` or `open` is special, because that
// would be catalog vocabulary living in the substrate (AGENTS.md §Layering).
//
// Three independent reductions, in the order they are applied:
//
//   1. NAME-KEYED FAMILIES (`foldNameKeyedFamilies`). A verb whose authority
//      prefetch reads a map at its OWN NAME — `["target","exits","$verb",
//      "dest"]` — is declaring that its name is data. When its definer also
//      declares a sibling reading the same path from an ARGUMENT
//      (`{"arg":0}`), the family folds into that sibling. In the seeded world
//      the eight compass verbs plus `out` fold into `go(exit)`. This is the
//      note's `move(exit)` proposal, derived rather than hardcoded, and it
//      works for any catalog that uses the idiom.
//
//   2. UNIVERSALITY (`universalDefiners`). A definer is universal when it is a
//      base shared across the session's context; its verbs then collapse to
//      one session-level tool each, named by the verb, taking the receiver as
//      an argument. Everything else stays `<object>__<verb>`.
//
//   3. CLOSED MOUNTS (`isClosedMount` at the call site). A `$space` sitting in
//      the room the actor is standing in is a workspace, not furniture: its
//      DISTINCTIVE verbs are withheld until the actor is in it. It keeps its
//      universal verbs as receiver candidates, so the handle that opens it is
//      the universal `enter` with the mount as `target` — exactly what
//      `<mount>__enter` does today.
//
// Nothing here changes world semantics. Entering a mount still moves the
// actor; the textual command parser still accepts `n`, `north` and `go north`
// whatever this projection advertises (spec/protocol/mcp.md §M9.6).

/** The subset of a gateway tool draft this module reasons over. Declared
 * structurally rather than importing `NetMcpToolDraft` so the collapse rules
 * can be unit-tested without standing up a Durable Object. */
export type CollapseDraft = {
  object: string;
  definer: string;
  verb: string;
  aliases: string[];
  argSpec: Record<string, unknown>;
  route: "direct" | "sequenced";
};

/** How one draft was classified. `universal` drafts are merged by verb name
 * across their receivers; `distinctive` ones keep the classic object-qualified
 * name; `folded` ones are not advertised at all — their name became a value of
 * the `into` tool's `parameter`. */
export type CollapseClass =
  | { kind: "universal" }
  | { kind: "distinctive" }
  | { kind: "folded"; into: string; parameter: string };

/**
 * The universal definer set for one session.
 *
 * A definer is universal when it is a base class (or attached feature) that
 * the session's context SHARES, rather than one object's own catalog type.
 * Two clauses, and both are needed:
 *
 *   (a) SHARED IN CONTEXT — the definer is a strict ancestor of at least two
 *       distinct context objects. This is the note's measured discriminator
 *       expressed as its cause: `$thing` is shared by the mug, the lamp and
 *       the couch, so `look` collapses; `$cockatoo` is the cockatoo's own
 *       type, so `the_cockatoo__look` stays object-bound even though it
 *       shadows the universal name. Shadowing is diagnostic, not an error
 *       (§M9.3).
 *
 *   (b) ANCHORED — the definer is a strict ancestor of the session ACTOR or of
 *       its ACTIVE SPACE. Clause (a) alone is unstable at the bottom end: in a
 *       room holding no second room, `$room` and `$conversational` would be
 *       ancestors of exactly one context object and the whole generic block
 *       would fragment back into `<room>__say`, `<room>__look`… — the surface
 *       shape would depend on the furniture, which is the defect this
 *       projection exists to remove. The actor and the active space are the
 *       two objects a session always has, so anchoring on them makes the
 *       universal vocabulary the same in every room of every world.
 *
 * `strict` matters in both clauses: a definer that IS the object is the
 * object's own declaration and can never be universal for it.
 *
 * A consequence worth stating, because it is a feature rather than an
 * accident: clause (b) makes the ACTIVE space's own class universal, so the
 * domain verbs of the workspace the actor is standing in are session-level
 * (`set_tempo(...)`), while the same verbs on a workspace across the room stay
 * object-bound (`the_dubspace__set_tempo`). That is the note's foreground-work
 * behaviour arriving from presence alone, with no new session concept.
 */
export function universalDefiners(
  draftsByObject: ReadonlyMap<string, readonly CollapseDraft[]>,
  actor: string,
  activeSpace: string | null
): Set<string> {
  const objectsPerDefiner = new Map<string, Set<string>>();
  for (const [object, drafts] of draftsByObject) {
    for (const draft of drafts) {
      if (draft.definer === object) continue; // the object's own declaration
      const seen = objectsPerDefiner.get(draft.definer) ?? new Set<string>();
      seen.add(object);
      objectsPerDefiner.set(draft.definer, seen);
    }
  }
  const universal = new Set<string>();
  for (const [definer, objects] of objectsPerDefiner) {
    if (objects.size >= 2) universal.add(definer); // clause (a)
  }
  for (const anchor of [actor, activeSpace]) {
    if (!anchor) continue;
    for (const draft of draftsByObject.get(anchor) ?? []) {
      if (draft.definer !== anchor) universal.add(draft.definer); // clause (b)
    }
  }
  return universal;
}

/** One folded family: the sibling that absorbed it, the parameter that now
 * carries the folded verb's name, and every accepted value. */
export type NameKeyedFamily = {
  /** `definer\0verb` of the absorbing sibling. */
  intoKey: string;
  parameter: string;
  /** Folded verb names and their aliases, sorted, for the parameter's enum. */
  values: string[];
};

/**
 * Fold name-keyed verb families.
 *
 * `authority.prefetch` entries of the form `{"path":[...]}` may contain the
 * literal `"$verb"`, which the authority planner substitutes with the invoked
 * verb's own name. A verb that reads `target.exits[$verb].dest` is therefore
 * saying "my name is a key into that map" — it is one member of a family whose
 * discriminator is data. When the SAME definer declares a sibling whose
 * otherwise-identical path reads `{"arg": i}` in that position, the sibling is
 * the family's general form: `go(exit)` reads `target.exits[exit].dest`.
 *
 * Folding the members into the general form is a structural derivation of the
 * design note's `move(exit)` with no vocabulary in core — nothing here knows
 * that "north" is a direction or that "exits" means navigation. Any catalog
 * that adopts the idiom collapses the same way.
 *
 * The fold is refused when the ambiguity would change an answer: a member that
 * matches two general forms, or a member with more than one `$verb` path, is
 * left advertised under its own name.
 */
export function foldNameKeyedFamilies(drafts: readonly CollapseDraft[]): NameKeyedFold {
  // General forms, keyed by definer + the path signature with the variable
  // position blanked. Value carries the parameter index the path reads.
  //
  // DEDUPED BY (definer, verb). One class page is drafted once per object that
  // inherits it, so a room, an outliner and a dubspace all contribute the same
  // `$room:go` — three copies of ONE general form. Counting the copies made
  // every family look ambiguous and silently disabled the fold.
  const generalForms = new Map<string, Map<string, { parameterIndex: number; definer: string }>>();
  for (const draft of drafts) {
    for (const path of prefetchPaths(draft.argSpec)) {
      const index = path.findIndex((segment) => typeof segment === "object" && segment !== null && "arg" in segment);
      if (index < 0) continue;
      const parameterIndex = (path[index] as { arg: unknown }).arg;
      if (typeof parameterIndex !== "number" || !Number.isInteger(parameterIndex) || parameterIndex < 0) continue;
      const key = pathSignature(draft.definer, path, index);
      const bucket = generalForms.get(key) ?? new Map<string, { parameterIndex: number; definer: string }>();
      // A verb that reads the same map from two different parameters is
      // ambiguous; record the first and let the arity check below decide.
      if (!bucket.has(draft.verb)) bucket.set(draft.verb, { parameterIndex, definer: draft.definer });
      generalForms.set(key, bucket);
    }
  }

  const folded = new Map<string, NameKeyedFamily>();
  const members = new Map<string, { intoKey: string; parameter: string }>();
  for (const draft of drafts) {
    const verbKeyed = prefetchPaths(draft.argSpec).filter((path) => path.includes(VERB_PLACEHOLDER));
    if (verbKeyed.length !== 1) continue; // zero: not a family member. more: ambiguous, leave it alone.
    const path = verbKeyed[0];
    const index = path.indexOf(VERB_PLACEHOLDER);
    const candidates = generalForms.get(pathSignature(draft.definer, path, index)) ?? new Map();
    // Never fold a verb into itself, and never guess between two general forms.
    const usable = [...candidates.entries()]
      .filter(([verb]) => verb !== draft.verb)
      .map(([verb, entry]) => ({ verb, ...entry }));
    if (usable.length !== 1) continue;
    const general = usable[0];
    const parameter = declaredArgumentName(general.definer, general.verb, drafts, general.parameterIndex);
    if (!parameter) continue; // the general form does not declare that parameter; refuse to invent one
    const intoKey = `${general.definer}\0${general.verb}`;
    const family = folded.get(intoKey) ?? { intoKey, parameter, values: [] };
    if (family.parameter !== parameter) continue; // two general forms disagree; leave the member advertised
    for (const value of [draft.verb, ...draft.aliases]) {
      // Command aliases carry the parser's abbreviation syntax (`g@o`); only
      // the literal forms are useful as an advertised argument value.
      if (!value || value.includes("@") || value.includes("*")) continue;
      if (!family.values.includes(value)) family.values.push(value);
    }
    family.values.sort();
    folded.set(intoKey, family);
    members.set(`${draft.definer}\0${draft.verb}`, { intoKey, parameter });
  }
  return { families: folded, members };
}

/** The result of one fold pass: the surviving general forms and their absorbed
 * values (`families`, keyed by `definer\0verb`), and the reverse index naming
 * every member that must therefore NOT be advertised (`members`, keyed the
 * same way). Both are per-call; nothing is cached across sessions. */
export type NameKeyedFold = {
  families: Map<string, NameKeyedFamily>;
  members: Map<string, { intoKey: string; parameter: string }>;
};

const VERB_PLACEHOLDER = "$verb";

/** Every `{"path":[...]}` prefetch declared by an arg spec. */
function prefetchPaths(argSpec: Record<string, unknown>): unknown[][] {
  const authority = argSpec.authority;
  if (!authority || typeof authority !== "object" || Array.isArray(authority)) return [];
  const prefetch = (authority as { prefetch?: unknown }).prefetch;
  if (!Array.isArray(prefetch)) return [];
  const out: unknown[][] = [];
  for (const entry of prefetch) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const path = (entry as { path?: unknown }).path;
    if (Array.isArray(path)) out.push(path);
  }
  return out;
}

/** A path with one position blanked, so a `$verb` member and an `{arg:i}`
 * general form on the same definer produce the same key. */
function pathSignature(definer: string, path: readonly unknown[], variableIndex: number): string {
  const parts = path.map((segment, index) => (index === variableIndex ? " *" : JSON.stringify(segment)));
  return `${definer} ${parts.join(" ")}`;
}

/** The name the general form declares for its positional parameter. Folding
 * into a parameter the verb does not declare would advertise an argument the
 * dispatcher cannot deliver, so an absent declaration refuses the fold. */
function declaredArgumentName(
  definer: string,
  verb: string,
  drafts: readonly CollapseDraft[],
  index: number
): string | null {
  const draft = drafts.find((candidate) => candidate.definer === definer && candidate.verb === verb);
  if (!draft) return null;
  const raw = Array.isArray(draft.argSpec.args) ? draft.argSpec.args : [];
  const declaration = raw[index];
  if (typeof declaration !== "string" || !declaration) return null;
  return declaration.endsWith("?") ? declaration.slice(0, -1) : declaration;
}

/** The receiver parameter a collapsed universal tool adds. Chosen so it cannot
 * shadow a parameter the verb itself declares — a verb that already has a
 * `target` keeps it, and the receiver moves to the next free name. */
export function receiverParameterName(declared: readonly string[]): string {
  for (const candidate of ["target", "target_object", "mcp_target"]) {
    if (!declared.includes(candidate)) return candidate;
  }
  // Pathological: fall back to a name no DSL identifier can collide with.
  let name = "mcp_target_2";
  let suffix = 3;
  while (declared.includes(name)) name = `mcp_target_${suffix++}`;
  return name;
}

/** The argument signature two receivers must agree on before their verb may
 * collapse into ONE tool. Same name, different parameters is a different call,
 * and merging them would advertise a schema that half the receivers reject. */
export function argumentSignature(argSpec: Record<string, unknown>): string {
  const raw = Array.isArray(argSpec.args) ? argSpec.args : Array.isArray(argSpec.params) ? argSpec.params : [];
  return raw.filter((value): value is string => typeof value === "string").join(",");
}
