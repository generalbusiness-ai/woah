import { dubspaceControlDefinitions, type DubspaceControlRoles } from "./model";

export type DubspaceControlCellView = {
  space: { id: string; name: string };
  meta: DubspaceControlRoles;
  controls: Array<{ id: string; name: string; props: Record<string, unknown> }>;
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
