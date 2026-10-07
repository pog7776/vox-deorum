/**
 * Tests for CivAI's diplomat follow-up: after a negotiator handoff the diplomat gets one more
 * step, limited to send-message or end-turn, with a note saying the counterpart only saw the
 * deal card. Seen live on 2026-10-08: Assyria withdrew a Salt offer through its negotiator and
 * never answered the question the human had asked.
 */

import { describe, expect, it } from "vitest";
import { agentRegistry } from "../../../src/infra/agent-registry.js";
import { followUpPrompt, needsNegotiatorFollowUp } from "../../../src/civai/diplomat-follow-up.js";
import type { EnvoyThread } from "../../../src/types/index.js";
import { createFakeVoxContext, makeStrategistParameters } from "../../helpers/fake-vox-context.js";

const diplomat = agentRegistry.get("diplomat") as any;

/** A diplomacy thread voiced by Assyria (player 1) with Polynesia (player 0). */
function thread(): EnvoyThread {
  return {
    id: "dipl:g:0:1",
    agent: 1,
    gameID: "g",
    player1ID: 0,
    player2ID: 1,
    player1Role: "the leader",
    player2Role: "diplomat",
    player1Identity: { name: "Polynesia", leader: "Kamehameha" },
    player2Identity: { name: "Assyria", leader: "Ashurbanipal" },
    contextType: "live",
    contextId: "g-player-1",
    messages: [],
    diplomacy: true,
  };
}

/** A step that called the named tools. */
function step(...toolNames: string[]) {
  return {
    text: "",
    toolCalls: toolNames.map(toolName => ({ toolName })),
    toolResults: [],
    response: { messages: [{ role: "assistant", content: "" }] },
  } as any;
}

const parameters = makeStrategistParameters({ turn: 60 });

describe("needsNegotiatorFollowUp", () => {
  it("is needed after a handoff until the diplomat speaks, stays silent or closes", () => {
    expect(needsNegotiatorFollowUp([step("get-briefing")])).toBe(false);
    expect(needsNegotiatorFollowUp([step("call-negotiator")])).toBe(true);
    expect(needsNegotiatorFollowUp([step("call-negotiator"), step("send-message")])).toBe(false);
    expect(needsNegotiatorFollowUp([step("call-negotiator"), step("end-turn")])).toBe(false);
    expect(needsNegotiatorFollowUp([step("send-message", "call-negotiator")])).toBe(false);
    expect(needsNegotiatorFollowUp([step("call-negotiator", "close-conversation")])).toBe(false);
  });

  it("ignores a malformed handoff that never ran", () => {
    expect(needsNegotiatorFollowUp([{ ...step(), toolCalls: [{ toolName: "call-negotiator", invalid: true }] }])).toBe(false);
  });
});

describe("Diplomat follow-up step", () => {
  it("keeps the turn open after a negotiator handoff and ends it after the follow-up", () => {
    const input = thread();
    const context = createFakeVoxContext("g-player-1").asContext();
    const handoff = step("call-negotiator");
    expect(diplomat.stopCheck(parameters, input, handoff, [handoff], context)).toBe(false);
    const reply = step("send-message");
    expect(diplomat.stopCheck(parameters, input, reply, [handoff, reply], context)).toBe(true);
    const silent = step("end-turn");
    expect(diplomat.stopCheck(parameters, input, silent, [handoff, silent], context)).toBe(true);
  });

  it("still stops at the step ceiling", () => {
    const context = createFakeVoxContext("g-player-1").asContext();
    const steps = [...Array.from({ length: 9 }, () => step("get-briefing")), step("call-negotiator")];
    expect(diplomat.stopCheck(parameters, thread(), steps[9], steps, context)).toBe(true);
  });

  it("limits the follow-up to send-message and end-turn, with the note appended", async () => {
    const context = createFakeVoxContext("g-player-1").asContext();
    const handoff = step("call-negotiator");
    const messages = [{ role: "user", content: "earlier" }];
    const config = await diplomat.prepareStep(parameters, thread(), handoff, [handoff], messages, context);
    expect(config.activeTools).toEqual(["send-message", "end-turn"]);
    expect(config.messages.at(-1)).toEqual({ role: "user", content: followUpPrompt });
    expect(config.messages[0]).toEqual(messages[0]);
  });

  it("hides end-turn on ordinary steps", async () => {
    const context = createFakeVoxContext("g-player-1").asContext();
    const config = await diplomat.prepareStep(parameters, thread(), null, [], [], context);
    expect(config.activeTools).toContain("send-message");
    expect(config.activeTools).toContain("call-negotiator");
    expect(config.activeTools).not.toContain("end-turn");
  });
});
