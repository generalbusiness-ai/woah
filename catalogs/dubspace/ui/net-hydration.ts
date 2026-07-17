import { dubspaceControlDefinitions, type DubspaceControlRoles } from "./model";
import type {
  ProjectionPatch,
  WooViewHydration,
  WooViewHydrationContext
} from "../../../src/client/framework";

export type DubspaceControlCellView = {
  space: { id: string; name: string };
  meta: DubspaceControlRoles;
  controls: Array<{ id: string; name: string; props: Record<string, unknown> }>;
};

function record(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : null;
}

function frameRoles(context: WooViewHydrationContext): DubspaceControlRoles {
  return record(context.frameState.control_roles) ?? {};
}

function frameDefaults(context: WooViewHydrationContext): Record<string, Record<string, unknown>> {
  return record(context.frameState.control_defaults) ?? {};
}

function projectedRoles(context: WooViewHydrationContext): DubspaceControlRoles {
  return record(context.observe(context.subject)?.catalogState?.dubspace_controls) ?? frameRoles(context);
}

/** Translate the catalog's controls view into the shell's generic projection
 * patch format. Role vocabulary remains here with the catalog model; callers
 * apply the result without rebuilding or interpreting that vocabulary. */
export function dubspaceControlsProjectionPatches(space: string, view: unknown): ProjectionPatch[] | null {
  const value = record(view);
  const meta = record(value?.meta);
  if (!value || !meta || !Array.isArray(meta.slots)) return null;
  const rows = [value.space, ...(Array.isArray(value.controls) ? value.controls : [])];
  const patches: ProjectionPatch[] = [];
  for (const row of rows) {
    const id = String(row?.id ?? "");
    if (!id) continue;
    patches.push({
      subject: id,
      fields: {
        ...(typeof row?.name === "string" ? { name: row.name } : {}),
        ...(typeof row?.description === "string" ? { description: row.description } : {})
      },
      props: record(row?.props) ?? {}
    });
  }
  const spacePatch = patches.find((patch) => patch.subject === space);
  if (!spacePatch) return null;
  spacePatch.catalogState = {
    dubspace_controls: {
      slots: meta.slots.filter((id: unknown): id is string => typeof id === "string" && Boolean(id)),
      channel: typeof meta.channel === "string" ? meta.channel : "",
      filter: typeof meta.filter === "string" ? meta.filter : "",
      delay: typeof meta.delay === "string" ? meta.delay : "",
      drum: typeof meta.drum === "string" ? meta.drum : "",
      scene: typeof meta.scene === "string" ? meta.scene : ""
    }
  };
  return patches;
}

function projectionComplete(context: WooViewHydrationContext): boolean {
  const definitions = dubspaceControlDefinitions(projectedRoles(context), frameDefaults(context));
  return definitions.length > 0 && definitions.every(([id, names]) => {
    const props = id ? context.observe(id)?.props : null;
    return Boolean(props && names.every((name) => Object.prototype.hasOwnProperty.call(props, name)));
  });
}

function viewComplete(context: WooViewHydrationContext, patches: readonly ProjectionPatch[]): boolean {
  const byId = new Map(patches.map((patch) => [patch.subject, patch.props ?? {}]));
  const spacePatch = patches.find((patch) => patch.subject === context.subject);
  const roles = record(spacePatch?.catalogState?.dubspace_controls) ?? frameRoles(context);
  const definitions = dubspaceControlDefinitions(roles, frameDefaults(context));
  return definitions.length > 0 && definitions.every(([id, names]) => {
    const props = byId.get(id);
    return Boolean(props && names.every((name) => Object.prototype.hasOwnProperty.call(props, name)));
  });
}

async function readControlsView(context: WooViewHydrationContext): Promise<unknown> {
  if (!installedDubspaceSupportsControlsView(context.installedCatalogs)) {
    return readAgedDubspaceControlCells({
      space: context.subject,
      roles: frameRoles(context),
      defaults: frameDefaults(context),
      readCell: context.readCell,
      nameOf: context.nameOf
    });
  }
  try {
    return await context.call(context.subject, "controls_view", [], { serverRead: true });
  } catch (error) {
    if (!isAgedDubspaceControlsError(error)) throw error;
    return readAgedDubspaceControlCells({
      space: context.subject,
      roles: frameRoles(context),
      defaults: frameDefaults(context),
      readCell: context.readCell,
      nameOf: context.nameOf
    });
  }
}

/** Frame-declared cold hydration contract registered by dubspace-workspace.
 * The generic shell owns coalescing/backoff; this catalog owns every semantic
 * detail of reading, validating, and projecting its control surface. */
export const dubspaceControlsHydration: WooViewHydration = {
  complete: projectionComplete,
  async read(context) {
    if (!context.present) throw new Error("dubspace controls require room presence");
    const patches = dubspaceControlsProjectionPatches(context.subject, await readControlsView(context));
    if (!patches) throw new Error("dubspace controls view was malformed");
    if (!viewComplete(context, patches)) throw new Error("dubspace controls view was incomplete");
    return patches;
  }
};

const CELL_READ_PACE_MS = 25;
const CELL_RATE_BACKOFF_MS = 250;
const CELL_RATE_RETRIES = 4;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateError(error: any): boolean {
  return String(error?.code ?? error?.error?.code ?? error?.detail?.code ?? "") === "E_RATE";
}

/** Only an authoritative installed-catalog record may opt a durable world in
 * to controls_view. A bundled manifest version is not evidence of live state. */
export function installedDubspaceSupportsControlsView(installed: unknown): boolean {
  if (!Array.isArray(installed)) return false;
  const record = installed.find((item: any) => item?.alias === "dubspace" || item?.catalog === "dubspace");
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(record?.version ?? ""));
  if (!match) return false;
  const version = match.slice(1).map(Number);
  return version[0] > 1 || (version[0] === 1 && (version[1] > 0 || (version[1] === 0 && version[2] >= 2)));
}

/** The two terminal failures that mean an installed Dubspace may predate its
 * bounded controls_view verb. Other failures retain their original taxonomy. */
export function isAgedDubspaceControlsError(error: any): boolean {
  const code = String(error?.code ?? error?.error?.code ?? error?.detail?.code ?? "");
  return code === "E_VERBNF" || code === "E_BUDGET";
}

function cellPayload(cell: unknown): Record<string, any> | undefined {
  if (!cell || typeof cell !== "object" || Array.isArray(cell)) return undefined;
  const value = (cell as { value?: unknown }).value;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

/** Read only the fixed public properties declared by the Dubspace frame.
 * The caller supplies the presence-authorized net reader; this function never
 * enumerates objects or discovers arbitrary property names. */
export async function readAgedDubspaceControlCells(input: {
  space: string;
  roles: DubspaceControlRoles;
  defaults?: Record<string, Record<string, unknown>>;
  readCell: (key: string) => Promise<unknown>;
  nameOf?: (id: string) => string;
  wait?: (ms: number) => Promise<void>;
}): Promise<DubspaceControlCellView> {
  const { space, roles, readCell, defaults = {} } = input;
  const nameOf = input.nameOf ?? ((id: string) => id);
  const pause = input.wait ?? wait;
  const definitions = dubspaceControlDefinitions(roles, defaults);
  const requested = definitions.flatMap(([id, names]) => names.map((name) => ({ id, name })));
  const cells: unknown[] = [];
  // Shell startup already consumes much of the shared 50/s, burst-100 net
  // budget. A 27-way Promise.all can therefore reject with E_RATE even
  // though every key is authorized and cheap. Pace this compatibility-only
  // surface and retry only the gateway's explicitly recoverable rate error;
  // permission, taxonomy, and transport failures still surface immediately.
  for (const { id, name } of requested) {
    let retries = 0;
    while (true) {
      try {
        cells.push(await readCell(`property_cell:${id}:${name}`));
        break;
      } catch (error) {
        if (!isRateError(error) || retries >= CELL_RATE_RETRIES) throw error;
        retries += 1;
        await pause(CELL_RATE_BACKOFF_MS);
      }
    }
    if (cells.length < requested.length) await pause(CELL_READ_PACE_MS);
  }
  // Sparse net storage legitimately omits values that still equal their
  // catalog seed/default. Start from the frame-declared baseline, then let
  // every materialized authoritative cell override its corresponding value.
  const propsById = new Map<string, Record<string, unknown>>(
    definitions.map(([id]) => [id, { ...(defaults[id] ?? {}) }])
  );
  requested.forEach(({ id, name }, index) => {
    const payload = cellPayload(cells[index]);
    if (!payload || !Object.prototype.hasOwnProperty.call(payload, "value")) return;
    const props = propsById.get(id) ?? {};
    props[name] = payload.value;
    propsById.set(id, props);
  });
  return {
    space: { id: space, name: nameOf(space) },
    meta: roles,
    controls: definitions.map(([id]) => ({ id, name: nameOf(id), props: propsById.get(id) ?? {} }))
  };
}
