/**
 * @module civai/lookup-tools
 *
 * CivAI's optional read-only lookup tools for strategists and leaders: the map tool and the
 * rules/Civilopedia tools. Each seat can switch the groups off and cap how many lookups one
 * decision may make, to keep model cost down. Once a decision reaches its cap, the lookup
 * tools are withdrawn for the rest of that run and the model has to decide.
 *
 * Seat config: `llmPlayers.<id>.civaiTools = { "map": true, "rules": true, "maxLookups": 3 }`.
 */

import type { StepResult, Tool } from "ai";

/** Per-seat switches for CivAI's lookup tools. Everything is on by default. */
export interface CivaiToolSettings {
  /** Offer `get-map-area` (terrain around a plot, within the seat's fog of war). */
  map?: boolean;
  /** Offer the rules and Civilopedia lookups (technologies, units, resources, concepts...). */
  rules?: boolean;
  /** Most lookup calls one decision may make before the tools are withdrawn (0 disables them). */
  maxLookups?: number;
}

/** Lookup tools by group. All are read-only; the map tool is player-scoped through autoComplete. */
export const civaiToolGroups = {
  map: ["get-map-area"],
  rules: ["get-technology", "get-unit", "get-building", "get-policy", "get-resource", "get-improvement", "get-promotion", "get-concept"]
} as const;

/** Every lookup tool name, for counting calls. */
export const allLookupTools: readonly string[] = [...civaiToolGroups.map, ...civaiToolGroups.rules];

/** Default number of lookups per decision. */
export const defaultMaxLookups = 3;

/** Hard ceiling on maxLookups, whatever the config says. */
export const maxLookupsCeiling = 10;

/**
 * Resolves a seat's settings into the lookup tools to declare and the per-decision cap.
 * @param settings - The seat's `civaiTools` setting, if any
 * @returns Tool names to offer (empty when disabled) and the lookup cap
 */
export function resolveCivaiTools(settings?: CivaiToolSettings): { tools: string[]; maxLookups: number } {
  const raw = settings?.maxLookups;
  const maxLookups = typeof raw === "number" && Number.isFinite(raw)
    ? Math.max(0, Math.min(maxLookupsCeiling, Math.floor(raw)))
    : defaultMaxLookups;
  if (maxLookups === 0) return { tools: [], maxLookups };
  const tools: string[] = [];
  if (settings?.map !== false) tools.push(...civaiToolGroups.map);
  if (settings?.rules !== false) tools.push(...civaiToolGroups.rules);
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
  - Lookups are limited per decision; once they're used up, decide with what you have.`;
