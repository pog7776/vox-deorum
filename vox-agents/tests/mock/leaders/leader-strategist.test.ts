// Load the registry first, as upstream tests do, so agent classes resolve in dependency order.
import "../../../src/infra/agent-registry.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyActionResult, LeaderStrategist, runDeciderWithDeadline, type LeaderDecisionRecord, type LeaderDeciderRunner } from "../../../src/leaders/leader-strategist.js";
import { leaderSeatsEnvVar } from "../../../src/leaders/leader-seats.js";
import { stagedDecisions } from "../../../src/leaders/staged-decision.js";
import { createFakeVoxContext, makeGameState, makeStrategistParameters, type FakeVoxContext } from "../../helpers/fake-vox-context.js";

describe("LeaderStrategist", () => {
  let dir: string;
  let logPath: string;
  let ctx: FakeVoxContext;
  let strategist: LeaderStrategist;
  const previousEnv = process.env[leaderSeatsEnvVar];

  /** Parameters for player 1 on turn 5 with the game state already cached. */
  const params = () => makeStrategistParameters({ playerID: 1, turn: 5, gameStates: { 5: makeGameState(5) } });

  /** Decision log records written so far. */
  const records = (): LeaderDecisionRecord[] =>
    fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];

  /** A runner that stages into the open decision the way the decider's tools would. */
  const stagingRunner = (script: (stage: NonNullable<ReturnType<typeof stagedDecisions.current>>) => void): LeaderDeciderRunner =>
    async (context) => {
      script(stagedDecisions.current(context.id)!);
      return { status: "completed" };
    };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "civai-leader-"));
    logPath = path.join(dir, "decisions.jsonl");
    fs.writeFileSync(path.join(dir, "SOUL.md"), "# Identity\nYou are Augustus.");
    fs.writeFileSync(path.join(dir, "seats.json"), JSON.stringify({
      schemaVersion: 1,
      decisionLog: "decisions.jsonl",
      seats: { "1": { soul: "SOUL.md", leaderType: "LEADER_AUGUSTUS", decisionTimeoutMs: 10_000 } }
    }));
    process.env[leaderSeatsEnvVar] = path.join(dir, "seats.json");
    ctx = createFakeVoxContext("game-player-1");
    ctx.respondWith("set-flavors", { Changed: true, GrandStrategy: 1, Flavors: {} });
    ctx.respondWith("set-research", { Previous: 3 });
    ctx.respondWith("set-policy", { PreviousPolicy: 1 });
    ctx.respondWith("keep-status-quo", true);
    strategist = new LeaderStrategist();
  });

  afterEach(() => {
    if (previousEnv === undefined) delete process.env[leaderSeatsEnvVar];
    else process.env[leaderSeatsEnvVar] = previousEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("should apply a finished decision through upstream tools with the seat's PlayerID", async () => {
    strategist.runDecider = stagingRunner(decision => {
      decision.stage("research", { Technology: "Writing" }, "libraries soon");
      decision.stage("flavors", { GrandStrategy: "Science", Flavors: { Science: 75 } }, "go tall");
      decision.finish({ summary: "Pivot to science", goalReview: "Expand: deferred" });
    });

    const result = await strategist.getSystem(params(), undefined, ctx.asContext());

    expect(result).toBe("");
    expect(ctx.calls().map(c => c.name)).toEqual(["set-flavors", "set-research"]);
    expect(ctx.calls("set-flavors")[0].args).toEqual({ GrandStrategy: "Science", Flavors: { Science: 75 }, PlayerID: 1, Rationale: "go tall" });
    expect(ctx.calls("set-research")[0].args).toMatchObject({ Technology: "Writing", PlayerID: 1 });

    const [record] = records();
    expect(record.status).toBe("finished");
    expect(record.receipts.map(r => r.status)).toEqual(["applied", "applied"]);
    expect(record.goalReview).toBe("Expand: deferred");
    expect(record.leaderType).toBe("LEADER_AUGUSTUS");
  });

  it("should discard proposals and keep the status quo when the leader does not finish", async () => {
    strategist.runDecider = stagingRunner(decision => {
      decision.stage("flavors", { Flavors: { Offense: 90 } }, "war");
    });

    await strategist.getSystem(params(), undefined, ctx.asContext());

    expect(ctx.calls("set-flavors")).toHaveLength(0);
    expect(ctx.calls("keep-status-quo")).toHaveLength(1);
    expect(ctx.calls("keep-status-quo")[0].args).toMatchObject({ PlayerID: 1, Mode: "Flavor" });
    expect(records()[0]).toMatchObject({ status: "unfinished", receipts: [] });
  });

  it("should keep the status quo on timeout and reject late staging from the abandoned run", async () => {
    let lateResult: unknown;
    strategist.runDecider = async (context) => {
      const decision = stagedDecisions.current(context.id)!;
      // Simulate a model still running after the deadline: it tries to stage once the strategist moved on.
      setTimeout(() => {
        try {
          decision.stage("flavors", { Flavors: { Offense: 90 } }, "late");
        } catch (error) {
          lateResult = error;
        }
      }, 0);
      return { status: "timeout" };
    };

    await strategist.getSystem(params(), undefined, ctx.asContext());
    await new Promise(resolve => setTimeout(resolve, 5));

    expect(ctx.calls("set-flavors")).toHaveLength(0);
    expect(ctx.calls("keep-status-quo")).toHaveLength(1);
    expect(lateResult).toBeInstanceOf(Error);
    expect(records()[0].status).toBe("timeout");
    expect(stagedDecisions.current(ctx.id)).toBeUndefined();
  });

  it("should record a rejected research choice without blocking the rest of the plan", async () => {
    ctx.respondWith("set-research", { Next: -1 });
    strategist.runDecider = stagingRunner(decision => {
      decision.stage("status-quo", {}, "steady");
      decision.stage("research", { Technology: "Not A Tech" }, "oops");
      decision.stage("policy", { Policy: "Tradition" }, "growth");
      decision.finish({ summary: "steady", goalReview: "unchanged" });
    });

    await strategist.getSystem(params(), undefined, ctx.asContext());

    expect(ctx.calls().map(c => c.name)).toEqual(["keep-status-quo", "set-research", "set-policy"]);
    expect(records()[0].receipts.map(r => r.status)).toEqual(["applied", "rejected", "applied"]);
  });

  it("should keep the status quo when the seat has no configuration", async () => {
    let ran = false;
    strategist.runDecider = async () => {
      ran = true;
      return { status: "completed" };
    };

    await strategist.getSystem(makeStrategistParameters({ playerID: 3, turn: 5, gameStates: { 5: makeGameState(5) } }), undefined, ctx.asContext());

    expect(ran).toBe(false);
    expect(ctx.calls("keep-status-quo")[0].args).toMatchObject({ PlayerID: 3 });
  });

  it("should keep the status quo when the SOUL has unresolved placeholders", async () => {
    fs.writeFileSync(path.join(dir, "SOUL.md"), "You are {{LEADER_NAME}}.");
    let ran = false;
    strategist.runDecider = async () => {
      ran = true;
      return { status: "completed" };
    };

    await strategist.getSystem(params(), undefined, ctx.asContext());

    expect(ran).toBe(false);
    expect(ctx.calls("keep-status-quo")).toHaveLength(1);
  });
});

describe("runDeciderWithDeadline", () => {
  it("should report completion when the decider returns in time", async () => {
    const ctx = createFakeVoxContext();
    ctx.execute.mockResolvedValue("done");
    const params = makeStrategistParameters();

    await expect(runDeciderWithDeadline(ctx.asContext(), params, { soul: "s", decisionId: "d" }, 1_000)).resolves.toEqual({ status: "completed" });
    expect(ctx.execute.mock.calls[0][0]).toBe("leader-decider");
  });

  it("should abort the run and report a timeout when the deadline passes", async () => {
    const ctx = createFakeVoxContext();
    ctx.execute.mockImplementation(() => new Promise((_, reject) => setTimeout(() => reject(new Error("aborted")), 50)));

    const result = await runDeciderWithDeadline(ctx.asContext(), makeStrategistParameters(), { soul: "s", decisionId: "d" }, 10);

    expect(result.status).toBe("timeout");
  });

  it("should report a failure without throwing", async () => {
    const ctx = createFakeVoxContext();
    ctx.execute.mockRejectedValue(new Error("provider down"));

    await expect(runDeciderWithDeadline(ctx.asContext(), makeStrategistParameters(), { soul: "s", decisionId: "d" }, 1_000))
      .resolves.toEqual({ status: "failed", error: "provider down" });
  });
});

describe("classifyActionResult", () => {
  it("should treat missing results as uncertain and validation failures as rejected", () => {
    expect(classifyActionResult(undefined)).toBe("uncertain");
    expect(classifyActionResult({ isError: true })).toBe("uncertain");
    expect(classifyActionResult(false)).toBe("rejected");
    expect(classifyActionResult({ Next: -2 })).toBe("rejected");
    expect(classifyActionResult({ Previous: 4 })).toBe("applied");
    expect(classifyActionResult(true)).toBe("applied");
  });
});
