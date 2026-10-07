/**
 * Gemini compatibility for envoys and diplomats. The diplomat ends its prompt with a system
 * hint after the chat record; the Google SDK refuses system messages after the first
 * non-system message, so every diplomat turn failed (and was retried 100 times).
 * Covers the root cause against the real Google provider (no network), the model rule that
 * demotes late system messages, and the retry policy that now stops on unsupported requests.
 */

import { describe, expect, it, vi } from "vitest";
import { createGoogle } from "@ai-sdk/google";
import { UnsupportedFunctionalityError } from "@ai-sdk/provider";
import { applyModelRules } from "../../../src/utils/models/rules.js";
import { exponentialRetry } from "../../../src/utils/retry.js";

/** A Google model whose fetch records requests instead of calling the API. */
function offlineGemini() {
  const fetch = vi.fn(async () => new Response(JSON.stringify({
    candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }
  }), { headers: { "content-type": "application/json" } }));
  const model = createGoogle({ apiKey: "test-key", fetch: fetch as unknown as typeof globalThis.fetch })("gemini-test");
  return { model, fetch };
}

/** The diplomat's prompt shape: system, chat record, then a closing system hint. */
const diplomatPrompt = [
  { role: "system" as const, content: "You are the diplomat of Assyria." },
  { role: "user" as const, content: [{ type: "text" as const, text: "Polynesia: greetings, neighbour." }] },
  { role: "assistant" as const, content: [{ type: "text" as const, text: "Assyria welcomes you." }] },
  { role: "system" as const, content: "Reply in one short paragraph." }
];

describe("Gemini and late system messages", () => {
  it("the Google SDK rejects a system message after the chat starts", async () => {
    const { model, fetch } = offlineGemini();
    await expect(model.doGenerate({ prompt: diplomatPrompt })).rejects.toSatisfy(UnsupportedFunctionalityError.isInstance);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts the same prompt once the late system message is sent as a user message", async () => {
    const { model, fetch } = offlineGemini();
    const demoted = diplomatPrompt.map((message, i) =>
      i !== 0 && message.role === "system" ? { role: "user" as const, content: [{ type: "text" as const, text: message.content }] } : message);
    await model.doGenerate({ prompt: demoted });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("Gemini and Gemma on the google provider get systemPromptFirst; Claude on Vertex doesn't", () => {
    expect(applyModelRules("google", "gemini-3.8-flash")?.systemPromptFirst).toBe(true);
    expect(applyModelRules("google", "gemma-4-31b-it")?.systemPromptFirst).toBe(true);
    expect(applyModelRules("google", "claude-sonnet-5")?.systemPromptFirst).toBeUndefined();
  });
});

describe("retry policy", () => {
  it("stops at once on a request the provider SDK can't express", async () => {
    const operation = vi.fn().mockRejectedValue(new UnsupportedFunctionalityError({ functionality: "late system messages" }));
    const logger = { warn: vi.fn() } as never;
    await expect(exponentialRetry(operation, logger, { initialDelay: 1, maxDelay: 1 })).rejects.toSatisfy(UnsupportedFunctionalityError.isInstance);
    expect(operation).toHaveBeenCalledOnce();
  });
});
