import type { ChatLine } from "../../catalogs/chat/ui/chat-space";
import { chatErrorText } from "./chat-errors";

export function provisionalChatErrorLine(input: {
  turnId: string;
  source?: string;
  error: { type?: unknown; code?: unknown; message?: unknown };
  ts?: number;
}): ChatLine {
  return {
    kind: "error",
    turnId: input.turnId,
    provisional: true,
    source: input.source,
    text: chatErrorText(input.error),
    ts: input.ts ?? Date.now()
  };
}

export function upsertProvisionalChatLine(feed: readonly ChatLine[], line: ChatLine, limit: number): ChatLine[] {
  const turnId = line.turnId;
  const withoutPrior = turnId
    ? feed.filter((existing) => !(existing.provisional === true && existing.turnId === turnId))
    : [...feed];
  return [...withoutPrior, line].slice(-limit);
}

export function clearProvisionalChatLines(feed: readonly ChatLine[], turnId: string): { feed: ChatLine[]; removed: boolean } {
  const next = feed.filter((line) => !(line.provisional === true && line.turnId === turnId));
  return { feed: next, removed: next.length !== feed.length };
}
