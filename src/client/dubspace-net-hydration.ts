export type DubspaceControlRoles = {
  slots?: unknown;
  channel?: unknown;
  filter?: unknown;
  delay?: unknown;
  drum?: unknown;
  scene?: unknown;
  space?: unknown;
};

export type DubspaceControlCellView = {
  space: { id: string; name: string };
  meta: DubspaceControlRoles;
  controls: Array<{ id: string; name: string; props: Record<string, unknown> }>;
};

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
  readCell: (key: string) => Promise<unknown>;
  nameOf?: (id: string) => string;
}): Promise<DubspaceControlCellView> {
  const { space, roles, readCell } = input;
  const nameOf = input.nameOf ?? ((id: string) => id);
  const definitions = ([
    ...(Array.isArray(roles.slots) ? roles.slots.map((id) => [String(id ?? ""), ["loop_id", "playing", "gain", "freq"]] as [string, string[]]) : []),
    [String(roles.channel ?? ""), ["gain"]],
    [String(roles.filter ?? ""), ["cutoff"]],
    [String(roles.delay ?? ""), ["send", "time", "feedback", "wet"]],
    [String(roles.drum ?? ""), ["bpm", "playing", "started_at", "step_count", "pattern"]]
  ] as Array<[string, string[]]>).filter(([id]) => Boolean(id));
  const requested = definitions.flatMap(([id, names]) => names.map((name) => ({ id, name })));
  const cells = await Promise.all(requested.map(({ id, name }) => readCell(`property_cell:${id}:${name}`)));
  const propsById = new Map<string, Record<string, unknown>>();
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
