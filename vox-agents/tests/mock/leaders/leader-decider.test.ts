// Load the registry first, as upstream tests do, so agent classes resolve in dependency order.
import "../../../src/infra/agent-registry.js";
import { afterEach, describe, expect, it } from "vitest";
import { LeaderDecider, leaderToolNames } from "../../../src/leaders/leader-decider.js";
import { stagedDecisions } from "../../../src/leaders/staged-decision.js";
import { createFakeVoxContext, makeStrategistParameters } from "../../helpers/fake-vox-context.js";

/** Invoke a tool built by the decider the way the AI SDK would. */
async function invoke(tool: unknown, input: unknown): Promise<any> {
  return (tool as { execute: (input: unknown, options: unknown) => Promise<unknown> })
    .execute(input, { toolCallId: "call-1", messages: [] });
}

describe("LeaderDecider", () => {
  const ctx = createFakeVoxContext("game-player-2");
  const decider = new LeaderDecider();
  const tools = decider.getExtraTools(ctx.asContext());

  afterEach(() => {
    const current = stagedDecisions.current(ctx.id);
    if (current) stagedDecisions.release(ctx.id, current);
  });

  it("should put the SOUL first in the system prompt", async () => {
    const system = await decider.getSystem(makeStrategistParameters(), { soul: "# Identity\nYou are Gandhi.", decisionId: "d1" }, ctx.asContext());
    expect(system.startsWith("# Identity\nYou are Gandhi.")).toBe(true);
  });

  it("should only expose its staging tools", () => {
    expect(new Set(decider.getActiveTools(makeStrategistParameters()))).toEqual(new Set(Object.values(leaderToolNames)));
    for (const name of Object.values(leaderToolNames)) expect(tools[name]).toBeDefined();
  });

  it("should stage proposals into the seat's open decision without touching the game", async () => {
    const decision = stagedDecisions.begin(ctx.id, 2, 30);

    const result = await invoke(tools[leaderToolNames.research], { Technology: "Writing", Rationale: "libraries" });

    expect(result.Status).toBe("staged");
    expect(decision.plan()).toHaveLength(1);
    expect(ctx.calls()).toHaveLength(0);
  });

  it("should report rejection when no decision is open", async () => {
    const result = await invoke(tools[leaderToolNames.statusQuo], { Rationale: "steady" });
    expect(result.Status).toBe("rejected");
  });

  it("should refuse to finish without a flavor change or status quo, then accept once one is staged", async () => {
    const decision = stagedDecisions.begin(ctx.id, 2, 30);
    await invoke(tools[leaderToolNames.research], { Technology: "Writing", Rationale: "libraries" });

    await expect(invoke(tools[leaderToolNames.finish], { Summary: "s", GoalReview: "g" })).rejects.toThrow(/flavor change|status quo/);
    expect(decision.isFinished).toBe(false);

    await invoke(tools[leaderToolNames.statusQuo], { Rationale: "steady" });
    const finished = await invoke(tools[leaderToolNames.finish], { Summary: "s", GoalReview: "g" });

    expect(finished.Status).toBe("finished");
    expect(decision.isFinished).toBe(true);
  });

  it("should reject an empty flavor proposal", async () => {
    stagedDecisions.begin(ctx.id, 2, 30);
    const result = await invoke(tools[leaderToolNames.flavors], { Rationale: "nothing" });
    expect(result.Status).toBe("rejected");
  });
});
