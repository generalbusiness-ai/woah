import { describe, expect, it, vi } from "vitest";
import { generateHoroscope, HOROSCOPE_MODEL, type HoroscopeAi } from "../src/horoscope";

describe("generateHoroscope", () => {
  it("calls the small instruction-tuned model with system+user messages", async () => {
    const run = vi.fn().mockResolvedValue({ response: "  The stars are unusually pushy today.  " });
    const ai: HoroscopeAi = { run };

    const result = await generateHoroscope(ai, {
      systemPrompt: "you are a snarky oracle",
      request: "scorpio"
    });

    expect(result).toBe("The stars are unusually pushy today.");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(HOROSCOPE_MODEL, {
      messages: [
        { role: "system", content: "you are a snarky oracle" },
        { role: "user", content: "scorpio" }
      ],
      max_tokens: 350
    });
  });

  it("falls back to a default system prompt and request when both are blank", async () => {
    const run = vi.fn().mockResolvedValue({ response: "ok" });
    await generateHoroscope({ run }, { systemPrompt: "   ", request: "" });
    const args = run.mock.calls[0][1];
    expect(args.messages[0].content).toMatch(/horoscope/i);
    expect(args.messages[1].content.length).toBeGreaterThan(0);
  });

  it("respects a per-call max_tokens override", async () => {
    const run = vi.fn().mockResolvedValue({ response: "x" });
    await generateHoroscope({ run }, { systemPrompt: "p", request: "r", maxTokens: 64 });
    expect(run.mock.calls[0][1].max_tokens).toBe(64);
  });

  it("throws on empty model response", async () => {
    const run = vi.fn().mockResolvedValue({ response: "   " });
    await expect(generateHoroscope({ run }, { systemPrompt: "p", request: "r" })).rejects.toThrow(/empty/);
  });
});
