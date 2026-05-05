export type AppliedLikeFrame = {
  observations?: unknown[];
};

export type AppliedFrameErrorObservation = {
  type: "$error";
  code?: string;
  message?: string;
  value?: unknown;
  trace?: unknown;
};

export function appliedFrameErrorObservations(frame: AppliedLikeFrame): AppliedFrameErrorObservation[] {
  if (!Array.isArray(frame.observations)) return [];
  return frame.observations.filter((observation): observation is AppliedFrameErrorObservation => {
    return !!observation && typeof observation === "object" && !Array.isArray(observation) && (observation as Record<string, unknown>).type === "$error";
  });
}

export function chatErrorText(error: { type?: unknown; code?: unknown; message?: unknown }): string {
  if (typeof error?.message === "string" && error.message.trim()) return error.message;
  if (typeof error?.code === "string" && error.code.trim()) return error.code;
  return "That didn't work.";
}
