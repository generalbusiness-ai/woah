export type WooObservationRoute = "sequenced" | "live";

export type ObjectProjection = {
  id: string;
  name?: string;
  owner?: string;
  parent?: string | null;
  ancestors?: string[];
  features?: string[];
  aliases?: string[];
  description?: string | null;
  location?: string | null;
  props: Record<string, unknown>;
  catalogState: Record<string, Record<string, unknown>>;
};

export type ProjectionPatch = {
  subject: string;
  // Identity/summary fields (`name`, `parent`, `location`, etc.) live here.
  fields?: Record<string, unknown>;
  // World object properties live here.
  props?: Record<string, unknown>;
  // Catalog-derived projection state lives here, grouped by catalog key.
  catalogState?: Record<string, Record<string, unknown>>;
  // Catalog-derived state groups to remove from the subject.
  clearCatalogState?: string[];
};

export type ProjectionSnapshot = {
  scope: string;
  objects: unknown[];
};

export type ProjectionOptimisticReconcile = "drop_on_applied" | "drop_on_error" | "keep_until_changed";

export type ProjectionCallOptions = {
  optimistic?: {
    id?: string;
    patches: ProjectionPatch[];
    ttlMs?: number;
    reconcile?: ProjectionOptimisticReconcile;
  };
  // Read-only view hydrations (e.g. list_items/list_notes filling note text)
  // gain nothing from optimistic local execution — the result must arrive before
  // render regardless — but pay the full local-exec cost (execution-cache rebuild
  // + state-transfer repair) when the open seed does not cover the per-item text
  // atoms. Setting `serverRead` routes the call straight to the authoritative
  // server-intent path, which answers the read in milliseconds. See
  // notes/2026-06-09-note-content-hydration.md.
  serverRead?: boolean;
};

export type ProjectionSubscriber = (value: ObjectProjection | undefined, ref: string) => void;

// Display-text accelerator cache (localStorage). Catalog views (outliner items,
// pinboard notes) read text fields that the generic projection deliberately omits
// because they are catalog-defined and read-gated; that text arrives via a verb
// hydration whose latency is bounded by the relay scope-open handshake on a cold
// reload. Stashing the last-seen text lets a reload paint text with the structure;
// the authoritative hydration read still runs and overwrites it.
//
// SECURITY: this is read-gated content, so the cache key MUST be namespaced by the
// viewing principal — callers build keys via `displayTextCacheKey(namespace, actor,
// subject)`, which refuses to produce a key without an actor. That isolates one
// principal's cache from another on a shared device and across a guest re-login.
// `pruneDisplayTextCaches(currentActor)` additionally drops other principals' caches
// when a principal is established. See notes/2026-06-09-note-content-hydration.md.

// `woo.<namespace>.text.<actor>.<subject>`. Returns "" (cache disabled) when the
// actor or subject is missing, so an unauthenticated/unknown principal neither
// reads nor writes the cache.
export function displayTextCacheKey(namespace: string, actor: string | null | undefined, subject: string): string {
  if (!namespace || !actor || !subject) return "";
  return `woo.${namespace}.text.${actor}.${subject}`;
}

export function clearDisplayTextCaches(): void {
  pruneDisplayTextCaches(null);
}

// Remove every display-text cache that does NOT belong to `keepActor`. Called when
// a principal is established so a different principal's read-gated text is dropped
// from the device (isolation + disk hygiene), while the CURRENT principal's cache
// survives — which it must, so a reload still paints text with the structure.
// `keepActor` null/empty drops all (explicit logout). The actor segment is the 4th
// dotted field of `woo.<ns>.text.<actor>.<subject>` (refs contain no dots).
export function pruneDisplayTextCaches(keepActor: string | null | undefined): void {
  try {
    const store = globalThis.localStorage;
    if (!store) return;
    for (const key of Object.keys(store)) {
      const match = key.match(/^woo\.[a-z0-9_]+\.text\.([^.]+)\./);
      if (match && match[1] !== keepActor) store.removeItem(key);
    }
  } catch {
    // localStorage may be unavailable; nothing to purge.
  }
}

export function readDisplayTextCache(key: string): Record<string, string> {
  if (!key) return {};
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [id, text] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof id === "string" && typeof text === "string") out[id] = text;
    }
    return out;
  } catch {
    return {};
  }
}

export function writeDisplayTextCache(key: string, map: Record<string, string>): void {
  if (!key) return;
  try {
    const store = globalThis.localStorage;
    if (!store) return;
    if (Object.keys(map).length === 0) store.removeItem(key);
    else store.setItem(key, JSON.stringify(map));
  } catch {
    // localStorage may be unavailable (private mode / quota); the cache is optional.
  }
}

export function liveProjectionKey(type: string, subject: string, discriminator?: string): string {
  return ["live", type, subject, discriminator].filter((part) => part !== undefined && part !== "").map(String).join(":");
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char] ?? char));
}

const AMBIENT_COMPANION_PANEL_SELECTOR = "[data-ambient-companion-shell] [data-space-chat-panel]";

export function renderAmbientCompanionShell(subject: string, workspaceHtml: string): string {
  return `<section class="ambient-companion-shell" data-ambient-companion-shell="${escapeHtml(subject)}">${workspaceHtml}<div data-ambient-companion></div></section>`;
}

export type ToolFrameOptions = {
  // Subject ref the workspace acts on — the space/board/registry id. Used by
  // the chat slot (data-space-chat-space) and by the layout
  // (data-space-chat-layout). Identical at both points by contract.
  subject: string;
  // Pre-rendered <section class="toolbar TOOL-toolbar">...</section>. Owns the
  // <h1> title plus any tool-specific buttons. Every tool MUST use the shared
  // .toolbar class so the ambient-companion-shell's height budget
  // (calc(100dvh - 5.25rem)) lines up — bespoke headers drift, see the
  // 2026-05-18 outliner-header incident.
  toolbar: string;
  // Tool-specific layout class applied alongside `.split.split--side-fixed`.
  // Examples: "pinboard-layout", "dubspace-layout", "woo-tasks-layout",
  // "outliner-layout". Owns column sizes and inner work-area styling.
  layoutClass: string;
  // Inner HTML of the .split section — the work area on the left and the
  // presence aside on the right. The helper provides the wrapping section
  // and the `has-ambient-companion` toggle.
  layoutBody: string;
  // True when the actor is present in the space and the mini-chat panel
  // should dock under the workspace. False renders the layout bare (no chat
  // slot, no `has-ambient-companion` class).
  showChat: boolean;
};

// Canonical tool-frame structure used by every catalog workspace component.
// Produces, in order: the toolbar; then either an ambient-companion shell
// (wrapping the split + chat slot) or the bare split. Centralizing this
// pairing here is what stops per-tool drift in chat-panel anchoring; see
// notes/2026-05-08-layering.md item #11.
export function renderToolFrame(opts: ToolFrameOptions): string {
  const splitClasses = [
    "split",
    "split--side-fixed",
    opts.layoutClass,
    opts.showChat ? "has-ambient-companion" : ""
  ].filter(Boolean).join(" ");
  const layout = `<section class="${splitClasses}" data-space-chat-layout="${escapeHtml(opts.subject)}">${opts.layoutBody}</section>`;
  if (!opts.showChat) return `${opts.toolbar}${layout}`;
  return `${opts.toolbar}${renderAmbientCompanionShell(opts.subject, layout)}`;
}

export function preserveAmbientCompanionPanel(root: ParentNode, subject: string): HTMLElement | null {
  const existing = root.querySelector<HTMLElement>(AMBIENT_COMPANION_PANEL_SELECTOR);
  if (existing && existing.dataset.spaceChatSpace !== subject) existing.remove();
  return root.querySelector<HTMLElement>(AMBIENT_COMPANION_PANEL_SELECTOR);
}

export function restoreAmbientCompanionPanel(root: ParentNode, panel: HTMLElement | null): boolean {
  if (!panel) return false;
  const slot = root.querySelector<HTMLElement>("[data-ambient-companion]");
  if (!slot) return false;
  slot.append(panel);
  return true;
}

export type DeliveredObservation = {
  route: WooObservationRoute;
  seq?: number;
  space?: string;
  frameId?: string;
  receivedAt: number;
  optimistic?: boolean;
};

export type ObservationEnvelope = {
  observation: Record<string, unknown>;
  delivered: DeliveredObservation;
};

export type ClientProjectionDraft = {
  patchObject(ref: string, fields: Record<string, unknown>): void;
  patchObjectProps(ref: string, props: Record<string, unknown>): void;
  patchCatalogState(ref: string, key: string, fields: Record<string, unknown>): void;
  clearCatalogState(ref: string, key: string): void;
  clearAuthoritative(ref: string): void;
};

export type WooObservationHandler = {
  types: string[];
  route?: WooObservationRoute | "both";
  liveProjection?: "preview" | "canonical";
  reduce: (draft: ClientProjectionDraft, envelope: ObservationEnvelope) => void;
};

export type FrameStateRecord = {
  subject: string;
  view?: string;
  values: Record<string, unknown>;
};

export type WooUiAction =
  | { type: "set_frame_state"; frame: string; key: string; value: unknown }
  | { type: "merge_frame_state"; frame: string; values: Record<string, unknown> }
  | { type: "open_overlay"; subject: string; view?: string; frame?: string; state?: Record<string, unknown> }
  | { type: "close_overlay"; frame?: string };

export type OverlayFrame = {
  id: string;
  subject: string;
  view?: string;
  state: Record<string, unknown>;
};

export type UiModuleDecl = {
  id: string;
  entry: string;
  sha256?: string;
};

export type UiComponentDecl = {
  id: string;
  module: string;
  tag: string;
  surface: string;
  subject?: string;
  neighborhood?: Record<string, unknown>;
  // Property names the component needs from its subject's projection. The host
  // uses these to ensure a full object summary is folded into the canonical
  // projection layer when the component binds — room-contents snapshots and
  // similar thin payloads do not carry props.
  requires?: string[];
};

export type UiFrameDecl = {
  id?: string;
  subject: string;
  view?: string;
  layout: string;
  /** Optional catalog-owned cold-view hydration. The named module registers
   * the implementation; the shell supplies transport/projection capabilities
   * and applies the returned generic patches without learning catalog state. */
  hydration?: { module: string; id: string };
  /** Optional app-shell discovery metadata. It names navigation presentation,
   * never transport or mutation behavior. */
  navigation?: { tab: string; label: string; aliases?: string[]; host_attribute?: string };
  regions: Record<string, UiNodeDecl[]>;
  state?: Record<string, unknown>;
};

export type UiNodeDecl = {
  component: string;
  subject: unknown;
  surface?: string;
  related?: Record<string, unknown>;
  neighborhood?: Record<string, unknown>;
  state?: string[];
  props?: Record<string, unknown>;
  when?: Record<string, unknown>;
};

export type UiObservationHandlerDecl = {
  module: string;
  types: string[];
};

export type UiChatFormatterDecl = {
  module: string;
  types: string[];
};

export type UiWorldSnapshotAdapterDecl = {
  module: string;
};

export type CatalogUiManifest = {
  abi: string;
  modules?: UiModuleDecl[];
  components?: UiComponentDecl[];
  frames?: UiFrameDecl[];
  observation_handlers?: UiObservationHandlerDecl[];
  chat_formatters?: UiChatFormatterDecl[];
  world_snapshot_adapters?: UiWorldSnapshotAdapterDecl[];
};

export type CatalogUiPackage = {
  alias: string;
  catalog: string;
  objects?: Record<string, string>;
  ui: CatalogUiManifest;
};

export type RegisteredComponent = {
  catalog: CatalogUiPackage;
  declaration: UiComponentDecl;
  qualifiedId: string;
};

export type ResolvedFrame = {
  catalog: CatalogUiPackage;
  frame: UiFrameDecl;
  distance: number;
  rank: number;
};

type CustomElementRegistryLike = {
  define(tag: string, ctor: CustomElementConstructor): void;
  get(tag: string): CustomElementConstructor | undefined;
};

type ModuleExports = {
  registerWooComponents?: (registry: WooComponentRegistry) => void;
  registerWooObservationHandlers?: (registry: ObservationRegistry) => void;
  registerWooChatFormatters?: (registry: ChatFormatterRegistry) => void;
  registerWooViewHydrations?: (registry: WooViewHydrationRegistry) => void;
  registerWooViews?: (registry: WooViewRegistry) => void;
  registerWooWorldSnapshotAdapters?: (registry: WooWorldSnapshotAdapterRegistry) => void;
};

export type WooComponentRegistry = {
  defineTag(tag: string, ctor: CustomElementConstructor): void;
};

export type WooViewHydrationContext = {
  subject: string;
  frameState: Readonly<Record<string, unknown>>;
  present: boolean;
  installedCatalogs: readonly unknown[];
  observe(ref: string): ObjectProjection | null;
  call(target: string, verb: string, args?: unknown[], options?: ProjectionCallOptions): Promise<unknown>;
  readCell(key: string): Promise<unknown>;
  nameOf(ref: string): string;
};

/** Catalog-owned semantic hydration. `complete` must be cheap and side-effect
 * free because render paths may ask repeatedly; `read` returns only generic
 * projection patches, keeping catalog vocabulary out of the shell. */
export type WooViewHydration = {
  complete(context: WooViewHydrationContext): boolean;
  read(context: WooViewHydrationContext): Promise<ProjectionPatch[]>;
};

export type WooViewHydrationRegistry = {
  define(id: string, hydration: WooViewHydration): void;
};

export type RegisteredViewHydration = {
  id: string;
  hydration: WooViewHydration;
};

export type WooNeighborhood = {
  subject: string;
  refs: readonly string[];
  related: Readonly<Record<string, string | null>>;
  has(ref: string): boolean;
};

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

export type WooViewSeedContext = {
  projection: ClientProjection;
  woo: WooContext;
  subject: string;
  args: readonly unknown[];
};

export type WooViewReadContext = WooViewSeedContext;

export type WooViewInvalidationContext = WooViewSeedContext & {
  observation: Record<string, unknown>;
  delivered: DeliveredObservation;
};

export type WooViewDefinition<T> = {
  id: string;
  seed?: (context: WooViewSeedContext) => T | null;
  read: (context: WooViewReadContext) => Promise<unknown>;
  parse: (result: unknown) => T;
  invalidateOn?: readonly string[];
  affects?: (context: WooViewInvalidationContext) => boolean;
};

export type WooViewRegistry = {
  view<T>(definition: WooViewDefinition<T>): void;
};

/** Catalog-owned compatibility translation for legacy whole-world payloads.
 * Adapters return generic projection patches, keeping historical catalog wire
 * shapes out of the client substrate. */
export type WooWorldSnapshotAdapter = (world: unknown) => ProjectionPatch[];

export type WooWorldSnapshotAdapterRegistry = {
  adapt(adapter: WooWorldSnapshotAdapter): void;
};

export type WooFrameContext = {
  id: string;
  subject: string;
  view?: string;
  get(key: string): unknown;
  set(key: string, value: unknown): boolean;
};

export type WooContext = {
  actor: string | null;
  frame: WooFrameContext;
  neighborhood: WooNeighborhood;
  observe(ref: string): ObjectProjection | null;
  call(target: string, verb: string, args?: unknown[], options?: ProjectionCallOptions): Promise<unknown>;
  send(command: string, space?: string, options?: ProjectionCallOptions): Promise<unknown>;
  directCall(target: string, verb: string, args?: unknown[], options?: ProjectionCallOptions): Promise<unknown>;
  /** Catalog-defined bounded semantic reads. Optional only for compatibility
   * with UI contexts authored before the additive facade; new collection
   * components should require it rather than rebuilding hydration locally. */
  view?<T>(request: WooViewRequest): WooView<T>;
  emit(action: WooUiAction): boolean;
};

export type WooElement = HTMLElement & {
  woo?: WooContext;
  subject?: string;
  related?: Record<string, string | null>;
  node?: UiNodeDecl;
};

type ProjectionLayer = {
  patches: Map<string, ProjectionPatch>;
  expiresAt?: number;
  revision: number;
};

type OptimisticCallRecord = {
  layerId: string;
  revision: number;
  reconcile: ProjectionOptimisticReconcile;
};

export type ApplyCanonicalOptions = {
  // `replace` is per field group: fields/props merge as usual, while each
  // catalogState key present in the patch is cleared before its new fields are
  // applied. CatalogState keys absent from the patch are left alone.
  mode?: "merge" | "replace";
};

const LIVE_TTL_MS = 1_600;
const OPTIMISTIC_TTL_MS = 5_000;

export class CatalogUiRegistry {
  private catalogs = new Map<string, CatalogUiPackage>();
  private components = new Map<string, RegisteredComponent>();
  private declaredTags = new Map<string, RegisteredComponent>();
  private definedTags = new Map<string, CustomElementConstructor>();
  private loadedModules = new Set<string>();
  private viewHydrations = new Map<string, WooViewHydration>();
  private views = new Map<string, WooViewDefinition<unknown>>();
  private worldSnapshotAdapters: WooWorldSnapshotAdapter[] = [];

  installCatalogUi(pkg: CatalogUiPackage): string[] {
    if (pkg.ui.abi !== "woo-ui/v1") return [`unsupported UI ABI for ${pkg.alias}: ${pkg.ui.abi}`];
    const diagnostics: string[] = [];
    this.catalogs.set(pkg.alias, pkg);
    for (const component of pkg.ui.components ?? []) {
      const qualifiedId = qualifyComponentId(pkg.alias, component.id);
      if (this.components.has(qualifiedId)) diagnostics.push(`duplicate component id: ${qualifiedId}`);
      else this.components.set(qualifiedId, { catalog: pkg, declaration: component, qualifiedId });
      if (!component.tag.includes("-")) diagnostics.push(`component tag must contain a hyphen: ${component.tag}`);
      const existing = this.declaredTags.get(component.tag);
      if (existing && existing.qualifiedId !== qualifiedId) diagnostics.push(`duplicate component tag: ${component.tag}`);
      else this.declaredTags.set(component.tag, { catalog: pkg, declaration: component, qualifiedId });
    }
    return diagnostics;
  }

  component(id: string, declaringAlias?: string): RegisteredComponent | undefined {
    const resolved = this.resolveComponentId(id, declaringAlias);
    return resolved ? this.components.get(resolved) : undefined;
  }

  /** Resolve the default frame that declares a component. Tool shells already
   * know which component they mounted, so this is the authoritative fallback
   * when a sparse remote projection has not supplied enough lineage to match
   * the frame's subject constraint yet. Keeping the lookup in the registry
   * avoids teaching the shell catalog-specific frame identities. */
  frameForComponent(id: string, declaringAlias?: string): ResolvedFrame | undefined {
    const component = this.component(id, declaringAlias);
    if (!component) return undefined;
    const frames = (component.catalog.ui.frames ?? []).flatMap((frame) => {
      const rank = frameRank(frame, undefined);
      if (rank === undefined) return [];
      const declaresComponent = Object.values(frame.regions ?? {}).flat().some((node) =>
        this.resolveComponentId(node.component, component.catalog.alias) === component.qualifiedId
      );
      return declaresComponent ? [{ catalog: component.catalog, frame, rank, distance: 0 }] : [];
    });
    return frames.sort((left, right) => left.rank - right.rank || String(left.frame.id ?? "").localeCompare(String(right.frame.id ?? "")))[0];
  }

  componentsForSurface(surface: string): RegisteredComponent[] {
    const wanted = String(surface ?? "");
    if (!wanted) return [];
    return [...this.components.values()].filter((component) => component.declaration.surface === wanted);
  }

  resolveComponentId(id: string, declaringAlias?: string): string | undefined {
    const raw = String(id ?? "");
    if (!raw) return undefined;
    if (raw.includes(":")) return this.components.has(raw) ? raw : undefined;
    if (declaringAlias) {
      const local = qualifyComponentId(declaringAlias, raw);
      if (this.components.has(local)) return local;
    }
    const matches = [...this.components.keys()].filter((qualified) => qualified.endsWith(`:${raw}`));
    return matches.length === 1 ? matches[0] : undefined;
  }

  allowedTagsForModule(alias: string, moduleId: string): string[] {
    const pkg = this.catalogs.get(alias);
    if (!pkg) return [];
    return (pkg.ui.components ?? []).filter((component) => component.module === moduleId).map((component) => component.tag);
  }

  defineTag(alias: string, moduleId: string, tag: string, ctor: CustomElementConstructor, registry: CustomElementRegistryLike = customElements): void {
    if (!this.allowedTagsForModule(alias, moduleId).includes(tag)) throw new Error(`tag ${tag} is not declared for ${alias}:${moduleId}`);
    const existing = registry.get(tag);
    if (existing && existing !== ctor) throw new Error(`custom element tag already defined: ${tag}`);
    const prior = this.definedTags.get(tag);
    if (prior && prior !== ctor) throw new Error(`custom element tag already registered by another module: ${tag}`);
    if (!existing) registry.define(tag, ctor);
    this.definedTags.set(tag, ctor);
  }

  defineViewHydration(alias: string, moduleId: string, id: string, hydration: WooViewHydration): void {
    const pkg = this.catalogs.get(alias);
    if (!pkg) throw new Error(`unknown catalog UI alias: ${alias}`);
    const declared = (pkg.ui.frames ?? []).some((frame) => frame.hydration?.module === moduleId && frame.hydration.id === id);
    if (!declared) throw new Error(`view hydration ${id} is not declared for ${alias}:${moduleId}`);
    const key = `${alias}:${moduleId}:${id}`;
    if (this.viewHydrations.has(key)) throw new Error(`view hydration already registered: ${key}`);
    this.viewHydrations.set(key, hydration);
  }

  viewHydration(resolved: ResolvedFrame | undefined): RegisteredViewHydration | undefined {
    const declaration = resolved?.frame.hydration;
    if (!resolved || !declaration) return undefined;
    const id = `${resolved.catalog.alias}:${declaration.module}:${declaration.id}`;
    const hydration = this.viewHydrations.get(id);
    return hydration ? { id, hydration } : undefined;
  }

  defineView<T>(alias: string, definition: WooViewDefinition<T>): void {
    if (!this.catalogs.has(alias)) throw new Error(`unknown catalog UI alias: ${alias}`);
    const id = String(definition.id ?? "");
    if (!id || id.includes(":")) throw new Error(`view id must be nonempty and unqualified: ${id}`);
    const qualified = `${alias}:${id}`;
    if (this.views.has(qualified)) throw new Error(`view already registered: ${qualified}`);
    this.views.set(qualified, definition as WooViewDefinition<unknown>);
  }

  resolveView<T>(id: string, declaringAlias?: string): { id: string; definition: WooViewDefinition<T> } | undefined {
    const raw = String(id ?? "");
    if (!raw) return undefined;
    if (raw.includes(":")) {
      const definition = this.views.get(raw);
      return definition ? { id: raw, definition: definition as WooViewDefinition<T> } : undefined;
    }
    if (declaringAlias) {
      const qualified = `${declaringAlias}:${raw}`;
      const definition = this.views.get(qualified);
      if (definition) return { id: qualified, definition: definition as WooViewDefinition<T> };
    }
    const matches = [...this.views.entries()].filter(([qualified]) => qualified.endsWith(`:${raw}`));
    return matches.length === 1
      ? { id: matches[0][0], definition: matches[0][1] as WooViewDefinition<T> }
      : undefined;
  }

  worldSnapshotPatches(world: unknown): ProjectionPatch[] {
    return this.worldSnapshotAdapters.flatMap((adapter) => adapter(world));
  }

  private assertWorldSnapshotAdapterDeclared(alias: string, moduleId: string, mod: ModuleExports): void {
    if (!mod.registerWooWorldSnapshotAdapters) return;
    const pkg = this.catalogs.get(alias);
    const declared = (pkg?.ui.world_snapshot_adapters ?? []).some((entry) => entry.module === moduleId);
    if (!declared) throw new Error(`world snapshot adapter is not declared for ${alias}:${moduleId}`);
  }

  private registerWorldSnapshotAdapters(mod: ModuleExports): void {
    if (!mod.registerWooWorldSnapshotAdapters) return;
    mod.registerWooWorldSnapshotAdapters({
      adapt: (adapter) => this.worldSnapshotAdapters.push(adapter)
    });
  }

  async loadModule(
    alias: string,
    moduleId: string,
    url: string,
    observations: ObservationRegistry,
    chatFormatters: ChatFormatterRegistry,
    importModule: (url: string) => Promise<ModuleExports> = (href) => import(/* @vite-ignore */ href) as Promise<ModuleExports>
  ): Promise<void> {
    const key = `${alias}:${moduleId}`;
    if (this.loadedModules.has(key)) return;
    const pkg = this.catalogs.get(alias);
    if (!pkg) throw new Error(`unknown catalog UI alias: ${alias}`);
    if (!(pkg.ui.modules ?? []).some((module) => module.id === moduleId)) throw new Error(`unknown UI module ${moduleId} for ${alias}`);
    const mod = await importModule(url);
    this.assertWorldSnapshotAdapterDeclared(alias, moduleId, mod);
    mod.registerWooComponents?.({ defineTag: (tag, ctor) => this.defineTag(alias, moduleId, tag, ctor) });
    mod.registerWooObservationHandlers?.(observations);
    mod.registerWooChatFormatters?.(chatFormatters);
    mod.registerWooViewHydrations?.({ define: (id, hydration) => this.defineViewHydration(alias, moduleId, id, hydration) });
    mod.registerWooViews?.({ view: (definition) => this.defineView(alias, definition) });
    this.registerWorldSnapshotAdapters(mod);
    this.loadedModules.add(key);
  }

  registerModuleExports(alias: string, moduleId: string, mod: ModuleExports, observations: ObservationRegistry, chatFormatters: ChatFormatterRegistry): void {
    const key = `${alias}:${moduleId}`;
    if (this.loadedModules.has(key)) return;
    const pkg = this.catalogs.get(alias);
    if (!pkg) throw new Error(`unknown catalog UI alias: ${alias}`);
    if (!(pkg.ui.modules ?? []).some((module) => module.id === moduleId)) throw new Error(`unknown UI module ${moduleId} for ${alias}`);
    this.assertWorldSnapshotAdapterDeclared(alias, moduleId, mod);
    mod.registerWooComponents?.({ defineTag: (tag, ctor) => this.defineTag(alias, moduleId, tag, ctor) });
    mod.registerWooObservationHandlers?.(observations);
    mod.registerWooChatFormatters?.(chatFormatters);
    mod.registerWooViewHydrations?.({ define: (id, hydration) => this.defineViewHydration(alias, moduleId, id, hydration) });
    mod.registerWooViews?.({ view: (definition) => this.defineView(alias, definition) });
    this.registerWorldSnapshotAdapters(mod);
    this.loadedModules.add(key);
  }

  resolveFrame(subject: string, view: string | undefined, isA: (subject: string, classRef: string) => number | false): ResolvedFrame | undefined {
    const candidates: ResolvedFrame[] = [];
    for (const pkg of this.catalogs.values()) {
      for (const frame of pkg.ui.frames ?? []) {
        const rank = frameRank(frame, view);
        if (rank === undefined) continue;
        if (frame.subject === subject) {
          candidates.push({ catalog: pkg, frame, rank, distance: 0 });
          continue;
        }
        const classRef = resolveCatalogRef(pkg, frame.subject);
        const distance = isA(subject, classRef);
        if (distance !== false) candidates.push({ catalog: pkg, frame, rank: rank + 2, distance });
      }
    }
    return candidates.sort((a, b) => a.rank - b.rank || a.distance - b.distance || String(a.frame.id ?? "").localeCompare(String(b.frame.id ?? "")))[0];
  }
}

export class ClientProjection {
  private canonical = new Map<string, ObjectProjection>();
  private scopedCanonical = new Map<string, Map<string, ObjectProjection>>();
  private authoritativeCanonical = new Map<string, ProjectionPatch>();
  private scopeOrder: string[] = [];
  private sequenced = new Map<string, ProjectionPatch>();
  private live = new Map<string, ProjectionLayer>();
  private optimistic = new Map<string, ProjectionLayer>();
  private optimisticCalls = new Map<string, OptimisticCallRecord>();
  private subscribers = new Map<string, Set<ProjectionSubscriber>>();

  ingestWorld(world: any, catalogPatches: ProjectionPatch[] = []) {
    const changed = new Set(this.canonical.keys());
    this.scopedCanonical.clear();
    this.scopeOrder = [];
    this.authoritativeCanonical.clear();
    this.canonical.clear();
    for (const [id, obj] of Object.entries(world?.objects ?? {})) {
      this.canonical.set(id, normalizeObjectProjection(id, obj));
      changed.add(id);
    }
    for (const patch of catalogPatches) {
      const subject = String(patch.subject ?? "");
      if (!subject) continue;
      this.patchCanonical(subject, patch);
      changed.add(subject);
    }
    this.pruneExpired(Date.now(), changed);
    this.notify(changed);
  }

  ingestSnapshot(snapshot: ProjectionSnapshot): void;
  ingestSnapshot(scope: string, objects: unknown[]): void;
  ingestSnapshot(scopeOrSnapshot: string | ProjectionSnapshot, maybeObjects?: unknown[]) {
    const scope = typeof scopeOrSnapshot === "string" ? scopeOrSnapshot : String(scopeOrSnapshot.scope ?? "");
    const objects = typeof scopeOrSnapshot === "string" ? maybeObjects ?? [] : scopeOrSnapshot.objects;
    if (!scope) return;
    if (!this.scopedCanonical.has(scope)) {
      this.scopedCanonical.set(scope, new Map());
      this.scopeOrder.push(scope);
    }
    const next = new Map<string, ObjectProjection>();
    for (const obj of Array.isArray(objects) ? objects : []) {
      const id = objectProjectionId(obj);
      if (!id) continue;
      next.set(id, normalizeObjectProjection(id, obj));
    }
    const prev = this.scopedCanonical.get(scope) ?? new Map();
    this.scopedCanonical.set(scope, next);
    const changed = new Set<string>([...prev.keys(), ...next.keys()]);
    for (const id of changed) this.rebuildCanonicalObject(id);
    this.notify(changed);
  }

  observe(ref: string): ObjectProjection | undefined {
    const id = String(ref ?? "");
    if (!id) return undefined;
    const merged = cloneObjectProjection(this.canonical.get(id) ?? emptyObjectProjection(id));
    applyPatch(merged, this.sequenced.get(id));
    for (const layer of this.live.values()) applyPatch(merged, layer.patches.get(id));
    for (const layer of this.optimistic.values()) applyPatch(merged, layer.patches.get(id));
    return hasProjectionData(merged) ? merged : undefined;
  }

  subscribe(ref: string, listener: ProjectionSubscriber, options: { emitCurrent?: boolean } = {}): () => void {
    const id = String(ref ?? "");
    if (!id) return () => {};
    let listeners = this.subscribers.get(id);
    if (!listeners) {
      listeners = new Set();
      this.subscribers.set(id, listeners);
    }
    listeners.add(listener);
    if (options.emitCurrent === true) listener(this.observe(id), id);
    return () => {
      const current = this.subscribers.get(id);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.subscribers.delete(id);
    };
  }

  applySequenced(patches: ProjectionPatch[]) {
    const changed = new Set<string>();
    for (const patch of patches) {
      const subject = String(patch.subject ?? "");
      if (!subject) continue;
      this.sequenced.set(subject, mergePatch(this.sequenced.get(subject), patch));
      clearPatchFieldsFromLayers(this.live, patch);
      clearPatchFieldsFromLayers(this.optimistic, patch);
      changed.add(subject);
    }
    this.notify(changed);
  }

  // Authoritative direct-call results can confirm state outside the sequenced
  // log. Fold those patches into canonical projection so they survive later
  // scoped-snapshot ingestion while still clearing overlapping live/optimistic
  // layers.
  applyCanonical(patches: ProjectionPatch[], options: ApplyCanonicalOptions = {}) {
    const changed = new Set<string>();
    for (const patch of patches) {
      const subject = String(patch.subject ?? "");
      if (!subject) continue;
      const canonicalPatch = options.mode === "replace" ? replacementPatch(patch) : patch;
      this.authoritativeCanonical.set(subject, options.mode === "replace" ? canonicalPatch : mergePatch(this.authoritativeCanonical.get(subject), patch));
      this.patchCanonical(subject, canonicalPatch);
      clearPatchFieldsFromLayers(this.live, patch);
      clearPatchFieldsFromLayers(this.optimistic, patch);
      changed.add(subject);
    }
    this.notify(changed);
  }

  clearAuthoritative(subject: string, options: { notify?: boolean } = {}) {
    const id = String(subject ?? "");
    if (!id || !this.authoritativeCanonical.delete(id)) return false;
    this.rebuildCanonicalObject(id);
    if (options.notify !== false) this.notify(new Set([id]));
    return true;
  }

  applyLive(id: string, patches: ProjectionPatch[], expiresMs = LIVE_TTL_MS): number {
    return this.applyTimedLayer(this.live, id, patches, expiresMs);
  }

  applyOptimistic(id: string, patches: ProjectionPatch[], expiresMs = OPTIMISTIC_TTL_MS): number {
    return this.applyTimedLayer(this.optimistic, id, patches, expiresMs);
  }

  applyOptimisticCall(callId: string, options: ProjectionCallOptions | undefined) {
    const optimistic = options?.optimistic;
    const id = String(callId ?? "");
    if (!id || !optimistic || optimistic.patches.length === 0) return;
    const prior = this.optimisticCalls.get(id);
    if (prior) this.clearOptimistic(prior.layerId, prior.revision);
    const layerId = String(optimistic.id ?? `call:${id}`);
    const revision = this.applyOptimistic(layerId, optimistic.patches, optimistic.ttlMs ?? OPTIMISTIC_TTL_MS);
    this.optimisticCalls.set(id, { layerId, revision, reconcile: optimistic.reconcile ?? "drop_on_applied" });
  }

  completeOptimisticCall(callId: string) {
    const record = this.optimisticCalls.get(String(callId ?? ""));
    if (!record) return;
    this.optimisticCalls.delete(String(callId ?? ""));
    if (record.reconcile === "drop_on_applied") this.clearOptimistic(record.layerId, record.revision);
  }

  failOptimisticCall(callId: string) {
    const record = this.optimisticCalls.get(String(callId ?? ""));
    if (!record) return;
    this.optimisticCalls.delete(String(callId ?? ""));
    this.clearOptimistic(record.layerId, record.revision);
  }

  clearLive(id: string) {
    const subjects = subjectsInLayer(this.live.get(id));
    this.live.delete(id);
    this.notify(subjects);
  }

  clearOptimistic(id: string, revision?: number) {
    const layer = this.optimistic.get(id);
    if (revision !== undefined && layer?.revision !== revision) return;
    const subjects = subjectsInLayer(layer);
    this.optimistic.delete(id);
    this.notify(subjects);
  }

  clearOptimisticForSubject(subject: string) {
    if (clearSubjectFromLayers(this.optimistic, subject)) this.notify(new Set([subject]));
  }

  prune(now = Date.now()): boolean {
    const changed = new Set<string>();
    return this.pruneExpired(now, changed);
  }

  refs(): string[] {
    const refs = new Set<string>(this.canonical.keys());
    for (const id of this.sequenced.keys()) refs.add(id);
    for (const layer of this.live.values()) {
      for (const id of layer.patches.keys()) refs.add(id);
    }
    for (const layer of this.optimistic.values()) {
      for (const id of layer.patches.keys()) refs.add(id);
    }
    return [...refs];
  }

  private applyTimedLayer(target: Map<string, ProjectionLayer>, id: string, patches: ProjectionPatch[], expiresMs: number): number {
    const layerId = String(id ?? "");
    if (!layerId) return 0;
    const current = target.get(layerId);
    const layer: ProjectionLayer = current ?? { patches: new Map(), revision: 0 };
    const changed = new Set(subjectsInLayer(layer));
    layer.revision += 1;
    layer.expiresAt = Date.now() + Math.max(0, expiresMs);
    for (const patch of patches) {
      const subject = String(patch.subject ?? "");
      if (!subject) continue;
      layer.patches.set(subject, mergePatch(layer.patches.get(subject), patch));
      changed.add(subject);
    }
    target.set(layerId, layer);
    this.notify(changed);
    return layer.revision;
  }

  private upsertCanonicalObject(id: string, obj: unknown) {
    this.canonical.set(id, mergeObjectProjection(this.canonical.get(id) ?? emptyObjectProjection(id), normalizeObjectProjection(id, obj)));
  }

  private patchCanonical(id: string, patch: Omit<ProjectionPatch, "subject">) {
    const current = this.canonical.get(id) ?? emptyObjectProjection(id);
    applyPatch(current, { subject: id, ...patch });
    this.canonical.set(id, current);
  }

  private rebuildCanonicalObject(id: string) {
    let next: ObjectProjection | undefined;
    for (const scope of this.scopeOrder) {
      const scoped = this.scopedCanonical.get(scope)?.get(id);
      if (!scoped) continue;
      next = next ? mergeObjectProjection(next, scoped) : cloneObjectProjection(scoped);
    }
    const authoritative = this.authoritativeCanonical.get(id);
    if (authoritative) {
      const patched = next ?? emptyObjectProjection(id);
      applyPatch(patched, authoritative);
      next = hasProjectionData(patched) ? patched : undefined;
    }
    if (next) this.canonical.set(id, next);
    else this.canonical.delete(id);
  }

  private pruneExpired(now: number, changed: Set<string>): boolean {
    const didPrune = pruneLayers(this.live, now, changed) || pruneLayers(this.optimistic, now, changed);
    if (didPrune) this.notify(changed);
    return didPrune;
  }

  private notify(refs: Set<string>) {
    for (const ref of refs) {
      const listeners = this.subscribers.get(ref);
      if (!listeners || listeners.size === 0) continue;
      const value = this.observe(ref);
      for (const listener of [...listeners]) listener(value, ref);
    }
  }
}

type WooViewEntry<T> = {
  definition: WooViewDefinition<T>;
  subject: string;
  args: readonly unknown[];
  woo: WooContext;
  snapshot: WooViewSnapshot<T>;
  listeners: Set<() => void>;
  requestedRevision: number;
  generation: number;
  inFlight: Promise<void> | null;
  inactiveAt: number | null;
  facade: WooView<T>;
};

const EMPTY_VIEW_SNAPSHOT: WooViewSnapshot<never> = Object.freeze({
  data: null,
  completeness: "unknown",
  freshness: "current",
  fetchStatus: "idle",
  revision: 0,
  error: null
});

/** Principal-scoped cache for bounded catalog semantic reads. Projection is a
 * fast partial seed only; completeness always comes from the registered read.
 * Entries retain the last complete value across refreshes and use a requested
 * revision to reject results overtaken by accepted observations. */
export class WooViewStore {
  private readonly entries = new Map<string, WooViewEntry<unknown>>();
  private readonly anonymousPrincipals = new WeakMap<WooContext, string>();
  private nextAnonymousPrincipal = 1;

  constructor(
    private readonly registry: CatalogUiRegistry,
    private readonly projection: ClientProjection,
    private readonly now: () => number = Date.now,
    private readonly inactiveTtlMs = 30_000
  ) {}

  view<T>(principal: string | null | undefined, woo: WooContext, request: WooViewRequest): WooView<T> {
    const resolved = this.registry.resolveView<T>(request.view);
    if (!resolved) throw new Error(`unknown semantic view: ${request.view}`);
    const subject = String(request.subject ?? "");
    if (!subject) throw new Error(`semantic view ${resolved.id} requires a subject`);
    // Detach structured arguments from caller-owned objects. Otherwise a
    // mutation after lookup could make the read inputs disagree with the key
    // that selected this shared entry.
    const serializedArgs = canonicalViewArgs(request.args ?? []);
    const args = Object.freeze(JSON.parse(serializedArgs) as unknown[]);
    const principalKey = principal || this.anonymousPrincipal(woo);
    const key = `${principalKey}\u0000${resolved.id}\u0000${subject}\u0000${serializedArgs}`;
    const existing = this.entries.get(key) as WooViewEntry<T> | undefined;
    if (existing) {
      // Contexts are cheap and may be recreated by the shell. The cache identity
      // is principal/view/subject/args; use the latest transport capabilities.
      existing.woo = woo;
      // Merely looking up a facade does not make it active. Refresh the
      // collection deadline for an unsubscribed entry; only subscribe() may
      // clear it. Otherwise a view created but never mounted lives forever.
      existing.inactiveAt = existing.listeners.size === 0 ? this.now() : null;
      return existing.facade;
    }

    let data: T | null = null;
    let completeness: WooViewCompleteness = "unknown";
    if (resolved.definition.seed) {
      data = resolved.definition.seed({ projection: this.projection, woo, subject, args });
      if (data !== null) completeness = "partial";
    }
    const entry = {} as WooViewEntry<T>;
    entry.definition = resolved.definition;
    entry.subject = subject;
    entry.args = args;
    entry.woo = woo;
    entry.snapshot = Object.freeze({ data, completeness, freshness: "current", fetchStatus: "idle", revision: 0, error: null });
    entry.listeners = new Set();
    entry.requestedRevision = 0;
    entry.generation = 0;
    entry.inFlight = null;
    // A newly-created facade may never be subscribed (conditional render,
    // abandoned navigation). Start its inactivity clock immediately so the
    // cache's eventual-collection guarantee covers that path too.
    entry.inactiveAt = this.now();
    entry.facade = {
      getSnapshot: () => entry.snapshot,
      subscribe: (listener) => {
        entry.listeners.add(listener);
        entry.inactiveAt = null;
        if (entry.listeners.size === 1 && (entry.snapshot.completeness !== "complete" || entry.snapshot.freshness === "stale")) this.startRead(entry);
        return () => {
          entry.listeners.delete(listener);
          if (entry.listeners.size === 0) entry.inactiveAt = this.now();
        };
      },
      refresh: () => this.invalidateEntry(entry)
    };
    this.entries.set(key, entry as WooViewEntry<unknown>);
    return entry.facade;
  }

  invalidate(observation: Record<string, unknown>, delivered: DeliveredObservation): void {
    this.invalidateBatch([observation], delivered);
  }

  /** One accepted frame is one invalidation boundary. Several observations in
   * the same frame may describe one mutation; refresh each affected instance
   * once after projection reducers have consumed the whole frame. */
  invalidateBatch(observations: readonly Record<string, unknown>[], delivered: DeliveredObservation): void {
    for (const raw of this.entries.values()) {
      const entry = raw as WooViewEntry<unknown>;
      if (entry.listeners.size === 0) continue;
      const affected = observations.some((observation) => {
        const type = String(observation.type ?? "");
        if (!type || !entry.definition.invalidateOn?.includes(type)) return false;
        const context = {
          projection: this.projection,
          woo: entry.woo,
          subject: entry.subject,
          args: entry.args,
          observation,
          delivered
        };
        return entry.definition.affects
          ? entry.definition.affects(context)
          : defaultViewSubjectMatch(entry.subject, observation, delivered);
      });
      if (affected) this.invalidateEntry(entry);
    }
  }

  prune(now = this.now()): number {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.listeners.size > 0 || entry.inactiveAt === null || now - entry.inactiveAt < this.inactiveTtlMs) continue;
      entry.generation += 1;
      this.entries.delete(key);
      removed += 1;
    }
    return removed;
  }

  private anonymousPrincipal(woo: WooContext): string {
    const existing = this.anonymousPrincipals.get(woo);
    if (existing) return existing;
    const next = `anonymous:${this.nextAnonymousPrincipal++}`;
    this.anonymousPrincipals.set(woo, next);
    return next;
  }

  private invalidateEntry<T>(entry: WooViewEntry<T>): void {
    entry.requestedRevision += 1;
    const complete = entry.snapshot.completeness === "complete";
    this.publish(entry, {
      ...entry.snapshot,
      freshness: complete ? "stale" : entry.snapshot.freshness,
      error: null
    });
    if (entry.listeners.size > 0 && !entry.inFlight) this.startRead(entry);
  }

  private startRead<T>(entry: WooViewEntry<T>): void {
    if (entry.inFlight) return;
    const requestedRevision = entry.requestedRevision;
    const generation = entry.generation;
    this.publish(entry, {
      ...entry.snapshot,
      fetchStatus: entry.snapshot.completeness === "complete" ? "refreshing" : "loading",
      error: null
    });
    const read = Promise.resolve(entry.definition.read({
      projection: this.projection,
      woo: entry.woo,
      subject: entry.subject,
      args: entry.args
    })).then((result) => {
      if (entry.generation !== generation || entry.requestedRevision !== requestedRevision) return;
      const data = entry.definition.parse(result);
      this.publish(entry, {
        data,
        completeness: "complete",
        freshness: "current",
        fetchStatus: "idle",
        revision: entry.snapshot.revision,
        error: null
      });
    }).catch((error) => {
      if (entry.generation !== generation || entry.requestedRevision !== requestedRevision) return;
      this.publish(entry, { ...entry.snapshot, fetchStatus: "error", error });
    }).finally(() => {
      if (entry.inFlight !== read) return;
      entry.inFlight = null;
      if (entry.listeners.size > 0 && entry.requestedRevision !== requestedRevision) this.startRead(entry);
    });
    entry.inFlight = read;
  }

  private publish<T>(entry: WooViewEntry<T>, next: Omit<WooViewSnapshot<T>, "revision"> & { revision?: number }): void {
    const candidate: WooViewSnapshot<T> = Object.freeze({
      ...next,
      revision: snapshotsEqual(entry.snapshot, next) ? entry.snapshot.revision : entry.snapshot.revision + 1
    });
    if (snapshotsEqual(entry.snapshot, candidate)) return;
    entry.snapshot = candidate;
    for (const listener of [...entry.listeners]) {
      try { listener(); } catch {
        // One component's render failure is local to that component. It must
        // not turn a successful authoritative read into a store error or keep
        // sibling subscribers from observing the same publication.
      }
    }
  }
}

function snapshotsEqual<T>(left: WooViewSnapshot<T>, right: Omit<WooViewSnapshot<T>, "revision"> & { revision?: number }): boolean {
  return left.data === right.data
    && left.completeness === right.completeness
    && left.freshness === right.freshness
    && left.fetchStatus === right.fetchStatus
    && left.error === right.error;
}

function defaultViewSubjectMatch(subject: string, observation: Record<string, unknown>, delivered: DeliveredObservation): boolean {
  return [observation.source, observation.subject, delivered.space].some((value) => value === subject);
}

function canonicalViewArgs(value: unknown): string {
  const seen = new Set<object>();
  const encode = (item: unknown): unknown => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new Error("semantic view args must contain finite numbers");
      return item;
    }
    if (Array.isArray(item)) return item.map(encode);
    if (typeof item === "object") {
      if (seen.has(item)) throw new Error("semantic view args must not contain cycles");
      seen.add(item);
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(item as Record<string, unknown>).sort()) result[key] = encode((item as Record<string, unknown>)[key]);
      seen.delete(item);
      return result;
    }
    throw new Error(`unsupported semantic view arg: ${typeof item}`);
  };
  return JSON.stringify(encode(value));
}

export class ObservationRegistry {
  private handlers: WooObservationHandler[] = [];

  constructor(private readonly projection: ClientProjection) {}

  observation(handler: WooObservationHandler) {
    this.handlers.push(handler);
  }

  deliver(observation: Record<string, unknown>, delivered: DeliveredObservation): boolean {
    const type = String(observation?.type ?? "");
    if (!type) return false;
    const envelope = { observation, delivered };
    if (delivered.route === "live") {
      const livePatches: ProjectionPatch[] = [];
      const canonicalPatches: ProjectionPatch[] = [];
      const canonicalClears: string[] = [];
      let accepted = false;
      for (const handler of this.handlers) {
        if (!handler.types.includes(type)) continue;
        if (handler.route && handler.route !== "both" && handler.route !== delivered.route) continue;
        const draft = new ProjectionDraft();
        handler.reduce(draft, envelope);
        const patches = draft.consume();
        const clears = draft.consumeAuthoritativeClears();
        if (handler.liveProjection === "canonical") {
          accepted = true;
          canonicalPatches.push(...patches);
          canonicalClears.push(...clears);
        } else {
          livePatches.push(...patches);
        }
      }
      for (const subject of canonicalClears) this.projection.clearAuthoritative(subject, { notify: canonicalPatches.length === 0 && livePatches.length === 0 });
      if (canonicalPatches.length > 0) this.projection.applyCanonical(canonicalPatches);
      for (const patch of livePatches) {
        this.projection.applyLive(liveProjectionKey(type, patch.subject, livePatchDiscriminator(patch)), [patch]);
      }
      return accepted;
    }

    const draft = new ProjectionDraft();
    for (const handler of this.handlers) {
      if (!handler.types.includes(type)) continue;
      if (handler.route && handler.route !== "both" && handler.route !== delivered.route) continue;
      handler.reduce(draft, envelope);
    }
    const patches = draft.consume();
    const authoritativeClears = draft.consumeAuthoritativeClears();
    if (patches.length === 0 && authoritativeClears.length === 0) return true;
    for (const subject of authoritativeClears) this.projection.clearAuthoritative(subject, { notify: patches.length === 0 });
    this.projection.applySequenced(patches);
    return true;
  }

  optimisticPatches(observations: unknown[], delivered: DeliveredObservation): ProjectionPatch[] {
    const draft = new ProjectionDraft();
    for (const observation of Array.isArray(observations) ? observations : []) {
      if (!observation || typeof observation !== "object" || Array.isArray(observation)) continue;
      const record = observation as Record<string, unknown>;
      const type = String(record?.type ?? "");
      if (!type) continue;
      const envelope = { observation: record, delivered: { ...delivered, optimistic: true } };
      for (const handler of this.handlers) {
        if (!handler.types.includes(type)) continue;
        if (handler.route && handler.route !== "both" && handler.route !== delivered.route) continue;
        handler.reduce(draft, envelope);
      }
    }
    return draft.consume();
  }
}

export type ChatFormatterContext = {
  // Resolve a subject id to its display label. Replaces the inline
  // `actorLabel(id)` calls each catalog would otherwise have to copy.
  label(id: string | undefined): string;
  // The viewing actor's id, or undefined if the client has no actor yet.
  // Lets formatters distinguish doer-vs-bystander views (e.g. `note_read`
  // shows the body to the reader and a short line to others) without
  // pushing that branch back into the frame.
  viewer: string | undefined;
};

export type ChatFormatterResult = {
  // ChatLine.kind. If omitted, the frame uses the observation type
  // for the rendered line.
  kind?: string;
  // Override for ChatLine.text. If omitted, the frame falls back to
  // observation.text (when present); if neither is set the line is
  // dropped from the feed.
  text?: string;
  // Optional overrides for fields the frame would otherwise read straight
  // off the observation. Used sparingly — most catalogs only set kind/text.
  actor?: string;
  style?: string;
  reason?: string;
};

export type ChatFormatter = {
  types: readonly string[];
  format: (observation: Record<string, unknown>, ctx: ChatFormatterContext) => ChatFormatterResult | undefined;
};

export class ChatFormatterRegistry {
  private byType = new Map<string, ChatFormatter[]>();

  formatter(entry: ChatFormatter): void {
    for (const type of entry.types) {
      const list = this.byType.get(type);
      if (list) list.push(entry);
      else this.byType.set(type, [entry]);
    }
  }

  isChatType(type: string): boolean {
    return this.byType.has(String(type ?? ""));
  }

  // Walks formatters for the given type in registration order; returns
  // the first non-undefined result. Registration order = catalog install
  // order = manifest dependency order, so the catalog defining the
  // emitting verb naturally wins. Override semantics are intentionally
  // not supported here; if a use case appears, add an explicit priority.
  format(observation: Record<string, unknown>, ctx: ChatFormatterContext): ChatFormatterResult | undefined {
    const type = String(observation?.type ?? "");
    const list = this.byType.get(type);
    if (!list) return undefined;
    for (const entry of list) {
      const result = entry.format(observation, ctx);
      if (result) return result;
    }
    return undefined;
  }
}

export class FrameStateStore {
  private frames = new Map<string, FrameStateRecord>();
  private overlays: OverlayFrame[] = [];

  ensureFrame(id: string, subject: string, view?: string): FrameStateRecord {
    const existing = this.frames.get(id);
    if (existing) return existing;
    const record = { subject, view, values: {} };
    this.frames.set(id, record);
    return record;
  }

  frame(id: string): FrameStateRecord | undefined {
    return this.frames.get(id);
  }

  overlayStack(): OverlayFrame[] {
    return this.overlays.map((overlay) => ({ ...overlay, state: { ...overlay.state } }));
  }

  emit(action: WooUiAction): boolean {
    if (action.type === "set_frame_state") {
      const frame = this.frames.get(action.frame);
      if (!frame) return false;
      frame.values[action.key] = action.value;
      return true;
    }
    if (action.type === "merge_frame_state") {
      const frame = this.frames.get(action.frame);
      if (!frame) return false;
      frame.values = { ...frame.values, ...action.values };
      return true;
    }
    if (action.type === "open_overlay") {
      this.overlays.push({
        id: action.frame ?? crypto.randomUUID(),
        subject: action.subject,
        view: action.view,
        state: { ...(action.state ?? {}) }
      });
      return true;
    }
    if (action.type === "close_overlay") {
      if (action.frame) this.overlays = this.overlays.filter((overlay) => overlay.id !== action.frame);
      else this.overlays.pop();
      return true;
    }
    return false;
  }
}

export class WooClientFramework {
  readonly projection = new ClientProjection();
  readonly observations = new ObservationRegistry(this.projection);
  readonly chatFormatters = new ChatFormatterRegistry();
  readonly frames = new FrameStateStore();
  readonly catalogUi = new CatalogUiRegistry();
  readonly views = new WooViewStore(this.catalogUi, this.projection);
  private pendingViewInvalidations = new Map<string, { observations: Record<string, unknown>[]; delivered: DeliveredObservation }>();
  private viewInvalidationFlushQueued = false;

  constructor() {
    registerCoreObservationHandlers(this.observations);
  }

  ingestWorld(world: any) {
    this.projection.ingestWorld(world, this.catalogUi.worldSnapshotPatches(world));
  }

  ingestAppliedFrame(frame: any) {
    const delivered: DeliveredObservation = {
      route: "sequenced",
      seq: typeof frame?.seq === "number" ? frame.seq : undefined,
      space: typeof frame?.space === "string" ? frame.space : undefined,
      frameId: typeof frame?.id === "string" ? frame.id : undefined,
      receivedAt: Date.now()
    };
    const accepted: Record<string, unknown>[] = [];
    for (const observation of frame?.observations ?? []) {
      if (observation && typeof observation === "object" && !Array.isArray(observation)) {
        if (this.observations.deliver(observation, delivered)) accepted.push(observation);
      }
    }
    this.views.invalidateBatch(accepted, delivered);
  }

  ingestLiveObservation(observation: any) {
    if (!observation || typeof observation !== "object" || Array.isArray(observation)) return;
    const delivered: DeliveredObservation = { route: "live", receivedAt: Date.now() };
    this.ingestDeliveredObservation(observation, delivered);
  }

  /** Canonical transport-neutral observation boundary. Adapters must enter
   * here, rather than calling the reducer registry directly, so projection
   * reduction and semantic-view invalidation cannot drift apart. */
  ingestDeliveredObservation(observation: Record<string, unknown>, delivered: DeliveredObservation): boolean {
    if (!observation || typeof observation !== "object" || Array.isArray(observation)) return false;
    const accepted = this.observations.deliver(observation, delivered);
    if (accepted) this.queueViewInvalidation(observation, delivered);
    return accepted;
  }

  /** NetFeed exposes one callback per observation even when several share one
   * committed carrier. Reducers remain synchronous, while view invalidation is
   * coalesced to that carrier so one turn schedules one authoritative read. */
  private queueViewInvalidation(observation: Record<string, unknown>, delivered: DeliveredObservation): void {
    if (delivered.route !== "sequenced" || (delivered.seq === undefined && !delivered.frameId)) {
      this.views.invalidate(observation, delivered);
      return;
    }
    const key = `${delivered.route}\u0000${delivered.space ?? ""}\u0000${delivered.seq ?? ""}\u0000${delivered.frameId ?? ""}`;
    const pending = this.pendingViewInvalidations.get(key);
    if (pending) pending.observations.push(observation);
    else this.pendingViewInvalidations.set(key, { observations: [observation], delivered });
    if (this.viewInvalidationFlushQueued) return;
    this.viewInvalidationFlushQueued = true;
    queueMicrotask(() => {
      this.viewInvalidationFlushQueued = false;
      const batches = [...this.pendingViewInvalidations.values()];
      this.pendingViewInvalidations.clear();
      for (const batch of batches) this.views.invalidateBatch(batch.observations, batch.delivered);
    });
  }

  view<T>(principal: string | null | undefined, woo: WooContext, request: WooViewRequest): WooView<T> {
    return this.views.view(principal, woo, request);
  }

  observe(ref: string) {
    return this.projection.observe(ref);
  }

  subscribe(ref: string, listener: ProjectionSubscriber, options?: { emitCurrent?: boolean }) {
    return this.projection.subscribe(ref, listener, options);
  }

  ingestSnapshot(snapshot: ProjectionSnapshot): void;
  ingestSnapshot(scope: string, objects: unknown[]): void;
  ingestSnapshot(scopeOrSnapshot: string | ProjectionSnapshot, maybeObjects?: unknown[]) {
    if (typeof scopeOrSnapshot === "string") this.projection.ingestSnapshot(scopeOrSnapshot, maybeObjects ?? []);
    else this.projection.ingestSnapshot(scopeOrSnapshot);
  }

  applyOptimisticCall(callId: string, options: ProjectionCallOptions | undefined) {
    this.projection.applyOptimisticCall(callId, options);
  }

  applyOptimisticFrame(callId: string, frame: any, options: { ttlMs?: number } = {}) {
    const id = String(callId || frame?.id || "");
    if (!id) return;
    const patches = this.observations.optimisticPatches(frame?.observations ?? [], {
      route: "sequenced",
      seq: typeof frame?.seq === "number" ? frame.seq : undefined,
      space: typeof frame?.space === "string" ? frame.space : undefined,
      frameId: typeof frame?.id === "string" ? frame.id : undefined,
      receivedAt: Date.now(),
      optimistic: true
    });
    if (patches.length === 0) return;
    this.applyOptimisticCall(id, {
      optimistic: {
        id: `optimistic-frame:${id}`,
        patches,
        ttlMs: options.ttlMs,
        reconcile: "drop_on_applied"
      }
    });
  }

  applyCanonical(patches: ProjectionPatch[], options?: ApplyCanonicalOptions) {
    this.projection.applyCanonical(patches, options);
  }

  clearAuthoritative(subject: string) {
    this.projection.clearAuthoritative(subject);
  }

  completeOptimisticCall(callId: string) {
    this.projection.completeOptimisticCall(callId);
  }

  failOptimisticCall(callId: string) {
    this.projection.failOptimisticCall(callId);
  }

  prune(now = Date.now()) {
    const projectionChanged = this.projection.prune(now);
    this.views.prune(now);
    return projectionChanged;
  }

  refs() {
    return this.projection.refs();
  }
}

export function createWooClientFramework() {
  return new WooClientFramework();
}

/** Vanilla custom-element adapter for WooView. It owns late woo/subject
 * binding, subscription replacement, and disconnect/reconnect behavior so a
 * component cannot accidentally render a partial collection as final. */
export class WooViewController<T> {
  private view: WooView<T> | null = null;
  private unsubscribe: (() => void) | null = null;
  private isConnected = false;

  constructor(
    private readonly host: HTMLElement,
    private readonly request: () => WooViewRequest | null,
    private readonly render: () => void
  ) {
    void this.host;
  }

  get snapshot(): WooViewSnapshot<T> {
    return this.view?.getSnapshot() ?? (EMPTY_VIEW_SNAPSHOT as WooViewSnapshot<T>);
  }

  bind(woo: WooContext | undefined): void {
    const request = this.request();
    const next = woo?.view && request ? woo.view<T>(request) : null;
    if (next === this.view) return;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.view = next;
    if (this.isConnected && this.view) this.subscribe();
    this.render();
  }

  connected(): void {
    if (this.isConnected) return;
    this.isConnected = true;
    if (this.view) this.subscribe();
  }

  disconnected(): void {
    this.isConnected = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  refresh(): void {
    this.view?.refresh();
  }

  private subscribe(): void {
    if (!this.view || this.unsubscribe) return;
    this.unsubscribe = this.view.subscribe(() => this.render());
  }
}

// Room-contents snapshots are thin by design (no props), so a viewer who just
// entered a room sees only id/name/parent for the subject until live
// observations or a full summary fill in the rest. One round-trip per subject
// per session: the Net implementation makes that one fill an authoritative,
// bounded exact-key read, while the legacy summary path reads its ordinary
// server projection. Change observations invalidate the surrounding session
// projection and a reset permits the next exact fill.
export class ProjectionFieldFiller {
  private inFlight = new Set<string>();
  private completed = new Set<string>();
  private generation = 0;
  constructor(
    private observe: (subject: string) => { props?: Record<string, unknown> } | null | undefined,
    // The requested fields travel with the fill. Net clients can therefore
    // issue bounded, exact property-cell reads instead of falling through to
    // the legacy whole-object summary endpoint.
    private fetchSummary: (subject: string, fields: readonly string[]) => Promise<unknown>,
    private onResolved?: () => void
  ) {}

  ensure(subject: string, fields: readonly string[]): void {
    if (!subject || !fields || fields.length === 0) return;
    if (this.completed.has(subject)) return;
    const projected = this.observe(subject);
    const props = projected?.props ?? {};
    if (fields.every((field) => Object.prototype.hasOwnProperty.call(props, field))) {
      this.completed.add(subject);
      return;
    }
    if (this.inFlight.has(subject)) return;
    this.inFlight.add(subject);
    const generation = this.generation;
    void this.fetchSummary(subject, fields)
      .catch(() => undefined)
      .finally(() => {
        if (generation !== this.generation) return;
        this.inFlight.delete(subject);
        this.completed.add(subject);
        this.onResolved?.();
      });
  }

  // Drop memoization so the next ensure() can re-fetch. Pending fills from
  // before the reset resolve into a no-op (generation mismatch) so they
  // cannot suppress fresh fetches under the new session.
  reset(): void {
    this.generation += 1;
    this.inFlight.clear();
    this.completed.clear();
  }
}

export type CoalescedViewHydratorOptions<T> = {
  read: (subject: string, signature: string) => Promise<T>;
  apply: (value: T, subject: string, signature: string) => void;
  onError?: (error: unknown, subject: string, signature: string) => void;
  completeOnError?: boolean;
  retryDelaysMs?: readonly number[];
  now?: () => number;
  retryKey?: (subject: string, signature: string) => string;
};

const DEFAULT_VIEW_RETRY_DELAYS_MS = [250, 1_000, 5_000, 30_000] as const;

/** Prevent a render-driven caller from turning a persistent read failure into
 * a request loop. The caller still decides when to try again; this gate only
 * makes repeated eligibility checks cheap and bounded. */
export class RetryBackoffGate {
  private failures = new Map<string, { attempts: number; retryAt: number }>();

  constructor(
    private readonly delaysMs: readonly number[] = DEFAULT_VIEW_RETRY_DELAYS_MS,
    private readonly now: () => number = Date.now
  ) {}

  canAttempt(key: string): boolean {
    const failure = this.failures.get(key);
    return !failure || this.now() >= failure.retryAt;
  }

  recordFailure(key: string): number {
    const previous = this.failures.get(key);
    const attempts = (previous?.attempts ?? 0) + 1;
    const last = Math.max(0, this.delaysMs.length - 1);
    const delay = this.delaysMs.length === 0 ? 0 : Math.max(0, this.delaysMs[Math.min(attempts - 1, last)] ?? 0);
    this.failures.set(key, { attempts, retryAt: this.now() + delay });
    return delay;
  }

  recordSuccess(key: string): void {
    this.failures.delete(key);
  }

  reset(): void {
    this.failures.clear();
  }
}

export type CoalescedRefreshControllerOptions = {
  run: () => Promise<void> | void;
  canRun?: () => boolean;
};

// Catalog views have two repeatable refresh shapes:
// - full view refreshes, where every invalidation should eventually run but
//   bursts collapse to one in-flight read plus one queued follow-up; and
// - semantic field fills, handled by CoalescedViewHydrator below, where a
//   subject/signature success is memoized.
// This controller owns the first shape so components do not each reinvent
// lifecycle-key and in-flight queue state.
export class CoalescedRefreshController {
  private running = false;
  private queued = false;
  private lastOnceKey = "";

  constructor(private options: CoalescedRefreshControllerOptions) {}

  request(): void {
    if (!this.canRun()) return;
    if (this.running) {
      this.queued = true;
      return;
    }
    this.running = true;
    // Start run() synchronously (a refresh should kick off this tick), but
    // guard both failure modes so they can never leave running=true stuck
    // forever: a synchronous throw is contained here, and an async rejection
    // is swallowed by .catch. A refresh failure is the consumer's concern,
    // not the scheduler's, so finally always drains the queue.
    let started: Promise<void> | void;
    try {
      started = this.options.run();
    } catch {
      started = undefined;
    }
    void Promise.resolve(started)
      .catch(() => undefined)
      .finally(() => {
        this.running = false;
        if (this.queued && this.canRun()) {
          this.queued = false;
          this.request();
        } else {
          this.queued = false;
        }
      });
  }

  requestOnce(key: string): void {
    if (!key || key === this.lastOnceKey) return;
    if (!this.canRun()) return;
    this.lastOnceKey = key;
    this.request();
  }

  resetOnceKey(): void {
    this.lastOnceKey = "";
  }

  private canRun(): boolean {
    return this.options.canRun?.() ?? true;
  }
}

// Catalog UI views often render immediately from cheap structural projection,
// then need one catalog verb read to fill semantic display fields that generic
// projection cannot safely express (for example readable note text). This helper
// owns only the coalescing/memoization; each catalog still owns its view shape.
export class CoalescedViewHydrator<T = unknown> {
  private inFlight = new Set<string>();
  private completed = new Set<string>();
  private generation = 0;
  private readonly retryGate: RetryBackoffGate;

  constructor(private options: CoalescedViewHydratorOptions<T>) {
    this.retryGate = new RetryBackoffGate(options.retryDelaysMs, options.now);
  }

  ensure(subject: string, signature: string): void {
    if (!subject || !signature) return;
    const key = viewHydrationKey(subject, signature);
    const retryKey = this.options.retryKey?.(subject, signature) ?? key;
    if (this.completed.has(key) || this.inFlight.has(key) || !this.retryGate.canAttempt(retryKey)) return;
    this.inFlight.add(key);
    const generation = this.generation;
    void this.options.read(subject, signature)
      .then((value) => {
        if (generation !== this.generation) return;
        // Apply before memoizing success. A catalog hydration may reject a
        // structurally malformed reply while translating it into projection
        // patches; marking first would make that failure permanently complete.
        this.options.apply(value, subject, signature);
        this.completed.add(key);
        this.retryGate.recordSuccess(retryKey);
      })
      .catch((error) => {
        if (generation !== this.generation) return;
        if (this.options.completeOnError === true) {
          this.completed.add(key);
          this.retryGate.recordSuccess(retryKey);
        } else {
          this.retryGate.recordFailure(retryKey);
        }
        this.options.onError?.(error, subject, signature);
      })
      .finally(() => {
        if (generation !== this.generation) return;
        this.inFlight.delete(key);
      });
  }

  reset(): void {
    this.invalidate();
    this.retryGate.reset();
  }

  /** Invalidate completed/in-flight results after a model mutation while
   * retaining failure backoff for the same underlying read surface. */
  invalidate(): void {
    this.generation += 1;
    this.inFlight.clear();
    this.completed.clear();
  }
}

function viewHydrationKey(subject: string, signature: string): string {
  return `${subject}\u0000${signature}`;
}

export function registerCoreObservationHandlers(registry: ObservationRegistry) {
  registry.observation({
    types: ["taken", "dropped"],
    route: "both",
    reduce: (draft, envelope) => {
      const obs = envelope.observation;
      const item = String(obs.item ?? "");
      if (!item) return;
      if (obs.type === "taken") {
        const actor = String(obs.actor ?? "");
        if (actor) draft.patchObject(item, { location: actor });
        return;
      }
      const room = String(obs.room ?? obs.source ?? envelope.delivered.space ?? "");
      if (room) draft.patchObject(item, { location: room });
    }
  });
  registry.observation({
    types: ["property_changed"],
    route: "both",
    liveProjection: "canonical",
    reduce: (draft, envelope) => {
      const obs = envelope.observation;
      const target = String(obs.target ?? obs.object ?? obs.source ?? "");
      const name = String(obs.name ?? "");
      if (!target || !name) return;
      draft.patchObjectProps(target, { [name]: obs.value });
    }
  });
  registry.observation({
    types: ["value_changed"],
    route: "both",
    liveProjection: "canonical",
    reduce: (draft, envelope) => {
      const target = String(envelope.observation.target ?? envelope.observation.object ?? envelope.observation.source ?? "");
      if (target) draft.patchObjectProps(target, { value: envelope.observation.value });
    }
  });
  registry.observation({
    types: ["block_data"],
    route: "both",
    liveProjection: "canonical",
    reduce: (draft, envelope) => {
      const obs = envelope.observation;
      const block = String(obs.block ?? obs.target ?? obs.source ?? "");
      const name = String(obs.name ?? "");
      if (!block || !name) return;
      draft.patchObjectProps(block, { [name]: obs.value });
    }
  });
  registry.observation({
    types: ["control_changed"],
    route: "both",
    reduce: (draft, envelope) => {
      const obs = envelope.observation;
      const target = String(obs.target ?? "");
      const name = String(obs.name ?? "");
      if (!target || !name) return;
      draft.patchObjectProps(target, { [name]: obs.value });
    }
  });
  registry.observation({
    types: ["gesture_progress"],
    route: "live",
    reduce: (draft, envelope) => {
      const obs = envelope.observation;
      const target = String(obs.target ?? "");
      const name = String(obs.name ?? "");
      if (!target || !name) return;
      draft.patchObjectProps(target, { [name]: obs.value });
    }
  });
}

class ProjectionDraft implements ClientProjectionDraft {
  private patches = new Map<string, ProjectionPatch>();
  private authoritativeClears = new Set<string>();

  patchObject(ref: string, fields: Record<string, unknown>) {
    const subject = String(ref ?? "");
    if (!subject) return;
    this.merge(subject, { subject, fields: stripUndefined(fields) });
  }

  patchObjectProps(ref: string, props: Record<string, unknown>) {
    const subject = String(ref ?? "");
    if (!subject) return;
    this.merge(subject, { subject, props: stripUndefined(props) });
  }

  patchCatalogState(ref: string, key: string, fields: Record<string, unknown>) {
    const subject = String(ref ?? "");
    const catalogKey = String(key ?? "");
    if (!subject || !catalogKey) return;
    this.merge(subject, { subject, catalogState: { [catalogKey]: stripUndefined(fields) } });
  }

  clearCatalogState(ref: string, key: string) {
    const subject = String(ref ?? "");
    const catalogKey = String(key ?? "");
    if (!subject || !catalogKey) return;
    this.merge(subject, { subject, clearCatalogState: [catalogKey] });
  }

  clearAuthoritative(ref: string) {
    const subject = String(ref ?? "");
    if (subject) this.authoritativeClears.add(subject);
  }

  consume(): ProjectionPatch[] {
    return [...this.patches.values()];
  }

  consumeAuthoritativeClears(): string[] {
    return [...this.authoritativeClears];
  }

  private merge(subject: string, patch: ProjectionPatch) {
    this.patches.set(subject, mergePatch(this.patches.get(subject), patch));
  }
}

function objectProjectionId(obj: unknown): string {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return "";
  const id = (obj as { id?: unknown }).id;
  return typeof id === "string" && id ? id : "";
}

function normalizeObjectProjection(id: string, obj: any): ObjectProjection {
  const props = obj?.props && typeof obj.props === "object" && !Array.isArray(obj.props) ? obj.props : {};
  const catalogState = obj?.catalogState && typeof obj.catalogState === "object" && !Array.isArray(obj.catalogState) ? obj.catalogState : {};
  return {
    id,
    name: typeof obj?.name === "string" ? obj.name : undefined,
    owner: typeof obj?.owner === "string" ? obj.owner : undefined,
    parent: typeof obj?.parent === "string" || obj?.parent === null ? obj.parent : undefined,
    ancestors: Array.isArray(obj?.ancestors) ? obj.ancestors.filter((item: unknown): item is string => typeof item === "string") : undefined,
    features: Array.isArray(obj?.features) ? obj.features.filter((item: unknown): item is string => typeof item === "string") : undefined,
    aliases: Array.isArray(obj?.aliases) ? obj.aliases.filter((item: unknown): item is string => typeof item === "string") : undefined,
    description: typeof obj?.description === "string" || obj?.description === null ? obj.description : undefined,
    location: typeof obj?.location === "string" || obj?.location === null ? obj.location : undefined,
    props: { ...props },
    catalogState: Object.fromEntries(Object.entries(catalogState).filter(([, value]) => value && typeof value === "object" && !Array.isArray(value)).map(([key, value]) => [key, { ...(value as Record<string, unknown>) }]))
  };
}

function emptyObjectProjection(id: string): ObjectProjection {
  return { id, props: {}, catalogState: {} };
}

function cloneObjectProjection(value: ObjectProjection): ObjectProjection {
  return {
    ...value,
    ancestors: value.ancestors ? [...value.ancestors] : undefined,
    features: value.features ? [...value.features] : undefined,
    aliases: value.aliases ? [...value.aliases] : undefined,
    props: { ...value.props },
    catalogState: Object.fromEntries(Object.entries(value.catalogState).map(([key, fields]) => [key, { ...fields }]))
  };
}

function mergeObjectProjection(left: ObjectProjection, right: ObjectProjection): ObjectProjection {
  return {
    ...left,
    ...stripUndefined({
      name: right.name,
      owner: right.owner,
      parent: right.parent,
      ancestors: right.ancestors,
      features: right.features,
      aliases: right.aliases,
      description: right.description,
      location: right.location
    }),
    props: { ...left.props, ...right.props },
    catalogState: { ...left.catalogState, ...right.catalogState }
  };
}

function hasProjectionData(value: ObjectProjection): boolean {
  return Boolean(value.name || value.owner || value.parent || value.location || value.description || (value.ancestors?.length ?? 0) > 0 || (value.features?.length ?? 0) > 0 || (value.aliases?.length ?? 0) > 0 || Object.keys(value.props).length > 0 || Object.keys(value.catalogState).length > 0);
}

function applyPatch(target: ObjectProjection, patch: ProjectionPatch | undefined) {
  if (!patch) return;
  if (patch.fields) Object.assign(target, stripUndefined(patch.fields));
  if (patch.props) Object.assign(target.props, stripUndefined(patch.props));
  for (const key of patch.clearCatalogState ?? []) delete target.catalogState[key];
  if (patch.catalogState) {
    for (const [key, fields] of Object.entries(patch.catalogState)) {
      target.catalogState[key] = { ...(target.catalogState[key] ?? {}), ...stripUndefined(fields) };
    }
  }
}

function mergePatch(left: ProjectionPatch | undefined, right: ProjectionPatch): ProjectionPatch {
  return {
    subject: right.subject,
    fields: mergeRecord(left?.fields, right.fields),
    props: mergeRecord(left?.props, right.props),
    catalogState: mergeCatalogState(left?.catalogState, right.catalogState),
    clearCatalogState: mergeClearList(left?.clearCatalogState, right.clearCatalogState)
  };
}

function clonePatch(patch: ProjectionPatch): ProjectionPatch {
  return {
    subject: patch.subject,
    fields: patch.fields ? { ...patch.fields } : undefined,
    props: patch.props ? { ...patch.props } : undefined,
    catalogState: patch.catalogState ? Object.fromEntries(Object.entries(patch.catalogState).map(([key, fields]) => [key, { ...fields }])) : undefined,
    clearCatalogState: patch.clearCatalogState ? [...patch.clearCatalogState] : undefined
  };
}

function replacementPatch(patch: ProjectionPatch): ProjectionPatch {
  const cloned = clonePatch(patch);
  const replacedCatalogKeys = Object.keys(cloned.catalogState ?? {});
  cloned.clearCatalogState = mergeClearList(cloned.clearCatalogState, replacedCatalogKeys);
  return cloned;
}

function mergeRecord(left?: Record<string, unknown>, right?: Record<string, unknown>): Record<string, unknown> | undefined {
  const merged = { ...(left ?? {}), ...stripUndefined(right ?? {}) };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function mergeCatalogState(
  left?: Record<string, Record<string, unknown>>,
  right?: Record<string, Record<string, unknown>>
): Record<string, Record<string, unknown>> | undefined {
  const merged: Record<string, Record<string, unknown>> = {};
  for (const [key, fields] of Object.entries(left ?? {})) merged[key] = { ...fields };
  for (const [key, fields] of Object.entries(right ?? {})) merged[key] = { ...(merged[key] ?? {}), ...stripUndefined(fields) };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function mergeClearList(left?: string[], right?: string[]): string[] | undefined {
  const merged = [...new Set([...(left ?? []), ...(right ?? [])].map(String).filter(Boolean))];
  return merged.length > 0 ? merged : undefined;
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function pruneLayers(layers: Map<string, ProjectionLayer>, now: number, changedSubjects: Set<string>): boolean {
  let changed = false;
  for (const [id, layer] of layers) {
    if (layer.expiresAt !== undefined && layer.expiresAt < now) {
      for (const subject of layer.patches.keys()) changedSubjects.add(subject);
      layers.delete(id);
      changed = true;
    }
  }
  return changed;
}

function clearSubjectFromLayers(layers: Map<string, ProjectionLayer>, subject: string): boolean {
  let changed = false;
  for (const [id, layer] of layers) {
    if (!layer.patches.delete(subject)) continue;
    changed = true;
    if (layer.patches.size === 0) layers.delete(id);
  }
  return changed;
}

function clearPatchFieldsFromLayers(layers: Map<string, ProjectionLayer>, patch: ProjectionPatch): boolean {
  const subject = String(patch.subject ?? "");
  if (!subject) return false;
  let changed = false;
  for (const [id, layer] of layers) {
    const current = layer.patches.get(subject);
    if (!current) continue;
    const next = removePatchFields(current, patch);
    if (isEmptyPatch(next)) layer.patches.delete(subject);
    else layer.patches.set(subject, next);
    if (layer.patches.size === 0) layers.delete(id);
    changed = true;
  }
  return changed;
}

function removePatchFields(current: ProjectionPatch, applied: ProjectionPatch): ProjectionPatch {
  const fields = removeKeys(current.fields, Object.keys(applied.fields ?? {}));
  const props = removeKeys(current.props, Object.keys(applied.props ?? {}));
  const catalogState: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(current.catalogState ?? {})) {
    const next = removeKeys(value, Object.keys(applied.catalogState?.[key] ?? {}));
    if (next && Object.keys(next).length > 0) catalogState[key] = next;
  }
  return {
    subject: current.subject,
    fields,
    props,
    catalogState: Object.keys(catalogState).length > 0 ? catalogState : undefined,
    clearCatalogState: removeClearKeys(current.clearCatalogState, applied)
  };
}

function removeClearKeys(keys: string[] | undefined, applied: ProjectionPatch): string[] | undefined {
  if (!keys || keys.length === 0) return undefined;
  const appliedKeys = new Set([
    ...Object.keys(applied.catalogState ?? {}),
    ...(applied.clearCatalogState ?? [])
  ]);
  const next = keys.filter((key) => !appliedKeys.has(key));
  return next.length > 0 ? next : undefined;
}

function removeKeys(record: Record<string, unknown> | undefined, keys: string[]): Record<string, unknown> | undefined {
  if (!record) return undefined;
  if (keys.length === 0) return { ...record };
  const copy = { ...record };
  for (const key of keys) delete copy[key];
  return Object.keys(copy).length > 0 ? copy : undefined;
}

function isEmptyPatch(patch: ProjectionPatch): boolean {
  return !patch.fields && !patch.props && !patch.catalogState && !patch.clearCatalogState;
}

function subjectsInLayer(layer: ProjectionLayer | undefined): Set<string> {
  return new Set(layer?.patches.keys() ?? []);
}

function livePatchDiscriminator(patch: ProjectionPatch): string {
  const fields = Object.keys(patch.fields ?? {}).map((key) => `field.${key}`);
  const props = Object.keys(patch.props ?? {}).map((key) => `prop.${key}`);
  const catalog = Object.entries(patch.catalogState ?? {}).flatMap(([key, value]) => Object.keys(value).map((field) => `catalog.${key}.${field}`));
  const clearCatalog = (patch.clearCatalogState ?? []).map((key) => `catalog.${key}`);
  return [...fields, ...props, ...catalog, ...clearCatalog].sort().join(",");
}

function qualifyComponentId(alias: string, id: string): string {
  return `${alias}:${id}`;
}

function resolveCatalogRef(pkg: CatalogUiPackage, value: string): string {
  if (!value.startsWith("$") && !value.includes(":")) return value;
  const [alias, local] = value.includes(":") ? value.split(":", 2) : [pkg.alias, value];
  if (alias !== pkg.alias) return value;
  return pkg.objects?.[local] ?? local;
}

function frameRank(frame: UiFrameDecl, view: string | undefined): number | undefined {
  const requested = view && view !== "default" ? view : undefined;
  const frameView = frame.view && frame.view !== "default" ? frame.view : undefined;
  if (requested && frameView !== requested) return undefined;
  if (!requested && frameView) return undefined;
  return requested ? 0 : 1;
}
