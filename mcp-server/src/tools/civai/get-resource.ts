/**
 * Tool for looking up resources (Iron, Horses, Wine...) in the active mod's rules:
 * class, reveal tech, yields, the improvement that harvests them, what consumes them,
 * the Vox Populi help text (monopoly bonuses etc.), and a short Civilopedia entry.
 */

import { sql } from "kysely";
import * as z from "zod";
import { gameDatabase } from "../../server.js";
import { DatabaseQueryTool } from "../abstract/database-query.js";
import { localText, pediaMaxChars, rows, typeLabel, yieldMap } from "./rules-text.js";

/**
 * Player-facing class for a resource class key. The game splits strategic resources into
 * "rush" (early) and "modern" classes; players know both as strategic.
 * @param classType - ResourceClassType such as RESOURCECLASS_RUSH
 */
export function resourceClass(classType: string | null | undefined): string {
  if (classType === "RESOURCECLASS_RUSH" || classType === "RESOURCECLASS_MODERN") return "Strategic";
  return typeLabel(classType) || "Unknown";
}

/**
 * Schema for resource summary information
 */
const ResourceSummarySchema = z.object({
  Type: z.string(),
  Name: z.string(),
  Class: z.string(),
  Help: z.string().optional(),
  RevealedBy: z.string().optional()
});

/**
 * Schema for full resource information
 */
const ResourceReportSchema = ResourceSummarySchema.extend({
  TradeableWith: z.string().optional(),
  ObsoleteWith: z.string().optional(),
  Happiness: z.number().optional(),
  Yields: z.record(z.string(), z.number()).optional(),
  HarvestedBy: z.array(z.string()).optional(),
  UnitsRequiring: z.record(z.string(), z.number()).optional(),
  BuildingsRequiring: z.record(z.string(), z.number()).optional(),
  Civilopedia: z.string().optional()
});

type ResourceSummary = z.infer<typeof ResourceSummarySchema>;
type ResourceReport = z.infer<typeof ResourceReportSchema>;

/**
 * Tool for querying resource rules from the game database
 */
class GetResourceTool extends DatabaseQueryTool<ResourceSummary, ResourceReport> {
  /**
   * Unique identifier for the tool
   */
  readonly name = "get-resource";

  /**
   * Human-readable description of the tool
   */
  readonly description = "Looks up resources (strategic, luxury, bonus) in the active mod's rules: what reveals them, yields, the improvement that harvests them, " +
    "which units and buildings need them, mod-specific bonuses such as monopolies, and a short Civilopedia entry. Search by name; one match returns full details.";

  /**
   * Schema for resource summary
   */
  protected readonly summarySchema = ResourceSummarySchema;

  /**
   * Schema for full resource information
   */
  protected readonly fullSchema = ResourceReportSchema;

  /**
   * Fetch resource summaries from the database
   */
  protected async fetchSummaries(): Promise<ResourceSummary[]> {
    const list = await rows<{ Type: string; Name: string; Class: string | null; Help: string | null; RevealedBy: string | null }>(sql`
      select r.Type, r.Description as Name, r.ResourceClassType as Class, r.Help, t.Description as RevealedBy
      from Resources r left join Technologies t on t.Type = r.TechReveal
      where r.Description is not null`);
    return list.map(r => ({
      Type: r.Type,
      Name: r.Name,
      Class: resourceClass(r.Class),
      Help: r.Help ?? undefined,
      RevealedBy: r.RevealedBy ?? undefined
    }));
  }

  /**
   * Fetch full resource information
   */
  protected fetchFullInfo = getResource;
}

/**
 * Fetch full information for one resource
 * @param resourceType - Resource type key, e.g. RESOURCE_IRON
 */
export async function getResource(resourceType: string): Promise<ResourceReport> {
  const [resource] = await rows<{
    Type: string; Name: string; Class: string | null; Help: string | null; Civilopedia: string | null; Happiness: number | null;
    RevealedBy: string | null; TradeableWith: string | null; ObsoleteWith: string | null;
  }>(sql`
    select r.Type, r.Description as Name, r.ResourceClassType as Class, r.Help, r.Civilopedia, r.Happiness,
      reveal.Description as RevealedBy, trade.Description as TradeableWith, obsolete.Description as ObsoleteWith
    from Resources r
      left join Technologies reveal on reveal.Type = r.TechReveal
      left join Technologies trade on trade.Type = r.TechCityTrade
      left join Technologies obsolete on obsolete.Type = r.TechObsolete
    where r.Type = ${resourceType}`);
  if (!resource) throw new Error(`Resource ${resourceType} not found`);

  const yields = await rows<{ YieldType: string | null; Yield: number | null }>(sql`
    select YieldType, Yield from Resource_YieldChanges where ResourceType = ${resourceType}`);
  const harvesters = await rows<{ Name: string }>(sql`
    select distinct i.Description as Name from Improvement_ResourceTypes irt
      join Improvements i on i.Type = irt.ImprovementType
    where irt.ResourceType = ${resourceType} and i.Description is not null`);
  const units = await rows<{ Name: string; Cost: number | null }>(sql`
    select u.Description as Name, q.Cost from Unit_ResourceQuantityRequirements q
      join Units u on u.Type = q.UnitType
    where q.ResourceType = ${resourceType} and u.ShowInPedia = 1`);
  const buildings = await rows<{ Name: string; Cost: number | null }>(sql`
    select b.Description as Name, q.Cost from Building_ResourceQuantityRequirements q
      join Buildings b on b.Type = q.BuildingType
    where q.ResourceType = ${resourceType}`);

  const amounts = async (list: { Name: string; Cost: number | null }[]): Promise<Record<string, number> | undefined> => {
    if (!list.length) return undefined;
    const result: Record<string, number> = {};
    for (const row of list) result[await gameDatabase.localize(row.Name)] = row.Cost ?? 1;
    return result;
  };

  return {
    Type: resource.Type,
    Name: resource.Name,
    Class: resourceClass(resource.Class),
    Help: resource.Help ?? undefined,
    RevealedBy: resource.RevealedBy ?? undefined,
    TradeableWith: resource.TradeableWith ?? undefined,
    ObsoleteWith: resource.ObsoleteWith ?? undefined,
    Happiness: resource.Happiness || undefined,
    Yields: yieldMap(yields),
    HarvestedBy: harvesters.length ? harvesters.map(h => h.Name) : undefined,
    UnitsRequiring: await amounts(units),
    BuildingsRequiring: await amounts(buildings),
    Civilopedia: await localText(resource.Civilopedia, pediaMaxChars)
  };
}

/**
 * Creates a new instance of the get-resource tool
 */
export default function createGetResourceTool(): GetResourceTool {
  return new GetResourceTool();
}
