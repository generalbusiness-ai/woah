/** Cloudflare Durable Object storage billing queries shared by canary gates
 * and scheduled alerts. The billing API is the authority here; application
 * metrics cannot reconstruct base-table plus secondary-index row writes. */

export type CloudflareFetch = typeof fetch;

export type DurableObjectNamespace = {
  id: string;
  name: string;
  className: string;
  script: string;
};

export type DurableObjectStorageObject = {
  namespaceId: string;
  namespace: string;
  className: string;
  objectId: string;
  name: string;
  rowsWritten: number;
  requests: number;
  /** Number of periodic billing samples observed for this object. Requests
   * without a corresponding sample are lag/incompleteness, not zero writes. */
  periodicSamples: number;
};

export type DurableObjectStorageReport = {
  worker: string;
  from: string;
  to: string;
  namespaces: DurableObjectNamespace[];
  objects: DurableObjectStorageObject[];
  totalRowsWritten: number;
  totalRequests: number;
};

export type DurableObjectStorageBudget = {
  maxRowsWritten: number;
  maxRowsWrittenPerObject: number;
};

export type DurableObjectStorageDecision = {
  state: "pass" | "violation" | "incomplete";
  failures: string[];
};

type ApiEnvelope<T> = { success?: boolean; result?: T; errors?: unknown[]; result_info?: { page?: number; total_pages?: number } };

function finiteNonNegative(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

async function responseJson<T>(response: Response, label: string): Promise<T> {
  const text = await response.text();
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new Error(`${label} returned non-JSON HTTP ${response.status}`);
  }
  if (!response.ok) throw new Error(`${label} failed HTTP ${response.status}: ${JSON.stringify(decoded)}`);
  return decoded as T;
}

/** Resolve namespace ids from the Worker name on every run. Canary recreation
 * produces fresh ids; a checked-in id would silently monitor the retired copy. */
export async function workerDurableObjectNamespaces(input: {
  accountId: string;
  token: string;
  worker: string;
  fetchImpl?: CloudflareFetch;
}): Promise<DurableObjectNamespace[]> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const out: DurableObjectNamespace[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${input.accountId}/workers/durable_objects/namespaces`);
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", "100");
    const response = await fetchImpl(url, { headers: { authorization: `Bearer ${input.token}` } });
    const body = await responseJson<ApiEnvelope<Array<Record<string, unknown>>>>(response, "Durable Object namespace list");
    if (body.success !== true || !Array.isArray(body.result)) {
      throw new Error(`Durable Object namespace list returned an unsuccessful envelope: ${JSON.stringify(body.errors ?? [])}`);
    }
    for (const row of body.result) {
      const script = typeof row.script === "string" ? row.script : "";
      if (script !== input.worker) continue;
      const id = typeof row.id === "string" ? row.id : "";
      const className = typeof row.class === "string" ? row.class : "";
      const name = typeof row.name === "string" ? row.name : `${script}/${className}`;
      if (id && className) out.push({ id, name, className, script });
    }
    const totalPages = Number(body.result_info?.total_pages ?? page);
    if (page >= totalPages || body.result.length < 100) break;
  }
  return out.sort((a, b) => a.className.localeCompare(b.className));
}

const STORAGE_QUERY = `
query DurableObjectStorage($accountTag: String!, $start: Time!, $end: Time!, $namespaceId: String!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      durableObjectsPeriodicGroups(limit: 10000, filter: { datetime_geq: $start, datetime_lt: $end, namespaceId: $namespaceId }) {
        dimensions { objectId name namespaceId }
        sum { rowsWritten }
      }
      durableObjectsInvocationsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $start, datetime_lt: $end, namespaceId: $namespaceId }) {
        dimensions { objectId namespaceId }
        sum { requests }
      }
    }
  }
}`;

type PeriodicRow = { dimensions?: { objectId?: string; name?: string; namespaceId?: string }; sum?: { rowsWritten?: number } };
type InvocationRow = { dimensions?: { objectId?: string; namespaceId?: string }; sum?: { requests?: number } };

async function namespaceStorage(input: {
  accountId: string;
  token: string;
  namespace: DurableObjectNamespace;
  from: string;
  to: string;
  fetchImpl: CloudflareFetch;
}): Promise<DurableObjectStorageObject[]> {
  const response = await input.fetchImpl("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      query: STORAGE_QUERY,
      variables: { accountTag: input.accountId, start: input.from, end: input.to, namespaceId: input.namespace.id }
    })
  });
  const body = await responseJson<{
    data?: { viewer?: { accounts?: Array<{
      durableObjectsPeriodicGroups?: PeriodicRow[];
      durableObjectsInvocationsAdaptiveGroups?: InvocationRow[];
    }> } };
    errors?: unknown[];
  }>(response, `Durable Object storage query for ${input.namespace.name}`);
  if (body.errors?.length) throw new Error(`Durable Object storage GraphQL errors: ${JSON.stringify(body.errors)}`);
  const account = body.data?.viewer?.accounts?.[0];
  if (!account) throw new Error(`Durable Object storage query returned no account for ${input.namespace.name}`);
  const periodic = account.durableObjectsPeriodicGroups;
  const invocations = account.durableObjectsInvocationsAdaptiveGroups;
  if (!Array.isArray(periodic) || !Array.isArray(invocations)) {
    throw new Error(`Durable Object storage query omitted required datasets for ${input.namespace.name}`);
  }
  if (periodic.length >= 10000 || invocations.length >= 10000) {
    throw new Error(`Durable Object storage query hit its 10,000-row safety limit for ${input.namespace.name}`);
  }
  const objects = new Map<string, DurableObjectStorageObject>();
  const ensure = (objectId: string): DurableObjectStorageObject => {
    const existing = objects.get(objectId);
    if (existing) return existing;
    const row = {
      namespaceId: input.namespace.id,
      namespace: input.namespace.name,
      className: input.namespace.className,
      objectId,
      name: "",
      rowsWritten: 0,
      requests: 0,
      periodicSamples: 0
    };
    objects.set(objectId, row);
    return row;
  };
  for (const row of periodic) {
    const objectId = row.dimensions?.objectId;
    if (!objectId) continue;
    const object = ensure(objectId);
    object.name = row.dimensions?.name ?? object.name;
    object.rowsWritten += finiteNonNegative(row.sum?.rowsWritten);
    object.periodicSamples += 1;
  }
  for (const row of invocations) {
    const objectId = row.dimensions?.objectId;
    if (!objectId) continue;
    ensure(objectId).requests += finiteNonNegative(row.sum?.requests);
  }
  return [...objects.values()].sort((a, b) => b.rowsWritten - a.rowsWritten || a.objectId.localeCompare(b.objectId));
}

export async function queryWorkerDurableObjectStorage(input: {
  accountId: string;
  token: string;
  worker: string;
  from: string;
  to: string;
  /** Restrict the queried namespaces when a caller has a narrower contract.
   * Omitted means every namespace currently owned by the Worker. */
  classNames?: string[];
  requiredClassNames?: string[];
  fetchImpl?: CloudflareFetch;
}): Promise<DurableObjectStorageReport> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const all = await workerDurableObjectNamespaces({ ...input, fetchImpl });
  const wantedClasses = input.classNames === undefined ? null : new Set(input.classNames);
  const namespaces = wantedClasses === null
    ? all
    : all.filter((namespace) => wantedClasses.has(namespace.className));
  const requiredClasses = input.requiredClassNames ?? ["NetGatewayDO", "NetScopeDO", "NetAuditDO"];
  const missing = requiredClasses.filter((name) => !namespaces.some((namespace) => namespace.className === name));
  if (missing.length > 0) {
    throw new Error(`worker ${input.worker} is missing required Durable Object namespaces: ${missing.join(", ")}`);
  }
  const objects = (await Promise.all(namespaces.map((namespace) => namespaceStorage({
    ...input,
    namespace,
    fetchImpl
  })))).flat();
  return {
    worker: input.worker,
    from: input.from,
    to: input.to,
    namespaces,
    objects,
    totalRowsWritten: objects.reduce((sum, object) => sum + object.rowsWritten, 0),
    totalRequests: objects.reduce((sum, object) => sum + object.requests, 0)
  };
}

export function evaluateDurableObjectStorage(
  report: DurableObjectStorageReport,
  budget: DurableObjectStorageBudget
): DurableObjectStorageDecision {
  const failures: string[] = [];
  if (report.totalRequests <= 0) {
    return { state: "incomplete", failures: ["no Durable Object invocations were visible for the measured window"] };
  }
  const missingSamples = report.objects.filter((object) => object.requests > 0 && object.periodicSamples <= 0);
  if (missingSamples.length > 0) {
    return {
      state: "incomplete",
      failures: missingSamples.map((object) =>
        `${object.namespace}/${object.name || object.objectId} had invocations but no periodic storage sample`
      )
    };
  }
  if (report.totalRowsWritten > budget.maxRowsWritten) {
    failures.push(`worker rows written ${report.totalRowsWritten} > ${budget.maxRowsWritten}`);
  }
  for (const object of report.objects) {
    if (object.rowsWritten > budget.maxRowsWrittenPerObject) {
      failures.push(
        `${object.namespace}/${object.name || object.objectId} rows written ${object.rowsWritten} > ${budget.maxRowsWrittenPerObject}`
      );
    }
  }
  return { state: failures.length > 0 ? "violation" : "pass", failures };
}

export function storageReportForOutput(report: DurableObjectStorageReport): Record<string, unknown> {
  return {
    worker: report.worker,
    from: report.from,
    to: report.to,
    total_rows_written: report.totalRowsWritten,
    total_requests: report.totalRequests,
    namespaces: report.namespaces.map(({ id, name, className }) => ({ id, name, class: className })),
    objects: report.objects.map((object) => ({
      namespace: object.namespace,
      class: object.className,
      object: object.name || object.objectId,
      object_id: object.objectId,
      rows_written: object.rowsWritten,
      requests: object.requests,
      periodic_samples: object.periodicSamples
    }))
  };
}
