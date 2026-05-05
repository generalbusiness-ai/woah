export type WooObservationRoute = "sequenced" | "live";

export type ObjectProjection = {
  id: string;
  name?: string;
  owner?: string;
  parent?: string;
  location?: string;
  props: Record<string, unknown>;
  catalogState: Record<string, Record<string, unknown>>;
};

export type ProjectionPatch = {
  subject: string;
  fields?: Record<string, unknown>;
  props?: Record<string, unknown>;
  catalogState?: Record<string, Record<string, unknown>>;
};

export function liveProjectionKey(type: string, subject: string, discriminator?: string): string {
  return ["live", type, subject, discriminator].filter((part) => part !== undefined && part !== "").map(String).join(":");
}

export type DeliveredObservation = {
  route: WooObservationRoute;
  seq?: number;
  space?: string;
  frameId?: string;
  receivedAt: number;
};

export type ObservationEnvelope = {
  observation: Record<string, unknown>;
  delivered: DeliveredObservation;
};

export type ClientProjectionDraft = {
  patchObject(ref: string, fields: Record<string, unknown>): void;
  patchObjectProps(ref: string, props: Record<string, unknown>): void;
  patchCatalogState(ref: string, key: string, fields: Record<string, unknown>): void;
};

export type WooObservationHandler = {
  types: string[];
  route?: WooObservationRoute | "both";
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

export type CatalogUiManifest = {
  abi: string;
  modules?: UiModuleDecl[];
  components?: UiComponentDecl[];
  frames?: UiFrameDecl[];
  observation_handlers?: UiObservationHandlerDecl[];
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
};

export type WooComponentRegistry = {
  defineTag(tag: string, ctor: CustomElementConstructor): void;
};

type ProjectionLayer = {
  patches: Map<string, ProjectionPatch>;
  expiresAt?: number;
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
    this.loadedModules.add(key);
  }

  resolveFrame(subject: string, view: string | undefined, isA: (subject: string, classRef: string) => number | false): ResolvedFrame | undefined {
    const candidates: ResolvedFrame[] = [];
    for (const pkg of this.catalogs.values()) {
      for (const frame of pkg.ui.frames ?? []) {
        const rank = frameRank(frame, subject, view);
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
  private sequenced = new Map<string, ProjectionPatch>();
  private live = new Map<string, ProjectionLayer>();
  private optimistic = new Map<string, ProjectionLayer>();

  ingestWorld(world: any) {
    this.canonical.clear();
    for (const [id, obj] of Object.entries(world?.objects ?? {})) {
      this.canonical.set(id, normalizeObjectProjection(id, obj));
    }
    for (const [id, obj] of Object.entries(world?.dubspace ?? {})) {
      this.upsertCanonicalObject(id, obj);
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
    }
    this.prune(Date.now());
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

  applySequenced(patches: ProjectionPatch[]) {
    for (const patch of patches) {
      const subject = String(patch.subject ?? "");
      if (!subject) continue;
      this.sequenced.set(subject, mergePatch(this.sequenced.get(subject), patch));
      clearSubjectFromLayers(this.live, subject);
      clearSubjectFromLayers(this.optimistic, subject);
    }
  }

  applyLive(id: string, patches: ProjectionPatch[], expiresMs = LIVE_TTL_MS) {
    this.applyTimedLayer(this.live, id, patches, expiresMs);
  }

  applyOptimistic(id: string, patches: ProjectionPatch[], expiresMs = OPTIMISTIC_TTL_MS) {
    this.applyTimedLayer(this.optimistic, id, patches, expiresMs);
  }

  clearLive(id: string) {
    this.live.delete(id);
  }

  clearOptimistic(id: string) {
    this.optimistic.delete(id);
  }

  clearOptimisticForSubject(subject: string) {
    clearSubjectFromLayers(this.optimistic, subject);
  }

  prune(now = Date.now()): boolean {
    return pruneLayers(this.live, now) || pruneLayers(this.optimistic, now);
  }

  private applyTimedLayer(target: Map<string, ProjectionLayer>, id: string, patches: ProjectionPatch[], expiresMs: number) {
    const layerId = String(id ?? "");
    if (!layerId) return;
    const layer: ProjectionLayer = target.get(layerId) ?? { patches: new Map() };
    layer.expiresAt = Date.now() + Math.max(0, expiresMs);
    for (const patch of patches) {
      const subject = String(patch.subject ?? "");
      if (!subject) continue;
      layer.patches.set(subject, mergePatch(layer.patches.get(subject), patch));
    }
    target.set(layerId, layer);
  }

  private upsertCanonicalObject(id: string, obj: unknown) {
    this.canonical.set(id, mergeObjectProjection(this.canonical.get(id) ?? emptyObjectProjection(id), normalizeObjectProjection(id, obj)));
  }

  private patchCanonical(id: string, patch: Omit<ProjectionPatch, "subject">) {
    const current = this.canonical.get(id) ?? emptyObjectProjection(id);
    applyPatch(current, { subject: id, ...patch });
    this.canonical.set(id, current);
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
    const draft = new ProjectionDraft();
    const envelope = { observation, delivered };
    for (const handler of this.handlers) {
      if (!handler.types.includes(type)) continue;
      if (handler.route && handler.route !== "both" && handler.route !== delivered.route) continue;
      handler.reduce(draft, envelope);
    }
    const patches = draft.consume();
    if (patches.length === 0) return;
    if (delivered.route === "live") {
      for (const patch of patches) {
        this.projection.applyLive(liveProjectionKey(type, patch.subject, livePatchDiscriminator(patch)), [patch]);
      }
    } else {
      this.projection.applySequenced(patches);
    }
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
  readonly frames = new FrameStateStore();

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

  prune(now = Date.now()) {
    return this.projection.prune(now);
  }
}

export function createWooClientFramework() {
  return new WooClientFramework();
}

export function registerCoreObservationHandlers(registry: ObservationRegistry) {
  registry.observation({
    types: ["pin_moved", "note_moved", "pin_resized", "note_resized"],
    route: "sequenced",
    reduce: (draft, envelope) => {
      const obs = envelope.observation;
      const pin = String(obs.pin ?? obs.id ?? "");
      if (!pin) return;
      const fields: Record<string, unknown> = {};
      for (const key of ["x", "y", "z", "w", "h"]) {
        const value = Number(obs[key]);
        if (Number.isFinite(value)) fields[key] = value;
      }
      if (Object.keys(fields).length > 0) draft.patchCatalogState(pin, "pinboard_note", fields);
    }
  });
  registry.observation({
    types: ["control_changed"],
    route: "sequenced",
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

  consume(): ProjectionPatch[] {
    return [...this.patches.values()];
  }

  private merge(subject: string, patch: ProjectionPatch) {
    this.patches.set(subject, mergePatch(this.patches.get(subject), patch));
  }
}

function normalizeObjectProjection(id: string, obj: any): ObjectProjection {
  const props = obj?.props && typeof obj.props === "object" && !Array.isArray(obj.props) ? obj.props : {};
  return {
    id,
    name: typeof obj?.name === "string" ? obj.name : undefined,
    owner: typeof obj?.owner === "string" ? obj.owner : undefined,
    parent: typeof obj?.parent === "string" ? obj.parent : undefined,
    location: typeof obj?.location === "string" ? obj.location : undefined,
    props: { ...props },
    catalogState: {}
  };
}

function emptyObjectProjection(id: string): ObjectProjection {
  return { id, props: {}, catalogState: {} };
}

function cloneObjectProjection(value: ObjectProjection): ObjectProjection {
  return {
    ...value,
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
      location: right.location
    }),
    props: { ...left.props, ...right.props },
    catalogState: { ...left.catalogState, ...right.catalogState }
  };
}

function hasProjectionData(value: ObjectProjection): boolean {
  return Boolean(value.name || value.owner || value.parent || value.location || Object.keys(value.props).length > 0 || Object.keys(value.catalogState).length > 0);
}

function applyPatch(target: ObjectProjection, patch: ProjectionPatch | undefined) {
  if (!patch) return;
  if (patch.fields) Object.assign(target, stripUndefined(patch.fields));
  if (patch.props) Object.assign(target.props, stripUndefined(patch.props));
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
    catalogState: mergeCatalogState(left?.catalogState, right.catalogState)
  };
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

function pruneLayers(layers: Map<string, ProjectionLayer>, now: number): boolean {
  let changed = false;
  for (const [id, layer] of layers) {
    if (layer.expiresAt !== undefined && layer.expiresAt < now) {
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

function livePatchDiscriminator(patch: ProjectionPatch): string {
  const fields = Object.keys(patch.fields ?? {}).map((key) => `field.${key}`);
  const props = Object.keys(patch.props ?? {}).map((key) => `prop.${key}`);
  const catalog = Object.entries(patch.catalogState ?? {}).flatMap(([key, value]) => Object.keys(value).map((field) => `catalog.${key}.${field}`));
  return [...fields, ...props, ...catalog].sort().join(",");
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

function frameRank(frame: UiFrameDecl, subject: string, view: string | undefined): number | undefined {
  const requested = view && view !== "default" ? view : undefined;
  const frameView = frame.view && frame.view !== "default" ? frame.view : undefined;
  if (requested && frameView !== requested) return undefined;
  if (!requested && frameView) return undefined;
  return requested ? 0 : 1;
}
