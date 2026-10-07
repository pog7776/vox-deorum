import { describe, expect, it } from "vitest";
import { StagedDecision, StagedDecisionRegistry, StagingError } from "../../../src/leaders/staged-decision.js";

describe("StagedDecision", () => {
  it("should return staged actions in apply order regardless of staging order", () => {
    const decision = new StagedDecision(2, 40);
    decision.stage("policy", { Policy: "Tradition" }, "stability");
    decision.stage("research", { Technology: "Writing" }, "science");
    decision.stage("flavors", { Flavors: { Science: 70 } }, "go tall");

    expect(decision.plan().map(a => a.kind)).toEqual(["flavors", "research", "policy"]);
  });

  it("should replace an earlier proposal of the same kind", () => {
    const decision = new StagedDecision(2, 40);
    decision.stage("research", { Technology: "Writing" }, "first");
    decision.stage("research", { Technology: "Pottery" }, "second");

    const plan = decision.plan();
    expect(plan).toHaveLength(1);
    expect(plan[0].args).toEqual({ Technology: "Pottery" });
  });

  it("should refuse to combine status quo with a flavor change in either order", () => {
    const a = new StagedDecision(2, 40);
    a.stage("flavors", { Flavors: { Science: 70 } }, "x");
    expect(() => a.stage("status-quo", {}, "y")).toThrow(StagingError);

    const b = new StagedDecision(2, 40);
    b.stage("status-quo", {}, "y");
    expect(() => b.stage("flavors", { Flavors: { Science: 70 } }, "x")).toThrow(StagingError);
  });

  it("should refuse a model-supplied PlayerID and an empty rationale", () => {
    const decision = new StagedDecision(2, 40);
    expect(() => decision.stage("research", { Technology: "Writing", PlayerID: 5 }, "x")).toThrow(StagingError);
    expect(() => decision.stage("research", { Technology: "Writing" }, "   ")).toThrow(StagingError);
    expect(decision.plan()).toHaveLength(0);
  });

  it("should reject staging after finish or close, so late output cannot change the plan", () => {
    const finished = new StagedDecision(2, 40);
    finished.stage("status-quo", {}, "hold");
    finished.finish({ summary: "hold", goalReview: "unchanged" });
    expect(() => finished.stage("research", { Technology: "Writing" }, "late")).toThrow(StagingError);
    expect(finished.isFinished).toBe(true);

    const closed = new StagedDecision(2, 40);
    closed.close();
    expect(() => closed.stage("research", { Technology: "Writing" }, "late")).toThrow(StagingError);
    expect(() => closed.finish({ summary: "s", goalReview: "g" })).toThrow(StagingError);
    expect(closed.isFinished).toBe(false);
  });

  it("should require a summary and goal review to finish", () => {
    const decision = new StagedDecision(2, 40);
    expect(() => decision.finish({ summary: "", goalReview: "g" })).toThrow(StagingError);
    expect(() => decision.finish({ summary: "s", goalReview: " " })).toThrow(StagingError);
    expect(decision.state).toBe("open");
  });

  it("should return copies so callers cannot mutate staged arguments", () => {
    const decision = new StagedDecision(2, 40);
    decision.stage("flavors", { Flavors: { Science: 70 } }, "x");
    decision.plan()[0].args.Injected = true;
    expect(decision.plan()[0].args).not.toHaveProperty("Injected");
  });
});

describe("StagedDecisionRegistry", () => {
  it("should close a seat's previous decision when a new one begins", () => {
    const registry = new StagedDecisionRegistry();
    const first = registry.begin("seat-1", 1, 10);
    const second = registry.begin("seat-1", 1, 11);

    expect(first.state).toBe("closed");
    expect(registry.current("seat-1")).toBe(second);
  });

  it("should keep seats isolated", () => {
    const registry = new StagedDecisionRegistry();
    const a = registry.begin("seat-1", 1, 10);
    const b = registry.begin("seat-2", 2, 10);
    registry.release("seat-1", a);

    expect(registry.current("seat-1")).toBeUndefined();
    expect(registry.current("seat-2")).toBe(b);
    expect(b.state).toBe("open");
  });

  it("should not forget a newer decision when an older one is released", () => {
    const registry = new StagedDecisionRegistry();
    const old = registry.begin("seat-1", 1, 10);
    const current = registry.begin("seat-1", 1, 11);
    registry.release("seat-1", old);

    expect(registry.current("seat-1")).toBe(current);
  });
});
