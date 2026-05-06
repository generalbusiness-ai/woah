// Horoscope generation via Workers AI. Smallest instruction-tuned model
// (@cf/meta/llama-3.2-1b-instruct, 1B params) is enough for a one-paragraph
// reading.

export const HOROSCOPE_MODEL = "@cf/meta/llama-3.2-1b-instruct" as const;

export type HoroscopeAi = {
  run(model: string, input: { messages: Array<{ role: string; content: string }>; max_tokens?: number }): Promise<{ response?: string }>;
};

export type HoroscopeRequest = {
  systemPrompt: string;
  request: string;
  maxTokens?: number;
};

export async function generateHoroscope(ai: HoroscopeAi, req: HoroscopeRequest): Promise<string> {
  const systemPrompt = req.systemPrompt.trim() ||
    "You are a horoscope vending machine. Reply with a short, evocative reading.";
  const userRequest = req.request.trim() || "give me a horoscope";

  const result = await ai.run(HOROSCOPE_MODEL, {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userRequest }
    ],
    max_tokens: req.maxTokens ?? 350
  });

  const text = String(result?.response ?? "").trim();
  if (!text) throw new Error("model returned empty response");
  return text;
}
