/**
 * Tool for a civilization's own history in the current game: its past strategic decisions
 * (with the reasons it gave) and the notable events it saw (first contacts, cities founded,
 * buildings, barbarian camps, ruins, battles, religion). One line per entry, oldest first,
 * never past the current turn, and only events visible to that player.
 */

import { sql } from "kysely";
import * as z from "zod";
import { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { knowledgeManager } from "../../server.js";
import { ToolBase } from "../base.js";
import { MaxMajorCivs } from "../../knowledge/schema/base.js";
import { capText } from "./rules-text.js";

/** Default and maximum number of entries per call. */
export const defaultHistoryEntries = 25;
export const maxHistoryEntries = 50;

/** Characters of a decision's rationale kept per entry. */
const rationaleChars = 120;

/** One history line before formatting. */
export interface HistoryEntry {
  Turn: number;
  /** Ordering within a turn: decisions before events, then insertion order. */
  Order: number;
  Text: string;
}

/** Event types worth a line in a civilization's history. Everything else (unit moves, tile reveals...) is noise. */
const notableEvents = new Set([
  "TeamMeet", "UnitCityFounded", "CityConstructed", "BarbariansCampCleared", "GoodyHutReceivedBonus",
  "PlayerAdoptPolicy", "PlayerAdoptPolicyBranch", "TeamTechResearched", "PantheonFounded", "ReligionFounded",
  "UnitKilledInCombat", "DeclareWar", "MakePeace", "CityCaptureComplete", "IdeologyAdopted", "WonderCompleted"
]);

/** Reads a nested string field from an event payload. */
function field(payload: Record<string, unknown>, ...path: string[]): string | undefined {
  let value: unknown = payload;
  for (const key of path) {
    if (typeof value !== "object" || value === null) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

/** Names in a { Player_3: "Attila" } team map. */
function teamNames(team: unknown): string[] {
  return typeof team === "object" && team !== null ? Object.values(team as Record<string, unknown>).filter((v): v is string => typeof v === "string") : [];
}

/** Whether a { Player_3: ... } team map includes the player. */
function teamHas(team: unknown, playerID: number): boolean {
  return typeof team === "object" && team !== null && `Player_${playerID}` in (team as Record<string, unknown>);
}

/**
 * Turns one visible game event into a history line from the player's point of view.
 * @returns The line, or undefined when the event isn't notable for this player
 */
export function formatHistoryEvent(type: string, payload: Record<string, unknown>, playerID: number): string | undefined {
  const own = (key = "PlayerID"): boolean => Number(payload[key]) === playerID;
  const civ = (key: string): string | undefined => field(payload, key, "Civilization") ?? field(payload, key, "Name");
  const at = (): string => payload.PlotX !== undefined ? ` at (${payload.PlotX},${payload.PlotY})` : "";
  switch (type) {
    case "TeamMeet": {
      const mine = teamHas(payload.CurrentTeam, playerID) ? payload.OtherTeam : teamHas(payload.OtherTeam, playerID) ? payload.CurrentTeam : undefined;
      if (mine === undefined) return undefined;
      const names = teamNames(mine);
      return names.length ? `Met ${names.join(", ")}` : "Met a city-state";
    }
    case "UnitCityFounded":
      return own() ? `Founded a city${at()}` : `${civ("Player") ?? "Another civilization"} founded a city${at()}`;
    case "CityConstructed":
      return own("OwnerID") ? `Built ${payload.BuildingType ?? "a building"} in ${field(payload, "City", "Name") ?? "a city"}` : undefined;
    case "BarbariansCampCleared":
      return own() ? `Cleared a barbarian encampment${at()}` : undefined;
    case "GoodyHutReceivedBonus":
      return own() ? `Explored ancient ruins${at()}: ${payload.GoodyType ?? "a reward"}` : undefined;
    case "PlayerAdoptPolicy":
      return own() ? `Adopted ${payload.PolicyID ?? "a policy"}` : undefined;
    case "PlayerAdoptPolicyBranch":
      return own() ? `Adopted the ${payload.BranchType ?? "new"} policy branch` : undefined;
    case "IdeologyAdopted":
      // Fires alongside PlayerAdoptPolicyBranch for every branch; only rivals' choices add information.
      return own() ? undefined : `${civ("Player") ?? "Another civilization"} adopted the ${payload.BranchType ?? "new"} policy branch`;
    case "TeamTechResearched":
      return teamHas(payload.Team, playerID) ? `Researched ${payload.TechID ?? "a technology"}` : undefined;
    case "PantheonFounded":
    case "ReligionFounded":
      return own()
        ? `Founded a ${type === "PantheonFounded" ? "pantheon" : "religion"}: ${capText(String(payload.BeliefType ?? payload.ReligionType ?? ""), 120)}`
        : `${civ("Player") ?? "Another civilization"} founded a ${type === "PantheonFounded" ? "pantheon" : "religion"}`;
    case "UnitKilledInCombat":
      if (Number(payload.KillerPlayerID) === playerID) return `Destroyed a ${payload.KilledUnitType ?? "unit"} of ${civ("KilledPlayer") ?? "an enemy"}`;
      if (Number(payload.KilledPlayerID) === playerID) return `Lost a ${payload.KilledUnitType ?? "unit"} to ${civ("KillerPlayer") ?? "an enemy"}`;
      return undefined;
    default: {
      // Rarer notable events: keep the type and the civilizations named in the payload.
      const names = Object.values(payload)
        .map(value => (typeof value === "object" && value !== null ? (value as Record<string, unknown>).Civilization : undefined))
        .filter((value): value is string => typeof value === "string");
      return `${type.replace(/([a-z])([A-Z])/g, "$1 $2")}${names.length ? `: ${[...new Set(names)].join(", ")}` : ""}`;
    }
  }
}

/** A decision row from one of the *Changes tables. */
interface DecisionRow {
  ID: number;
  Turn: number;
  Source: "research" | "policy" | "flavors" | "persona";
  Subject: string | null;
  Changes: string | null;
  Rationale: string | null;
}

/**
 * Turns one recorded decision into a history line.
 * @returns The line, or undefined for rows without content
 */
export function formatHistoryDecision(row: DecisionRow): string | undefined {
  const why = capText(row.Rationale ?? undefined, rationaleChars);
  const reason = why ? ` (${why})` : "";
  switch (row.Source) {
    case "research": return `Chose to research ${row.Subject}${reason}`;
    case "policy": return `Chose policy ${row.Subject}${reason}`;
    case "persona": return `Adjusted diplomatic personality${reason}`;
    case "flavors": {
      let changed: string[] = [];
      try { changed = (JSON.parse(row.Changes ?? "[]") as string[]).filter(name => name !== "Rationale"); } catch { /* keep empty */ }
      if (changed.length === 0) return why ? `Reviewed strategy, kept course: ${why}` : undefined;
      const grand = row.Subject && changed.includes("GrandStrategy") ? `grand strategy ${row.Subject}, ` : "";
      return `Changed priorities (${grand}${changed.filter(name => name !== "GrandStrategy").length} flavors)${reason}`;
    }
  }
}

/**
 * Tool returning a civilization's own history for the current game
 */
class GetHistoryTool extends ToolBase {
  /**
   * Unique identifier for the tool
   */
  readonly name = "get-history";

  /**
   * Human-readable description of the tool
   */
  readonly description = "Recalls your civilization's own history in this game: past strategic decisions with the reasons you gave, and notable events you saw " +
    "(first contacts, cities founded, buildings, barbarian camps, ruins, battles, religion). One line per entry, oldest first; the most recent entries are " +
    "returned when there are more. Narrow with FromTurn/ToTurn or Topic.";

  /**
   * Input schema
   */
  readonly inputSchema = z.object({
    PlayerID: z.number().int().min(0).max(MaxMajorCivs - 1).describe("Player whose history to recall"),
    FromTurn: z.number().int().min(0).optional().describe("First turn to include (default: start of game)"),
    ToTurn: z.number().int().min(0).optional().describe("Last turn to include (default and maximum: the current turn)"),
    Topic: z.enum(["all", "decisions", "events"]).optional().default("all").describe("Only decisions, only events, or both (default)"),
    MaxEntries: z.number().int().min(1).max(maxHistoryEntries).optional().default(defaultHistoryEntries).describe(`Most entries to return (default ${defaultHistoryEntries}, max ${maxHistoryEntries})`)
  });

  /**
   * Output schema
   */
  readonly outputSchema = z.object({
    Turns: z.string(),
    Entries: z.array(z.string()),
    EarlierEntriesNotShown: z.number().optional()
  });

  /**
   * Annotations
   */
  readonly annotations: ToolAnnotations = { readOnlyHint: true };

  /**
   * PlayerID is filled from the seat, never from the model
   */
  readonly metadata = { autoComplete: ["PlayerID"] };

  /**
   * Execute the tool
   */
  async execute(args: z.infer<typeof this.inputSchema>): Promise<z.infer<typeof this.outputSchema>> {
    const currentTurn = knowledgeManager.getTurn();
    const fromTurn = args.FromTurn ?? 0;
    const toTurn = Math.min(args.ToTurn ?? currentTurn, currentTurn);
    const topic = args.Topic ?? "all";
    const limit = Math.min(args.MaxEntries ?? defaultHistoryEntries, maxHistoryEntries);
    const entries = await collectHistory(args.PlayerID, fromTurn, toTurn, topic);
    const shown = entries.slice(-limit);
    return {
      Turns: `${fromTurn}-${toTurn}`,
      Entries: shown.map(entry => `T${entry.Turn}: ${entry.Text}`),
      ...(entries.length > shown.length ? { EarlierEntriesNotShown: entries.length - shown.length } : {})
    };
  }
}

/**
 * Collects a player's decisions and visible notable events in a turn range, oldest first.
 * @param playerID - Whose history
 * @param fromTurn - First turn
 * @param toTurn - Last turn (callers cap it at the current turn)
 * @param topic - Which kinds of entries
 */
export async function collectHistory(playerID: number, fromTurn: number, toTurn: number, topic: "all" | "decisions" | "events"): Promise<HistoryEntry[]> {
  const db = knowledgeManager.getStore().getDatabase();
  const entries: HistoryEntry[] = [];

  if (topic !== "events") {
    const decisions = await sql<DecisionRow>`
      select ID, Turn, 'research' as Source, Technology as Subject, Changes, Rationale from ResearchChanges where Key = ${playerID} and Turn between ${fromTurn} and ${toTurn}
      union all select ID, Turn, 'policy', Policy, Changes, Rationale from PolicyChanges where Key = ${playerID} and Turn between ${fromTurn} and ${toTurn}
      union all select ID, Turn, 'flavors', GrandStrategy, Changes, Rationale from FlavorChanges where Key = ${playerID} and Turn between ${fromTurn} and ${toTurn}
      union all select ID, Turn, 'persona', null, Changes, Rationale from PersonaChanges where Key = ${playerID} and Turn between ${fromTurn} and ${toTurn}
      order by Turn, ID`.execute(db);
    for (const row of decisions.rows) {
      const text = formatHistoryDecision(row);
      if (text) entries.push({ Turn: row.Turn, Order: row.ID, Text: text });
    }
  }

  if (topic !== "decisions") {
    const visible = sql.ref(`Player${playerID}`);
    const types = [...notableEvents];
    const events = await sql<{ ID: number; Turn: number; Type: string; Payload: unknown }>`
      select ID, Turn, Type, Payload from GameEvents
      where ${visible} > 0 and Turn between ${fromTurn} and ${toTurn} and Type in (${sql.join(types)})
      order by ID`.execute(db);
    for (const event of events.rows) {
      let payload: Record<string, unknown> = {};
      try {
        payload = typeof event.Payload === "string" ? JSON.parse(event.Payload) : (event.Payload as Record<string, unknown>) ?? {};
      } catch { /* malformed payload: skip details */ }
      const text = formatHistoryEvent(event.Type, payload, playerID);
      if (text) entries.push({ Turn: event.Turn, Order: 1e12 + event.ID, Text: text });
    }
  }

  return entries.sort((a, b) => a.Turn - b.Turn || a.Order - b.Order);
}

/**
 * Creates a new instance of the get-history tool
 */
export default function createGetHistoryTool(): GetHistoryTool {
  return new GetHistoryTool();
}
