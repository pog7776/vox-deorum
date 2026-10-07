/**
 * @module leaders/leader-decider
 *
 * The model-driven half of a CivAI leader decision. It runs as a nested agent inside
 * {@link LeaderStrategist}: the system prompt is the seat's SOUL plus shared operating rules,
 * the opening messages are the same player-perspective game report the simple strategist reads,
 * and its only tools stage proposals into the seat's open {@link StagedDecision}. It never calls
 * a game-changing tool itself; the leader strategist applies the staged plan afterwards.
 */

import { Tool } from "ai";
import { z } from "zod";
import type { ModelMessage } from "ai";
import { VoxAgent } from "../infra/vox-agent.js";
import type { VoxContext } from "../infra/vox-context.js";
import type { StrategistParameters } from "../strategist/strategy-parameters.js";
import { SimpleStrategist } from "../strategist/agents/simple-strategist.js";
import { createSimpleTool } from "../utils/tools/simple-tools.js";
import { stagedDecisions, StagingError, type StagedActionKind } from "./staged-decision.js";

/** Input the leader strategist passes to the decider. */
export interface LeaderDeciderInput {
  /** The seat's generated SOUL text. */
  soul: string;
  /** ID of the decision the staging tools write into. */
  decisionId: string;
}

/** Names of the decider's staging tools. */
export const leaderToolNames = {
  flavors: "propose-flavors",
  research: "propose-research",
  policy: "propose-policy",
  statusQuo: "propose-status-quo",
  finish: "finish-leader-decision"
} as const;

/** Read-only MCP tools the decider may call. Each is player-scoped through autoComplete. */
export const leaderReadToolNames = ["get-map-area"] as const;

/** Shared operating rules appended to every SOUL. */
export const leaderOperatingPrompt = `
# How this decision works

- You receive a report of your civilization's situation, your current strategic settings, and the options available to you. Only use options listed in # Options.
- You steer the in-game AI. It handles units, combat and city management; you set its long-term direction.
- Your tools only PROPOSE changes. The coordinator validates and applies them after you finish. A proposal is not yet a change in the game.
- Either propose a flavor change (with an optional grand strategy) or propose keeping the status quo. Optionally also propose the next technology and the next policy.
  - Flavors range from 0 (deprioritise) to 50 (balanced) to 100 (prioritise). Too many priorities weaken each one.
  - Flavors and strategies only affect the in-game AI's NEXT choices, after existing queues.
- When geography matters (room to expand, chokepoints, coastlines, barbarian encampments, who lies between you and a rival), call \`get-map-area\` around a coordinate from your report, such as a city's X/Y. It shows only what your civilization has explored.
- Give a short rationale for each proposal, linking it to your goals and the evidence in the report.
- Finish by calling \`${leaderToolNames.finish}\` with a summary, a review of your goals (even if nothing changed), and any unresolved questions. Nothing is applied unless you finish.
- Do not invent tools or options. Do not claim an outcome you have not observed.
`.trim();

/** Shared simple strategist used only to build the standard game report messages. */
const reportBuilder = new SimpleStrategist();

/**
 * Model-driven leader decision agent. Registered so it can be executed by name, but it is not a
 * seat strategist; seats use `leader-strategist`, which wraps it.
 */
export class LeaderDecider extends VoxAgent<StrategistParameters, LeaderDeciderInput, string> {
  readonly name = "leader-decider";
  readonly description = "CivAI leader: reviews the situation in character and stages strategic proposals for the coordinator to apply";
  public completionTools: string[] = [leaderToolNames.finish];
  public maxSteps = 6;
  /** Leaders run at the default reasoning tier, like other strategists. */
  protected reasoningTier = "default" as const;

  /** System prompt: the seat's SOUL followed by the shared operating rules. */
  public async getSystem(_parameters: StrategistParameters, input: LeaderDeciderInput, _context: VoxContext<StrategistParameters>): Promise<string> {
    return `${input.soul.trim()}\n\n${leaderOperatingPrompt}`;
  }

  /** Opening messages: the same player-perspective report the simple strategist receives. */
  public async getInitialMessages(parameters: StrategistParameters, input: LeaderDeciderInput, context: VoxContext<StrategistParameters>): Promise<ModelMessage[]> {
    const messages = await reportBuilder.getInitialMessages(parameters, input, context);
    return [
      ...messages,
      {
        role: "user",
        content: `Decision ${input.decisionId}: review your goals, propose your changes, then call \`${leaderToolNames.finish}\`.`
      }
    ];
  }

  /** The decider may only use its staging tools and its audited read tools. */
  public getActiveTools(_parameters: StrategistParameters): string[] {
    return [...Object.values(leaderToolNames), ...leaderReadToolNames];
  }

  /** Staging tools bound to this seat's context. */
  public getExtraTools(context: VoxContext<StrategistParameters>): Record<string, Tool> {
    const stage = (kind: StagedActionKind, args: Record<string, unknown>, rationale: string) => {
      const decision = stagedDecisions.current(context.id);
      if (!decision) return { Status: "rejected", Reason: "No leader decision is open for this seat." };
      try {
        const action = decision.stage(kind, args, rationale);
        return { Status: "staged", ActionID: action.actionId, Note: "Proposal recorded. It is not applied until you finish and the coordinator validates it." };
      } catch (error) {
        if (error instanceof StagingError) return { Status: "rejected", Reason: error.message };
        throw error;
      }
    };

    return {
      [leaderToolNames.flavors]: createSimpleTool({
        name: leaderToolNames.flavors,
        description: "Propose new flavor values for the in-game AI, optionally with a grand strategy (long-term victory direction).",
        inputSchema: z.object({
          GrandStrategy: z.string().optional().describe("Grand strategy name from # Options"),
          Flavors: z.record(z.string(), z.number().min(0).max(100)).optional().describe("Flavor name to value (0-100) from # Options"),
          Rationale: z.string().describe("Why, linked to your goals and current evidence")
        }),
        execute: async (input) => {
          if (input.GrandStrategy === undefined && (!input.Flavors || Object.keys(input.Flavors).length === 0)) {
            return { Status: "rejected", Reason: "Provide a grand strategy, flavors, or both." };
          }
          const args: Record<string, unknown> = {};
          if (input.GrandStrategy !== undefined) args.GrandStrategy = input.GrandStrategy;
          if (input.Flavors !== undefined) args.Flavors = input.Flavors;
          return stage("flavors", args, input.Rationale);
        }
      }, context),

      [leaderToolNames.research]: createSimpleTool({
        name: leaderToolNames.research,
        description: "Propose the next technology for the in-game AI to research.",
        inputSchema: z.object({
          Technology: z.string().describe("Technology name from # Options"),
          Rationale: z.string().describe("Why, linked to your goals and current evidence")
        }),
        execute: async (input) => stage("research", { Technology: input.Technology }, input.Rationale)
      }, context),

      [leaderToolNames.policy]: createSimpleTool({
        name: leaderToolNames.policy,
        description: "Propose the next policy or policy branch for the in-game AI to adopt.",
        inputSchema: z.object({
          Policy: z.string().describe("Policy or branch name from # Options"),
          Rationale: z.string().describe("Why, linked to your goals and current evidence")
        }),
        execute: async (input) => stage("policy", { Policy: input.Policy }, input.Rationale)
      }, context),

      [leaderToolNames.statusQuo]: createSimpleTool({
        name: leaderToolNames.statusQuo,
        description: "Propose keeping the current grand strategy and flavors unchanged.",
        inputSchema: z.object({
          Rationale: z.string().describe("Why the current direction remains right")
        }),
        execute: async (input) => stage("status-quo", {}, input.Rationale)
      }, context),

      [leaderToolNames.finish]: createSimpleTool({
        name: leaderToolNames.finish,
        description: "Finish this decision. Required; nothing you proposed is applied unless you finish.",
        inputSchema: z.object({
          Summary: z.string().describe("Your chosen direction and meaningful changes, in a few sentences"),
          GoalReview: z.string().describe("Your current goals and whether each was kept, revised, completed or dropped, with reasons"),
          Unresolved: z.string().optional().describe("Open questions or uncertain outcomes to check next time")
        }),
        // A refused finish throws rather than returning a result: any successful result of a
        // completion tool ends the model loop, and a refusal must leave the leader a chance to fix it.
        execute: async (input) => {
          const decision = stagedDecisions.current(context.id);
          if (!decision) throw new StagingError("No leader decision is open for this seat.");
          if (!decision.plan().some(action => action.kind === "flavors" || action.kind === "status-quo")) {
            throw new StagingError(`Propose a flavor change (${leaderToolNames.flavors}) or the status quo (${leaderToolNames.statusQuo}) before finishing.`);
          }
          decision.finish({ summary: input.Summary, goalReview: input.GoalReview, unresolved: input.Unresolved });
          return { Status: "finished", DecisionID: decision.decisionId };
        }
      }, context)
    };
  }

  /** The decider's text output is informational only; the staged decision carries the result. */
  public async getOutput(_parameters: StrategistParameters, _input: LeaderDeciderInput, finalText: string): Promise<string | undefined> {
    return finalText || "finished";
  }
}
