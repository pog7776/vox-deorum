/**
 * @module leaders/staged-decision
 *
 * Staging area for one leader decision. While the leader's model loop runs, its action tools
 * only record proposals here; nothing reaches the game. After the loop, the leader strategist
 * reads the validated plan and applies it through the real Vox Deorum action tools while the
 * seat is still paused. Once closed (finished, timed out or cancelled) a decision rejects any
 * further staging, so late tool calls from an abandoned model run cannot change anything.
 *
 * Phase 1 supports Flavor-mode actions only: flavors/grand strategy, research, policy and
 * status quo. Persona and relationship changes are additive and wait for the Phase 2 ledger.
 */

import { randomUUID } from "node:crypto";

/** Kinds of game action a leader can stage. */
export type StagedActionKind = "flavors" | "research" | "policy" | "status-quo";

/** Upstream MCP tool that applies each kind. */
export const upstreamToolFor: Record<StagedActionKind, string> = {
  "flavors": "set-flavors",
  "research": "set-research",
  "policy": "set-policy",
  "status-quo": "keep-status-quo"
};

/** Order in which staged actions are applied. */
const applyOrder: StagedActionKind[] = ["status-quo", "flavors", "research", "policy"];

/** One staged action. `args` never contains PlayerID; the strategist injects the seat's ID. */
export interface StagedAction {
  actionId: string;
  kind: StagedActionKind;
  args: Record<string, unknown>;
  rationale: string;
  stagedAt: string;
}

/** Completion record submitted by `finish-leader-decision`. */
export interface DecisionCompletion {
  summary: string;
  goalReview: string;
  unresolved?: string;
}

/** Lifecycle of a staged decision. */
export type StagedDecisionState = "open" | "finished" | "closed";

/** Thrown when a staging request is refused; the message is returned to the model. */
export class StagingError extends Error {}

/**
 * One decision's staged actions and completion record. Later staging of the same kind replaces
 * the earlier proposal, matching how repeated upstream calls override each other.
 */
export class StagedDecision {
  public readonly decisionId: string;
  private readonly actions = new Map<StagedActionKind, StagedAction>();
  private completion?: DecisionCompletion;
  private _state: StagedDecisionState = "open";

  /** Create an open decision for one seat and turn. */
  constructor(public readonly playerID: number, public readonly turn: number, decisionId: string = randomUUID()) {
    this.decisionId = decisionId;
  }

  /** Current lifecycle state. */
  public get state(): StagedDecisionState {
    return this._state;
  }

  /**
   * Stage one action, replacing any earlier proposal of the same kind. Status quo cannot be
   * combined with a flavor change. Returns the staged action, which callers report as staged,
   * never as executed.
   */
  public stage(kind: StagedActionKind, args: Record<string, unknown>, rationale: string): StagedAction {
    this.assertOpen();
    const text = rationale.trim();
    if (!text) throw new StagingError("A rationale is required.");
    if ("PlayerID" in args) throw new StagingError("Do not supply PlayerID; your seat is fixed.");
    if (kind === "status-quo" && this.actions.has("flavors")) {
      throw new StagingError("A flavor change is already staged. Keep the status quo or change flavors, not both.");
    }
    if (kind === "flavors" && this.actions.has("status-quo")) {
      throw new StagingError("Status quo is already staged. Keep the status quo or change flavors, not both.");
    }
    const action: StagedAction = {
      actionId: randomUUID(),
      kind,
      args: { ...args },
      rationale: text,
      stagedAt: new Date().toISOString()
    };
    this.actions.set(kind, action);
    return action;
  }

  /** Record the completion and stop accepting further actions. */
  public finish(completion: DecisionCompletion): void {
    this.assertOpen();
    if (!completion.summary.trim()) throw new StagingError("A decision summary is required.");
    if (!completion.goalReview.trim()) throw new StagingError("A goal review is required, even if nothing changed.");
    this.completion = { ...completion };
    this._state = "finished";
  }

  /** Close the decision; any later staging or finishing is refused. */
  public close(): void {
    if (this._state === "open") this._state = "closed";
    else if (this._state === "finished") this._state = "closed";
  }

  /** Whether the leader submitted a completion record before the decision closed. */
  public get isFinished(): boolean {
    return this.completion !== undefined;
  }

  /** The completion record, if submitted. */
  public get completionRecord(): DecisionCompletion | undefined {
    return this.completion ? { ...this.completion } : undefined;
  }

  /** Staged actions in apply order. */
  public plan(): StagedAction[] {
    return applyOrder.flatMap(kind => {
      const action = this.actions.get(kind);
      return action ? [{ ...action, args: { ...action.args } }] : [];
    });
  }

  /** Throw when the decision no longer accepts changes. */
  private assertOpen(): void {
    if (this._state !== "open") {
      throw new StagingError(`Decision ${this.decisionId} is ${this._state}; no further changes are accepted.`);
    }
  }
}

/**
 * Open decisions by seat context ID. One seat has at most one open decision; opening a new one
 * closes the previous so a stale run can never stage into the current decision.
 */
export class StagedDecisionRegistry {
  private readonly open = new Map<string, StagedDecision>();

  /** Open a decision for a seat, closing any decision the seat still had open. */
  public begin(seatKey: string, playerID: number, turn: number, decisionId?: string): StagedDecision {
    this.open.get(seatKey)?.close();
    const decision = new StagedDecision(playerID, turn, decisionId);
    this.open.set(seatKey, decision);
    return decision;
  }

  /** The seat's current decision, if one is open or finished but not yet released. */
  public current(seatKey: string): StagedDecision | undefined {
    return this.open.get(seatKey);
  }

  /** Close and forget a seat's decision, if it is the one given. */
  public release(seatKey: string, decision: StagedDecision): void {
    decision.close();
    if (this.open.get(seatKey) === decision) this.open.delete(seatKey);
  }
}

/** Process-wide registry used by the leader agents. */
export const stagedDecisions = new StagedDecisionRegistry();
