/**
 * @module leaders/leader-strategist
 *
 * CivAI leader seat strategist. Like {@link HumanStrategist}, it does all its work inside
 * `getSystem()` while `VoxPlayer` holds this seat's pause, then returns `""` so `VoxContext`
 * skips its own model loop. The work is:
 *
 * 1. Load the seat (`CIVAI_SEATS_FILE`) and its SOUL.
 * 2. Open a staged decision and run the model-driven {@link LeaderDecider} in a child run with a
 *    wall-clock deadline. Its tools only stage proposals.
 * 3. If it finished in time, apply the staged plan through the real Vox Deorum action tools,
 *    injecting this seat's PlayerID, and record a receipt per action.
 * 4. Otherwise discard the proposals and keep the status quo, so the game never waits on a
 *    leader and no late output can reach it.
 *
 * `VoxPlayer` resumes the seat afterwards on every path, including when this method throws.
 */

import fs from "node:fs";
import path from "node:path";
import { Strategist } from "../strategist/strategist.js";
import type { VoxContext } from "../infra/vox-context.js";
import { ensureGameState, type StrategistParameters } from "../strategist/strategy-parameters.js";
import { loadLeaderSeat, readSoul, type ResolvedLeaderSeat } from "./leader-seats.js";
import { stagedDecisions, upstreamToolFor, type StagedAction, type StagedDecision } from "./staged-decision.js";
import type { LeaderDeciderInput } from "./leader-decider.js";

/** How one decision attempt ended. */
export type LeaderRunStatus = "finished" | "unfinished" | "timeout" | "failed";

/** Result of applying one staged action. `uncertain` means the game outcome is unknown. */
export interface ActionReceipt {
  actionId: string;
  kind: StagedAction["kind"];
  tool: string;
  status: "applied" | "rejected" | "uncertain";
  result?: unknown;
}

/** One line of the decision log. */
export interface LeaderDecisionRecord {
  decisionId: string;
  gameID: string;
  playerID: number;
  turn: number;
  leaderType?: string;
  status: LeaderRunStatus;
  error?: string;
  staged: StagedAction[];
  receipts: ActionReceipt[];
  fallback?: string;
  summary?: string;
  goalReview?: string;
  unresolved?: string;
  startedAt: string;
  finishedAt: string;
}

/**
 * Runs the decider for one decision. Production uses a deadline-bound child run; tests replace it.
 * Resolves with how the attempt ended; never throws for model or timeout failures.
 */
export type LeaderDeciderRunner = (
  context: VoxContext<StrategistParameters>,
  parameters: StrategistParameters,
  input: LeaderDeciderInput,
  timeoutMs: number
) => Promise<{ status: "completed" | "timeout" | "failed"; error?: string }>;

/**
 * Default runner: execute `leader-decider` inside a child run that is aborted at the deadline.
 * A child run inherits cancellation from the seat's turn run, so a session abort still stops it.
 */
export const runDeciderWithDeadline: LeaderDeciderRunner = async (context, parameters, input, timeoutMs) => {
  return await context.withRun({ parameters }, async (run) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      run.abort();
    }, timeoutMs);
    try {
      await context.execute("leader-decider", input, undefined, undefined, undefined, { throwOnError: true });
      return { status: "completed" as const };
    } catch (error) {
      if (timedOut) return { status: "timeout" as const };
      return { status: "failed" as const, error: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
    }
  });
};

/**
 * Classify an upstream action tool result. `callTool` returns undefined when the call failed or
 * the tool errored, in which case the game state is unknown. set-research and set-policy report
 * validation failures as a negative `Next`.
 */
export function classifyActionResult(result: unknown): ActionReceipt["status"] {
  if (result === undefined || result === null) return "uncertain";
  if (result === false) return "rejected";
  if (typeof result === "object") {
    const record = result as Record<string, unknown>;
    if (record.isError === true) return "uncertain";
    if (typeof record.Next === "number" && record.Next < 0) return "rejected";
  }
  return "applied";
}

/**
 * Append one record to the seat's decision log. Logging failures are reported but never block
 * the game.
 */
export function appendDecisionRecord(logPath: string | undefined, record: LeaderDecisionRecord): void {
  if (!logPath) return;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify(record) + "\n", "utf8");
}

/**
 * Seat strategist for CivAI leaders. See the module comment for the decision flow.
 */
export class LeaderStrategist extends Strategist {
  readonly name = "leader-strategist";
  readonly displayName = "CivAI Leader";
  readonly description = "A persistent leader with its own SOUL: reviews goals in character, stages strategic changes, and has them applied after validation";

  /** Replaceable for tests. */
  public runDecider: LeaderDeciderRunner = runDeciderWithDeadline;

  /**
   * Run one leader decision and return "" so the outer model loop is skipped.
   */
  public async getSystem(parameters: StrategistParameters, _input: unknown, context: VoxContext<StrategistParameters>): Promise<string> {
    const playerID = parameters.playerID ?? 0;
    const startedAt = new Date().toISOString();

    // VoxPlayer normally refreshed this already; this guarantees the report the decider reads.
    await ensureGameState(context, parameters);

    let seat: ResolvedLeaderSeat | undefined;
    let soul: string;
    try {
      seat = loadLeaderSeat(playerID);
      if (!seat) throw new Error(`No CivAI leader seat is configured for player ${playerID}.`);
      soul = readSoul(seat);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Leader seat unavailable for player ${playerID}; keeping the status quo. ${message}`);
      await this.keepStatusQuo(context, parameters, playerID, "Leader configuration unavailable; maintaining the current strategic direction.");
      return "";
    }

    if (parameters.mode !== "Flavor") {
      this.logger.error(`Leader seats support Flavor mode only; player ${playerID} is in ${parameters.mode} mode. Keeping the status quo.`);
      await this.keepStatusQuo(context, parameters, playerID, "Leader requires Flavor mode; maintaining the current strategic direction.");
      return "";
    }

    const decision = stagedDecisions.begin(context.id, playerID, parameters.turn);
    const record: LeaderDecisionRecord = {
      decisionId: decision.decisionId,
      gameID: parameters.gameID,
      playerID,
      turn: parameters.turn,
      leaderType: seat.leaderType,
      status: "failed",
      staged: [],
      receipts: [],
      startedAt,
      finishedAt: startedAt
    };

    try {
      const outcome = await this.runDecider(context, parameters, { soul, decisionId: decision.decisionId }, seat.decisionTimeoutMs);
      // Close before applying: from here on nothing the model does can change the plan.
      decision.close();
      record.staged = decision.plan();
      record.status = outcome.status === "completed"
        ? (decision.isFinished ? "finished" : "unfinished")
        : outcome.status;
      if (outcome.error) record.error = outcome.error;

      const completion = decision.completionRecord;
      if (completion) {
        record.summary = completion.summary;
        record.goalReview = completion.goalReview;
        record.unresolved = completion.unresolved;
      }

      if (record.status === "finished") {
        record.receipts = await this.applyPlan(context, parameters, playerID, decision);
      } else {
        record.fallback = this.fallbackRationale(record.status, seat.decisionTimeoutMs);
        this.logger.warn(`Leader decision ${decision.decisionId} for player ${playerID} ended ${record.status}; keeping the status quo.`, {
          GameID: parameters.gameID,
          PlayerID: playerID,
          Error: record.error
        });
        await this.keepStatusQuo(context, parameters, playerID, record.fallback);
      }
    } finally {
      stagedDecisions.release(context.id, decision);
      record.finishedAt = new Date().toISOString();
      try {
        appendDecisionRecord(seat.decisionLogPath, record);
      } catch (error) {
        this.logger.error(`Failed to write the leader decision log for player ${playerID}`, error);
      }
    }

    return "";
  }

  /**
   * Apply a finished decision's staged actions in order through the upstream action tools, with
   * this seat's PlayerID injected. Each action gets a receipt; one failure does not stop the rest.
   */
  private async applyPlan(
    context: VoxContext<StrategistParameters>,
    parameters: StrategistParameters,
    playerID: number,
    decision: StagedDecision
  ): Promise<ActionReceipt[]> {
    const receipts: ActionReceipt[] = [];
    for (const action of decision.plan()) {
      const tool = upstreamToolFor[action.kind];
      const args: Record<string, unknown> = { ...action.args, PlayerID: playerID, Rationale: action.rationale };
      if (action.kind === "status-quo") args.Mode = parameters.mode;
      const result = await context.callTool(tool, args, parameters);
      const status = classifyActionResult(result);
      receipts.push({ actionId: action.actionId, kind: action.kind, tool, status, result });
      if (status !== "applied") {
        this.logger.warn(`Leader action ${action.kind} for player ${playerID} was ${status}.`, { DecisionID: decision.decisionId, Result: result });
      }
    }
    return receipts;
  }

  /** Rationale recorded when a decision falls back to the status quo. */
  private fallbackRationale(status: LeaderRunStatus, timeoutMs: number): string {
    switch (status) {
      case "timeout": return `Leader decision exceeded ${Math.round(timeoutMs / 1000)}s; maintaining the current strategic direction.`;
      case "unfinished": return "Leader did not complete its decision; maintaining the current strategic direction.";
      default: return "Leader decision failed; maintaining the current strategic direction.";
    }
  }

  /** Keep the current settings as a recorded decision with the given rationale. */
  private async keepStatusQuo(context: VoxContext<StrategistParameters>, parameters: StrategistParameters, playerID: number, rationale: string): Promise<void> {
    await context.callTool("keep-status-quo", { PlayerID: playerID, Mode: parameters.mode, Rationale: rationale }, parameters);
  }
}
