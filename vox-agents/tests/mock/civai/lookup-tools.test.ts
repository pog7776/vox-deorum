// Load the registry first, as upstream tests do, so agent classes resolve in dependency order.
import "../../../src/infra/agent-registry.js";
import { describe, expect, it } from "vitest";
import type { StepResult, Tool } from "ai";
import {
  allLookupTools, civaiToolGroups, countLookups, defaultMaxLookups, limitLookups, maxLookupsCeiling, resolveCivaiTools
} from "../../../src/civai/lookup-tools.js";
import { SimpleStrategist } from "../../../src/strategist/agents/simple-strategist.js";
import { LeaderDecider } from "../../../src/leaders/leader-decider.js";
import { Diplomat } from "../../../src/envoy/agents/diplomat.js";
import { createFakeVoxContext, makeStrategistParameters } from "../../helpers/fake-vox-context.js";

/** A finished step that called the named tools. */
function step(...toolNames: string[]): StepResult<Record<string, Tool>> {
  return {
    toolCalls: toolNames.map((toolName, i) => ({ type: "tool-call", toolCallId: `c${i}`, toolName, input: {} })),
    toolResults: [],
    text: "",
    response: { messages: [] }
  } as unknown as StepResult<Record<string, Tool>>;
}

describe("resolveCivaiTools", () => {
  it("offers every lookup tool with the default cap when unset", () => {
    expect(resolveCivaiTools()).toEqual({ tools: [...allLookupTools], maxLookups: defaultMaxLookups });
  });

  it("switches groups off independently", () => {
    expect(resolveCivaiTools({ map: false }).tools).toEqual([...civaiToolGroups.rules, ...civaiToolGroups.history]);
    expect(resolveCivaiTools({ rules: false, history: false }).tools).toEqual([...civaiToolGroups.map]);
    expect(resolveCivaiTools({ map: false, rules: false, history: false }).tools).toEqual([]);
  });

  it("limits an agent to the groups it may use", () => {
    expect(resolveCivaiTools(undefined, ["history"]).tools).toEqual(["get-history", "get-lore"]);
    expect(resolveCivaiTools({ history: false }, ["history"]).tools).toEqual([]);
  });

  it("treats maxLookups 0 as off and clamps bad values", () => {
    expect(resolveCivaiTools({ maxLookups: 0 })).toEqual({ tools: [], maxLookups: 0 });
    expect(resolveCivaiTools({ maxLookups: -4 }).tools).toEqual([]);
    expect(resolveCivaiTools({ maxLookups: 99 }).maxLookups).toBe(maxLookupsCeiling);
    expect(resolveCivaiTools({ maxLookups: 2.7 }).maxLookups).toBe(2);
    expect(resolveCivaiTools({ maxLookups: Number.NaN }).maxLookups).toBe(defaultMaxLookups);
  });
});

describe("lookup budget", () => {
  const tools = ["set-flavors", "keep-status-quo", "get-map-area", "get-resource"];

  it("counts only lookup calls", () => {
    expect(countLookups([step("get-map-area", "set-flavors"), step("get-concept", "get-unit")])).toBe(3);
  });

  it("leaves tools alone under the cap and withdraws lookups at the cap", () => {
    expect(limitLookups(tools, [step("get-map-area")], { maxLookups: 2 })).toBeUndefined();
    expect(limitLookups(tools, [step("get-map-area"), step("get-resource")], { maxLookups: 2 })).toEqual(["set-flavors", "keep-status-quo"]);
  });
});

describe("strategists honour the seat's civaiTools", () => {
  it("simple-strategist declares only enabled lookups", () => {
    const strategist = new SimpleStrategist();
    const declared = strategist.getActiveTools(makeStrategistParameters({ civaiTools: { rules: false } }))!;
    expect(declared).toContain("get-map-area");
    expect(declared).not.toContain("get-resource");
    expect(strategist.getActiveTools(makeStrategistParameters({ civaiTools: { maxLookups: 0 } }))!.filter(name => allLookupTools.includes(name))).toEqual([]);
  });

  it("simple-strategist withdraws lookups once the cap is used", async () => {
    const strategist = new SimpleStrategist();
    const ctx = createFakeVoxContext("game-player-1").asContext();
    const params = makeStrategistParameters({ civaiTools: { maxLookups: 1 } });
    const fresh = await strategist.prepareStep(params, undefined, null, [], [], ctx);
    expect((fresh.activeTools ?? []).some(name => allLookupTools.includes(name)) || fresh.activeTools === undefined).toBe(true);
    const spent = await strategist.prepareStep(params, undefined, step("get-map-area"), [step("get-map-area")], [], ctx);
    expect(spent.activeTools).toBeDefined();
    expect(spent.activeTools!.some(name => allLookupTools.includes(name))).toBe(false);
    expect(spent.activeTools).toContain("keep-status-quo");
  });

  it("leader-decider applies the same switches and cap", async () => {
    const decider = new LeaderDecider();
    const ctx = createFakeVoxContext("game-player-2").asContext();
    const params = makeStrategistParameters({ civaiTools: { map: false, maxLookups: 1 } });
    expect(decider.getActiveTools(params)).not.toContain("get-map-area");
    expect(decider.getActiveTools(params)).toContain("get-concept");
    const input = { soul: "# Identity", decisionId: "d1" };
    const spent = await decider.prepareStep(params, input, step("get-concept"), [step("get-concept")], [], ctx);
    expect(spent.activeTools!.some(name => allLookupTools.includes(name))).toBe(false);
    expect(spent.activeTools).toContain("finish-leader-decision");
  });
});

describe("diplomat history lookups", () => {
  it("offers only the history group, and nothing when it's switched off", () => {
    const diplomat = new Diplomat();
    const tools = diplomat.getActiveTools(makeStrategistParameters())!;
    expect(tools).toEqual(expect.arrayContaining(["get-history", "get-lore", "send-message"]));
    expect(tools).not.toContain("get-map-area");
    expect(diplomat.getActiveTools(makeStrategistParameters({ civaiTools: { history: false } }))).not.toContain("get-history");
  });

  it("withdraws history lookups at the cap but keeps send-message", async () => {
    const diplomat = new Diplomat();
    const ctx = createFakeVoxContext("game-player-1").asContext();
    const params = makeStrategistParameters({ civaiTools: { maxLookups: 1 } });
    const thread = { id: "t", agent: 1, messages: [], participants: [] } as never;
    const spent = await diplomat.prepareStep(params, thread, step("get-history"), [step("get-history")], [], ctx);
    expect(spent.activeTools).toBeDefined();
    expect(spent.activeTools).not.toContain("get-history");
    expect(spent.activeTools).toContain("send-message");
  });
});
