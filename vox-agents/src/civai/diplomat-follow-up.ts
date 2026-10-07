/**
 * @module civai/diplomat-follow-up
 *
 * Upstream, a diplomat's turn ends the moment it hands a deal to the negotiator. The counterpart
 * then sees only the deal card (the negotiator's one-line message), never the reasoning, and any
 * question they asked goes unanswered. CivAI gives the diplomat one follow-up step after a
 * negotiator handoff: it sees what the negotiator did and either replies with `send-message` or
 * deliberately stays silent with `end-turn`.
 */

import type { ModelMessage, StepResult, Tool } from "ai";
import { z } from "zod";
import { getValidCalls } from "../utils/tools/terminal-tools.js";
import { createSimpleTool } from "../utils/tools/simple-tools.js";
import type { VoxContext } from "../infra/vox-context.js";
import type { StrategistParameters } from "../strategist/strategy-parameters.js";

/** Tool that ends a follow-up step without speaking. */
export const endTurnToolName = "end-turn";

/** Tools that close the diplomat's turn once the negotiator has acted. */
const followUpClosers = new Set(["send-message", endTurnToolName, "close-conversation"]);

/** Tools the diplomat may use in the follow-up step. */
export const followUpTools = ["send-message", endTurnToolName];

/**
 * Whether the diplomat handed off to the negotiator this turn and hasn't yet spoken, stayed
 * silent on purpose, or closed the conversation.
 * @param allSteps - Steps executed so far in this turn
 */
export function needsNegotiatorFollowUp(allSteps: StepResult<Record<string, Tool>>[]): boolean {
  let handedOff = false;
  for (const step of allSteps) {
    for (const call of getValidCalls(step)) {
      if (followUpClosers.has(call.toolName)) return false;
      if (call.toolName === "call-negotiator") handedOff = true;
    }
  }
  return handedOff;
}

/** The note added to the follow-up step. */
export const followUpPrompt = `Your negotiator has acted; its result is in the call-negotiator tool result above.
The counterpart only sees the deal card with the negotiator's one-line message. They did NOT see the negotiator's reasoning, and nothing has answered the rest of their last message.
- Normally, reply now with \`send-message\`: a brief, in-character answer to what they proposed or asked, and the gist of why (without private valuations or your leader's secret plans). A proposal or question deserves an answer.
- Call \`${endTurnToolName}\` only if a reply would merely repeat the deal card word for word.`;

/**
 * Adds the follow-up note to a step's messages.
 * @param messages - The messages the step would otherwise use
 */
export function withFollowUpPrompt(messages: ModelMessage[]): ModelMessage[] {
  return [...messages, { role: "user", content: followUpPrompt }];
}

/**
 * The `end-turn` tool: ends a follow-up step without saying anything more.
 * @param context - The diplomat's context
 */
export function createEndTurnTool(context: VoxContext<StrategistParameters>): Tool {
  return createSimpleTool<StrategistParameters>(
    {
      name: endTurnToolName,
      description: "End your turn without saying anything more. Only use it right after the negotiator has acted and its deal card already says enough.",
      inputSchema: z.object({}),
      execute: async () => "Turn ended without a further message."
    },
    context
  );
}
