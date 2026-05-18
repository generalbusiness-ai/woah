export type MetricErrorFields = {
  error: string;
  error_detail?: string;
};

const MAX_ERROR_DETAIL_CHARS = 96;

export function metricErrorFields(err: unknown): MetricErrorFields {
  const code = metricErrorCodeFromValue(err);
  if (code) return { error: code };

  const detail = metricErrorDetail(err);
  return {
    error: "E_INTERNAL",
    ...(detail ? { error_detail: detail } : {})
  };
}

export function metricErrorCode(err: unknown): string {
  return metricErrorFields(err).error;
}

function metricErrorCodeFromValue(err: unknown): string | null {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code.trim()) return code;
  }
  return null;
}

function metricErrorDetail(err: unknown): string | null {
  let raw = "";
  if (err instanceof Error) raw = err.message;
  else if (typeof err === "string") raw = err;
  else if (err !== null && err !== undefined) {
    try {
      raw = JSON.stringify(err);
    } catch {
      raw = String(err);
    }
  }
  const sanitized = raw
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!sanitized) return null;
  return sanitized.length <= MAX_ERROR_DETAIL_CHARS
    ? sanitized
    : `${sanitized.slice(0, MAX_ERROR_DETAIL_CHARS - 1)}…`;
}
