# Reactive semantic-view facade

## Status

Draft design note, 2026-07-16. This note proposes an additive client-framework
facility. It does not change the substrate, wire protocol, catalog DSL, or
deployed catalog definitions.

The normative UI model remains
[`spec/protocol/ui-component-model.md`](../spec/protocol/ui-component-model.md).
If this design is accepted, its contracts should be incorporated there before
implementation is considered complete.

## Problem

The current client projection is a useful generic object read model, but it
cannot prove that a catalog-defined semantic view is complete.

Examples include:

- all rows in an outline, including parent and ordering edges;
- all notes on a pinboard, including readable note text;
- all tasks plus the actor-specific actions currently available for each task;
- the complete set of Dubspace controls and their semantic roles;
- the authoritative roster for a space.

These views currently combine thin projection, direct calls, observation
reducers, retries, stale-response checks, and component lifecycle in different
ways. The mechanisms exist in
[`src/client/framework.ts`](../src/client/framework.ts), but each tool still has
to assemble them correctly:

- `ProjectionFieldFiller` fills named properties on one projected subject.
- `CoalescedViewHydrator` coalesces a catalog-defined semantic read.
- `CoalescedRefreshController` coalesces invalidation-driven refreshes.
- `ClientProjection.applyCanonical` installs server-confirmed patches.

The Outliner failures demonstrated two recurring hazards:

1. An absent or partial projection was treated as an authoritatively empty
   collection.
2. A component connected before `woo` and `subject` were assigned, rendered its
   empty model, and did not necessarily start the read that would repair it.

Tasks previously had the same late-assignment failure. Pinboard and Dubspace
avoid related failures through catalog-specific orchestration in
`src/client/main.ts`. That orchestration is not available automatically to a
new or remotely installed catalog.

## Decision

Add a framework-neutral **reactive semantic-view store** to `WooContext`.

Catalog UI modules define bounded semantic views. The client framework owns
their lifecycle, authoritative hydration, cache, invalidation, and
stale-response rejection. Components consume immutable snapshots through a
small reactive facade.

The low-level interoperability contract is `getSnapshot()` plus `subscribe()`.
Catalog components should normally use a Web Component controller rather than
managing subscriptions directly. Future React, Lit, Solid, Vue, or Svelte
adapters can wrap the same store without changing catalog or transport
semantics.

This is closer to a small query cache than to mutable application state:

- the server remains the model;
- every view is bounded by a subject and explicit arguments;
- projection may provide a fast partial seed;
- an authoritative read establishes completeness;
- accepted observations invalidate or advance the cached result;
- the last complete result remains visible while a refresh is in flight.

## Terminology

**View definition**
: Catalog UI code that declares how to seed, authoritatively read, validate,
  and invalidate one semantic view.

**View instance**
: One principal-scoped use of a view definition for a concrete subject and
  arguments.

**View snapshot**
: The immutable value and state exposed to components.

**Complete**
: The value is complete for this declared bounded view at the recorded accepted
  revision. It does not mean complete for the world or permanently current.

**Partial**
: The value is useful for rendering but has not been confirmed as the complete
  result of the authoritative view read.

**Stale**
: The view was once complete, but a later accepted observation or explicit
  invalidation means a refresh is required.

## Minimal public contract

```ts
export type WooViewCompleteness = "unknown" | "partial" | "complete";
export type WooViewFreshness = "stale" | "current";
export type WooViewFetchStatus = "idle" | "loading" | "refreshing" | "error";

export type WooViewSnapshot<T> = Readonly<{
  data: T | null;
  completeness: WooViewCompleteness;
  freshness: WooViewFreshness;
  fetchStatus: WooViewFetchStatus;
  revision: number;
  error: unknown | null;
}>;

export type WooView<T> = {
  getSnapshot(): WooViewSnapshot<T>;
  subscribe(listener: () => void): () => void;
  refresh(): void;
};

export type WooViewRequest = {
  view: string;
  subject: string;
  args?: readonly unknown[];
};

export type WooContext = {
  // Existing members omitted.
  view<T>(request: WooViewRequest): WooView<T>;
};
```

`getSnapshot()` MUST return the same object identity while no exposed field has
changed. New immutable snapshots are published atomically. This supports
ordinary Web Components and adapters such as React's external-store hook
without binding the Woo UI ABI to a particular rendering library.

The three state axes are intentionally separate. In particular:

- `data:null, completeness:"unknown"` is not an empty collection;
- `data:[], completeness:"complete"` is an authoritatively empty collection;
- complete data may remain visible with `freshness:"stale"` and
  `fetchStatus:"refreshing"`;
- a refresh error does not erase the last complete value.

## View registration

The first version should register view definitions from the catalog UI module,
alongside component and observation-handler registration. It does not require a
catalog manifest schema change.

```ts
export type WooViewDefinition<T> = {
  id: string;

  // Optional fast value derived only from the current permission-filtered
  // projection. It is always published as partial, never complete.
  seed?: (context: WooViewSeedContext) => T | null;

  // The one authoritative, bounded semantic read.
  read: (context: WooViewReadContext) => Promise<unknown>;

  // Validate and normalize the wire result. Throwing preserves prior data and
  // publishes an error state.
  parse: (result: unknown) => T;

  // Accepted observation types that make an active instance stale. The normal
  // matcher below determines which concrete instances match.
  invalidateOn?: readonly string[];

  // Optional domain-specific subject match. The default matches an observation
  // whose source, explicit subject, or delivered space is the view subject.
  affects?: (context: WooViewInvalidationContext) => boolean;
};

export function registerWooViews(registry: WooViewRegistry): void {
  registry.view<OutlinerItem[]>({
    id: "outliner.tree",
    seed: ({ projection, subject }) =>
      projectedOutlinerItems(projection, subject),
    read: ({ woo, subject }) =>
      woo.directCall(subject, "list_items", [], { serverRead: true }),
    parse: normalizeOutlinerItems,
    invalidateOn: [
      "outline_item_added",
      "outline_item_removed",
      "outline_item_moved",
      "outline_item_reordered",
      "outline_item_hidden",
      "note_edited"
    ],
    affects: ({ observation, projection, subject }) => {
      const outliner = String(
        observation.outliner ?? observation.source ?? ""
      );
      if (outliner === subject) return true;
      const note = String(observation.note ?? "");
      return note !== "" && projection.observe(note)?.location === subject;
    }
  });
}
```

View ids are catalog-qualified by the module loader, using the same alias rules
as component ids. An unqualified `outliner.tree` in the Outliner module resolves
to the installed Outliner catalog's view.

The definition owns only domain knowledge:

- which server verb returns the semantic view;
- how to derive a provisional value from generic projection;
- how to validate and normalize the result;
- which observation types can invalidate it.

The framework owns the consistency mechanics.

### Observation matching

An invalidating observation refreshes a view instance only when:

1. its type appears in `invalidateOn`; and
2. `affects`, or the framework's default subject match, identifies the concrete
   view subject.

The current observation-handler implementation does not expose the draft spec's
general affected-subject extractor. The minimal facade therefore keeps the
matcher on the view definition. If an observation changes a container view but
only identifies a child object, `affects` may use the permission-filtered
projection to test the child's location. This keeps invalidation bounded and
avoids refreshing every active instance of a catalog view.

The first version does not run view-specific incremental reducers. It marks the
view stale and schedules one coalesced authoritative refresh. Existing generic
projection reducers and optimistic patches may still update the provisional
seed used before the refresh completes.

For this purpose, "accepted" includes sequenced observations and committed live
fanout handled as canonical projection. Lossy live previews and locally
optimistic frames MUST NOT invalidate an authoritative view by themselves.

Incremental semantic-view reducers can be considered later if measurements
show that authoritative refreshes are too expensive.

## Store lifecycle

The cache key is:

```text
(principal, qualified view id, subject, canonical serialized args)
```

Principal scope is mandatory because readable view results may contain
permission-gated data. Anonymous or unresolved principals do not share cache
entries.

For the first version the cache is memory-only. Existing principal-scoped
display caches remain unchanged. Persistent semantic-view caching adds security,
expiry, schema-version, and catalog-upgrade questions that are not necessary to
establish the facade.

### First subscriber

When the first subscriber binds:

1. Publish the optional projection seed as `partial/current`.
2. If no seed exists, publish `unknown/current`.
3. Start one authoritative read.
4. Publish `loading` while no complete result exists, otherwise `refreshing`.
5. Parse the result and atomically publish `complete/current`.

The authoritative read uses the existing `serverRead` path. A canonical
collection result must not be finalized from optimistic local execution.

### Accepted invalidation

When a matching accepted observation arrives:

1. Mark the cached complete result `stale`.
2. Schedule one coalesced authoritative refresh.
3. Keep the last complete value visible until replacement succeeds.

Live preview observations and pending optimistic patches do not establish
completeness. The first facade version does not merge a new partial seed into a
previously complete result because the framework cannot generically know how to
merge arbitrary `T`. Existing optimistic projection or component-local
presentation may remain layered outside the semantic view during migration.

### Concurrent reads

Each view instance owns a monotonically increasing generation.

- Subject, principal, view id, or arguments changing binds a different cache
  entry.
- Explicit reset increments the generation.
- An accepted invalidation increments the requested revision.
- A read result is applied only if its cache key, generation, and requested
  revision still match.
- Invalidations received during an in-flight read cause at most one follow-up
  read after the first settles.

These are framework rules, not catalog-component responsibilities.

### Errors

If the initial read fails:

- preserve a partial seed, if one exists;
- publish `fetchStatus:"error"`;
- leave completeness as `unknown` or `partial`;
- expose the error to the component.

If a refresh fails:

- preserve the last complete data;
- retain `freshness:"stale"`;
- publish `fetchStatus:"error"`;
- allow explicit `refresh()` or the next accepted invalidation to retry.

The facade does not silently convert read failure into an empty collection.

## Web Component binding

The first rendering adapter should be a small controller for the existing
custom-element ABI:

```ts
export class WooViewController<T> {
  constructor(
    host: HTMLElement,
    request: () => WooViewRequest | null,
    render: () => void
  );

  get snapshot(): WooViewSnapshot<T>;
  bind(woo: WooContext | undefined): void;
  connected(): void;
  disconnected(): void;
}
```

A catalog component may wrap `woo` and `subject` with accessors, but the
controller owns binding, subscription replacement, and refresh:

```ts
export class WooOutlinerTreeElement extends HTMLElement {
  private _woo?: WooContext;
  private _subject = "";

  private readonly tree = new WooViewController<OutlinerItem[]>(
    this,
    () => this._woo && this._subject
      ? { view: "outliner.tree", subject: this._subject }
      : null,
    () => this.render()
  );

  set woo(value: WooContext | undefined) {
    this._woo = value;
    this.tree.bind(value);
  }

  set subject(value: string | undefined) {
    this._subject = value ?? "";
    this.tree.bind(this._woo);
  }

  connectedCallback() {
    this.tree.connected();
    this.render();
  }

  disconnectedCallback() {
    this.tree.disconnected();
  }
}
```

This small amount of element plumbing is acceptable in the first version. The
correctness-sensitive work—first hydration, coalescing, state transitions,
invalidations, retry eligibility, and stale-response rejection—is centralized.

A later optional `WooReactiveElement` base class may remove the accessors for
vanilla components. It must not become mandatory because catalogs may use Lit or
another custom-element implementation.

## Relationship to generic projection

The semantic-view store does not replace `ClientProjection`.

Generic projection remains responsible for:

- object identity, ancestry, location, and ordinary readable properties;
- sequenced observation reductions;
- live previews and optimistic patches;
- bounded neighborhood observation;
- reusable object summaries consumed by many surfaces.

Semantic views sit above it:

```text
accepted snapshots + observations + optimistic layers
                         |
                  ClientProjection
                         |
          optional pure partial-view seed
                         |
     authoritative catalog view read + view cache
                         |
                 WooViewSnapshot<T>
                         |
             catalog component adapter
```

A semantic view may return joined or derived data that has no natural generic
object-property representation. The first version stores that result in the
view cache rather than forcing it into `catalogState`.

Catalog observation reducers should continue to update generic projection when
the observation has useful object-level meaning. View invalidation is not a
replacement for projection reduction.

## Impact on existing catalogs and tools

Migration is additive. Existing components continue to work while views move
one at a time.

| Catalog/tool | Current mechanism | Initial facade impact |
|---|---|---|
| Outliner | Component-owned `CoalescedViewHydrator` for `list_items` and `room_roster`; component revisions, retry timers, partial-projection merge, display cache | Best first adopter. Register `outliner.tree` first and remove item hydration revision/coalescing and stale-read logic from the element. Keep tree rendering, editing state, projection seed helper, roster behavior, and existing principal-scoped text cache initially. Migrate roster only after its post-entry convergence behavior is specified generically. |
| Pinboard | Shell-owned `pinboardNotesHydrator` and canonical patch application in `src/client/main.ts`; hydration starts only when known notes lack text | Register `pinboard.notes`. Move the `list_notes` read and its completeness decision out of `main.ts`. The authoritative result should replace board membership, so a partial projection cannot suppress missing notes. Keep note layout projection and optimistic drag/edit patches. |
| Tasks | Component-owned `CoalescedRefreshController`; `listing`, `room_roster`, and per-task `available_actions`; late `woo`/`subject` accessors | Register `tasks.board` for the listing and roster. The first migration may keep actor-specific `available_actions` inside the view definition. A later server view should return listing plus available actions in one bounded result to remove the current per-task read fan-out. |
| Dubspace | Shell detects incomplete control projection and calls `controls_view`, with compatibility fallback for aged deployed definitions; component receives a large `data` object | Register `dubspace.controls` after `outliner.tree`. Move completeness detection and refresh ownership out of `main.ts`. Migration is blocked until the aged-definition fallback is either unnecessary or expressible through a catalog-safe `WooContext` read primitive; the view definition must not import shell internals. The facade does not solve catalog-version migration. |
| Weather | Manifest `requires` fills a fixed set of properties on one block; badge receives a plain projected data object | No migration required. A semantic view adds no value while the complete display model is a bounded set of subject properties. |
| Horoscope and similar blocks | Fixed subject properties delivered through the block projection | Normally no migration. Continue using `requires`; adopt a semantic view only if the component needs a joined collection or a server-derived view whose completeness cannot be expressed as subject properties. |
| Chat components | Sequenced observation stream plus projected actor/space labels | No initial migration. Chat is an ordered event/log surface, not an authoritative replaceable semantic query result. |
| Presence surfaces | Generic presence projection and, in several tools, explicit `room_roster` reads | A later shared `core.room-roster` view could centralize cold/partial/refresh behavior. It is not part of the first slice because current post-entry fallback and retry behavior is more specialized than simple replace-on-read hydration. |

### Expected deletions after migration

Once all four main tools use the facade:

- remove catalog-specific hydration orchestration for Pinboard and Dubspace from
  `src/client/main.ts`;
- remove duplicated generation, in-flight, and refresh-queue state from
  Outliner and Tasks;
- retain `ProjectionFieldFiller` for simple `requires`-based components;
- either implement `CoalescedViewHydrator` and `CoalescedRefreshController` as
  private store internals or remove them after all direct consumers migrate.

The facade should reduce bundled-catalog knowledge in the host shell. It does
not move catalog-specific view shapes into core.

### Version and migration impact

The framework API is additive. Catalogs that do not register views continue to
use their current components and `requires` behavior.

Registering a client-side view around an existing verb does not rewrite world
state and therefore needs no worktree-data migration. Bundled catalog versions
should still advance under the normal catalog release policy so installed UI
code and its expected verb result shape remain identifiable.

If adoption adds or changes a server verb—for example, a future Tasks verb that
joins `listing` with actor-specific actions—the catalog must follow the ordinary
catalog-version and migration decision process. Persisted deployed definitions
must be upgraded or repaired before the UI may assume that verb exists. The
facade deliberately does not treat bundled source as proof that an installed
world has current bytecode.

## Simplest implementation sequence

1. Add `WooViewSnapshot`, `WooView`, `WooViewDefinition`, and a
   principal-scoped in-memory `WooViewStore` to `src/client/framework.ts`.
2. Add view registration to the UI module registry and `WooContext.view()`.
3. Add `WooViewController` for vanilla custom elements.
4. Implement exact state-machine tests with a synthetic view.
5. Migrate Outliner `list_items` only. Keep its roster and display cache
   unchanged for the first slice.
6. Exercise fresh principal, empty projection, partial projection, concurrent
   mutation, failed refresh, reconnect, and subject change in localdev and real
   workerd browser tests.
7. Migrate Pinboard, Tasks, Dubspace, and shared room roster separately.
8. After migrations, remove shell special cases and obsolete helpers.
9. Promote the accepted contract into `spec/protocol/ui-component-model.md`.

Outliner is the first adopter because its current tests already encode the
required completeness and concurrency behavior. The first implementation is
not complete merely because Outliner renders; the generic store state machine
must have catalog-independent tests.

## Required tests

Framework tests:

- `unknown` is distinguishable from authoritative `complete []`;
- a partial seed renders immediately and always triggers the initial read;
- identical `getSnapshot()` calls return the same object until state changes;
- multiple subscribers share one read;
- the last subscriber leaving does not corrupt a later rebind;
- accepted invalidations coalesce while a read is in flight;
- an old generation or revision cannot overwrite a newer result;
- refresh failure preserves complete stale data;
- changing principal, subject, view, or arguments cannot leak cached data;
- malformed results never become complete;
- unsubscribed inactive entries are eventually garbage-collected.

Component conformance tests:

- `woo` and `subject` assigned before connection;
- `woo` and `subject` assigned after connection;
- subject changed while connected;
- disconnect and reconnect during an in-flight read;
- no manual subscription leak after removal.

Per-tool browser tests:

- fresh principal sees the complete existing model before issuing a mutation;
- reload agrees with the authoritative chat or verb listing;
- cross-user mutation becomes visible;
- nested/order-sensitive structure remains correct;
- no duplicate hydration storm occurs during shell rerenders;
- localdev and real workerd exercise the same scenario.

## Non-goals for the first version

- Replacing the generic object projection.
- Adding React, Vue, Solid, or Svelte as a bundled dependency.
- Deep reactive proxies or one signal per object property.
- Suspense or exception-based loading.
- Persistent semantic-view caching.
- Arbitrary full-world queries.
- Automatic inference of catalog view shape from verb bytecode.
- Incrementally reducing every observation into every semantic view.
- Solving persisted catalog-definition upgrades or migration.
- Replacing optimistic projection patches for mutations.

## Open questions

1. Should `WooViewController` live in the ABI module or a small optional vanilla
   component-support module?
2. Should inactive view entries be discarded immediately or retained for a
   short bounded in-memory interval to make tool-tab navigation instant?
3. Is `revision:number` sufficient as a client-local publication revision, or
   should the snapshot also expose the latest accepted space sequence used to
   establish completeness?
4. Should the first Tasks view preserve the current per-task
   `available_actions` reads inside the definition, or should migration wait for
   a single server-side joined view?
5. Are the default subject match plus a pure per-view `affects` function
   sufficient, especially for child-level `note_edited` events, or should the
   observation-handler ABI gain the affected-subject extractor already
   described by the draft UI spec?

## Assessment

The facade is a moderate client-framework change with low substrate and wire
risk. The highest risks are permission-scoped caching, incorrect invalidation
subject extraction, and accidental regressions in optimistic presentation.

The expected payoff is larger than the implementation:

- new catalog tools get correct cold-start and late-binding behavior by default;
- “unknown” can no longer silently become an empty model;
- the host shell becomes more catalog-agnostic;
- existing hydration fixes become shared state-machine tests rather than
  component folklore;
- alternate rendering libraries can consume the same stable snapshots through
  small adapters.

The design should be considered successful when a new collection component can
declare one bounded authoritative view, render the facade snapshot, and pass the
shared conformance suite without implementing its own hydration generation,
retry queue, or completeness heuristic.
