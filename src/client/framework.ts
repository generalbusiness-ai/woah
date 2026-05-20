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
};

export type ProjectionSubscriber = (value: ObjectProjection | undefined, ref: string) => void;

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

export type CatalogUiManifest = {
  abi: string;
  modules?: UiModuleDecl[];
  components?: UiComponentDecl[];
  frames?: UiFrameDecl[];
  observation_handlers?: UiObservationHandlerDecl[];
  chat_formatters?: UiChatFormatterDecl[];
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
};

export type WooComponentRegistry = {
  defineTag(tag: string, ctor: CustomElementConstructor): void;
};

export type WooNeighborhood = {
  subject: string;
  refs: readonly string[];
  related: Readonly<Record<string, string | null>>;
  has(ref: string): boolean;
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
    mod.registerWooComponents?.({ defineTag: (tag, ctor) => this.defineTag(alias, moduleId, tag, ctor) });
    mod.registerWooObservationHandlers?.(observations);
    mod.registerWooChatFormatters?.(chatFormatters);
    this.loadedModules.add(key);
  }

  registerModuleExports(alias: string, moduleId: string, mod: ModuleExports, observations: ObservationRegistry, chatFormatters: ChatFormatterRegistry): void {
    const key = `${alias}:${moduleId}`;
    if (this.loadedModules.has(key)) return;
    const pkg = this.catalogs.get(alias);
    if (!pkg) throw new Error(`unknown catalog UI alias: ${alias}`);
    if (!(pkg.ui.modules ?? []).some((module) => module.id === moduleId)) throw new Error(`unknown UI module ${moduleId} for ${alias}`);
    mod.registerWooComponents?.({ defineTag: (tag, ctor) => this.defineTag(alias, moduleId, tag, ctor) });
    mod.registerWooObservationHandlers?.(observations);
    mod.registerWooChatFormatters?.(chatFormatters);
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

  ingestWorld(world: any) {
    const changed = new Set(this.canonical.keys());
    this.scopedCanonical.clear();
    this.scopeOrder = [];
    this.authoritativeCanonical.clear();
    this.canonical.clear();
    for (const [id, obj] of Object.entries(world?.objects ?? {})) {
      this.canonical.set(id, normalizeObjectProjection(id, obj));
      changed.add(id);
    }
    for (const [id, obj] of Object.entries(world?.dubspace ?? {})) {
      this.upsertCanonicalObject(id, obj);
      changed.add(id);
    }
    for (const note of Array.isArray(world?.pinboard?.notes) ? world.pinboard.notes : []) {
      const id = String(note?.id ?? "");
      if (!id) continue;
      this.patchCanonical(id, {
        fields: {
          name: typeof note?.name === "string" ? note.name : undefined,
          owner: typeof note?.owner === "string" ? note.owner : typeof note?.author === "string" ? note.author : undefined
        },
        catalogState: { pinboard_note: pinboardNoteState(note) }
      });
      changed.add(id);
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

export class ObservationRegistry {
  private handlers: WooObservationHandler[] = [];

  constructor(private readonly projection: ClientProjection) {}

  observation(handler: WooObservationHandler) {
    this.handlers.push(handler);
  }

  deliver(observation: Record<string, unknown>, delivered: DeliveredObservation) {
    const type = String(observation?.type ?? "");
    if (!type) return;
    const envelope = { observation, delivered };
    if (delivered.route === "live") {
      const livePatches: ProjectionPatch[] = [];
      const canonicalPatches: ProjectionPatch[] = [];
      const canonicalClears: string[] = [];
      for (const handler of this.handlers) {
        if (!handler.types.includes(type)) continue;
        if (handler.route && handler.route !== "both" && handler.route !== delivered.route) continue;
        const draft = new ProjectionDraft();
        handler.reduce(draft, envelope);
        const patches = draft.consume();
        const clears = draft.consumeAuthoritativeClears();
        if (handler.liveProjection === "canonical") {
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
      return;
    }

    const draft = new ProjectionDraft();
    for (const handler of this.handlers) {
      if (!handler.types.includes(type)) continue;
      if (handler.route && handler.route !== "both" && handler.route !== delivered.route) continue;
      handler.reduce(draft, envelope);
    }
    const patches = draft.consume();
    const authoritativeClears = draft.consumeAuthoritativeClears();
    if (patches.length === 0 && authoritativeClears.length === 0) return;
    for (const subject of authoritativeClears) this.projection.clearAuthoritative(subject, { notify: patches.length === 0 });
    this.projection.applySequenced(patches);
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

  constructor() {
    registerCoreObservationHandlers(this.observations);
  }

  ingestWorld(world: any) {
    this.projection.ingestWorld(world);
  }

  ingestAppliedFrame(frame: any) {
    const delivered: DeliveredObservation = {
      route: "sequenced",
      seq: typeof frame?.seq === "number" ? frame.seq : undefined,
      space: typeof frame?.space === "string" ? frame.space : undefined,
      frameId: typeof frame?.id === "string" ? frame.id : undefined,
      receivedAt: Date.now()
    };
    for (const observation of frame?.observations ?? []) {
      if (observation && typeof observation === "object" && !Array.isArray(observation)) {
        this.observations.deliver(observation, delivered);
      }
    }
  }

  ingestLiveObservation(observation: any) {
    if (!observation || typeof observation !== "object" || Array.isArray(observation)) return;
    this.observations.deliver(observation, { route: "live", receivedAt: Date.now() });
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
    return this.projection.prune(now);
  }

  refs() {
    return this.projection.refs();
  }
}

export function createWooClientFramework() {
  return new WooClientFramework();
}

// Room-contents snapshots are thin by design (no props), so a viewer who just
// entered a room sees only id/name/parent for the subject until live
// observations or a full summary fill in the rest. One round-trip per subject
// per session: if the server's summary did not carry the requested field,
// refetching cannot conjure it; live observations remain authoritative.
export class ProjectionFieldFiller {
  private inFlight = new Set<string>();
  private completed = new Set<string>();
  private generation = 0;
  constructor(
    private observe: (subject: string) => { props?: Record<string, unknown> } | null | undefined,
    private fetchSummary: (subject: string) => Promise<unknown>,
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
    void this.fetchSummary(subject)
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
  // `note_edited` / `note_writers_changed` update the underlying $note's
  // canonical props so any surface (inventory, look-at, search) sees the new
  // text/writers. Catalog overlays (pinboard_note, taskspace_task) that mirror
  // these fields for fast component access are patched by the catalog's own
  // observation handler — see catalogs/pinboard/ui and catalogs/taskspace/ui.
  registry.observation({
    types: ["note_edited"],
    route: "sequenced",
    reduce: (draft, envelope) => {
      const note = String(envelope.observation.note ?? envelope.observation.pin ?? envelope.observation.id ?? "");
      if (note) draft.patchObjectProps(note, { text: envelope.observation.text });
    }
  });
  registry.observation({
    types: ["note_writers_changed"],
    route: "sequenced",
    reduce: (draft, envelope) => {
      const note = String(envelope.observation.note ?? envelope.observation.pin ?? envelope.observation.id ?? "");
      if (!note) return;
      const writers = Array.isArray(envelope.observation.writers)
        ? envelope.observation.writers.filter((item) => typeof item === "string")
        : [];
      draft.patchObjectProps(note, { writers });
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

function pinboardNoteState(note: any): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const key of ["x", "y", "z", "w", "h", "text", "color", "author", "owner", "writers"]) {
    if (note?.[key] !== undefined) fields[key] = note[key];
  }
  return fields;
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
