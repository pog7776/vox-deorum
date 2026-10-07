/**
 * @module civai/lookup-tools
 *
 * CivAI's optional read-only lookup tools for strategists, leaders and diplomats: the map tool,
 * the rules/Civilopedia tools, and history (the civ's own past in this game and Civilopedia lore). Each seat can switch the groups off and cap how many lookups one
 * decision may make, to keep model cost down. Once a decision reaches its cap, the lookup
 * tools are withdrawn for the rest of that run and the model has to decide.
 *
 * Seat config: `llmPlayers.<id>.civaiTools = { "map": true, "rules": true, "history": true, "maxLookups": 3 }`.
 */

import type { StepResult, Tool } from "ai";

/** Per-seat switches for CivAI's lookup tools. Everything is on by default. */
export interface CivaiToolSettings {
  /** Offer `get-map-area` (terrain around a plot, within the seat's fog of war). */
  map?: boolean;
  /** Offer the rules and Civilopedia lookups (technologies, units, resources, concepts...). */
  rules?: boolean;
  /** Offer `get-history` (this civ's past decisions and events) and `get-lore` (Civilopedia history). */
  history?: boolean;
  /** Most lookup calls one decision may make before the tools are withdrawn (0 disables them). */
  maxLookups?: number;
}

/** Lookup tools by group. All are read-only; the map tool is player-scoped through autoComplete. */
export const civaiToolGroups = {
  map: ["get-map-area"],
  rules: ["get-technology", "get-unit", "get-building", "get-policy", "get-resource", "get-improvement", "get-promotion", "get-concept"],
  history: ["get-history", "get-lore"]
} as const;

/** A lookup tool group name. */
export type CivaiToolGroup = keyof typeof civaiToolGroups;

/** Every lookup tool name, for counting calls. */
export const allLookupTools: readonly string[] = [...civaiToolGroups.map, ...civaiToolGroups.rules, ...civaiToolGroups.history];

/** Default number of lookups per decision. */
export const defaultMaxLookups = 3;

/** Hard ceiling on maxLookups, whatever the config says. */
export const maxLookupsCeiling = 10;

/**
 * Resolves a seat's settings into the lookup tools to declare and the per-decision cap.
 * @param settings - The seat's `civaiTools` setting, if any
 * @param groups - Which groups this agent may use (default: all)
 * @returns Tool names to offer (empty when disabled) and the lookup cap
 */
export function resolveCivaiTools(
  settings?: CivaiToolSettings,
  groups: readonly CivaiToolGroup[] = ["map", "rules", "history"]
): { tools: string[]; maxLookups: number } {
  const raw = settings?.maxLookups;
  const maxLookups = typeof raw === "number" && Number.isFinite(raw)
    ? Math.max(0, Math.min(maxLookupsCeiling, Math.floor(raw)))
    : defaultMaxLookups;
  if (maxLookups === 0) return { tools: [], maxLookups };
  const tools: string[] = [];
  for (const group of groups) {
    if (settings?.[group] !== false) tools.push(...civaiToolGroups[group]);
  }
  return { tools, maxLookups };
}

/**
 * Counts lookup tool calls made so far in a run.
 * @param allSteps - Steps executed so far
 */
export function countLookups(allSteps: StepResult<Record<string, Tool>>[]): number {
  let count = 0;
  for (const step of allSteps) {
    for (const call of step.toolCalls ?? []) {
      if (allLookupTools.includes(call.toolName)) count++;
    }
  }
  return count;
}

/**
 * Withdraws the lookup tools once a run has used its lookup budget.
 * @param activeTools - Tools the next step would otherwise allow
 * @param allSteps - Steps executed so far
 * @param settings - The seat's `civaiTools` setting
 * @returns The allowed tools, or undefined to leave the step's tools unchanged
 */
export function limitLookups(
  activeTools: string[] | undefined,
  allSteps: StepResult<Record<string, Tool>>[],
  settings?: CivaiToolSettings
): string[] | undefined {
  if (!activeTools) return undefined;
  const { maxLookups } = resolveCivaiTools(settings);
  if (countLookups(allSteps) < maxLookups) return undefined;
  return activeTools.filter(name => !allLookupTools.includes(name));
}

/** Prompt guidance shared by strategists and leaders; it only applies when lookups are offered. */
export const lookupToolsPrompt = `- If lookup tools are available, use them only when they would change your decision, and batch them in one step:
  - \`get-map-area\` shows terrain, resources, encampments and units around a coordinate from your reports (e.g. a city's X/Y), within what your civilization has explored.
  - \`get-concept\`, \`get-resource\`, \`get-improvement\`, \`get-promotion\`, \`get-technology\`, \`get-unit\`, \`get-building\` and \`get-policy\` give this game's actual rules (the Vox Populi mod changes many base-game mechanics) and short Civilopedia entries.
  - \`get-history\` recalls your own past decisions (with the reasons you gave) and the notable events you saw this game; \`get-lore\` gives real-world Civilopedia history.
  - Lookups are limited per decision; once they're used up, decide with what you have.`;

/**
 * Diplomat guidance for the history tools, or an empty string when they're switched off.
 * @param settings - The seat's `civaiTools` setting
 */
export function diplomatHistoryPrompt(settings?: CivaiToolSettings): string {
  if (resolveCivaiTools(settings, ["history"]).tools.length === 0) return "";
  return `
- Use the \`get-history\` tool to recall your civilization's past in this game: decisions your leader made (and why) and notable events.
  - Call it when asked about your past, your motives, or earlier events; speak from what it returns rather than inventing history.
- Use the \`get-lore\` tool for your civilization's or leader's real-world history (an outline first, then one section at a time).
  - Use it when the conversation turns to your heritage or ancestors; keep the retelling brief and in character.`;
}
