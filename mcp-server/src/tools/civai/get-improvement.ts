/**
 * Tool for looking up tile improvements (Farm, Mine, Plantation, Fort...) in the active mod's
 * rules: the tech that allows building them, base yields, resources they harvest, valid
 * terrain and features, the Vox Populi help text, and a short Civilopedia entry.
 */

import { sql } from "kysely";
import * as z from "zod";
import { DatabaseQueryTool } from "../abstract/database-query.js";
import { localText, pediaMaxChars, rows, yieldMap } from "./rules-text.js";

/**
 * Schema for improvement summary information
 */
const ImprovementSummarySchema = z.object({
  Type: z.string(),
  Name: z.string(),
  Help: z.string().optional(),
  BuildTech: z.string().optional()
});

/**
 * Schema for full improvement information
 */
const ImprovementReportSchema = ImprovementSummarySchema.extend({
  UniqueTo: z.string().optional(),
  Yields: z.record(z.string(), z.number()).optional(),
  HarvestsResources: z.array(z.string()).optional(),
  ValidTerrains: z.array(z.string()).optional(),
  ValidFeatures: z.array(z.string()).optional(),
  Civilopedia: z.string().optional()
});

type ImprovementSummary = z.infer<typeof ImprovementSummarySchema>;
type ImprovementReport = z.infer<typeof ImprovementReportSchema>;

/**
 * Tool for querying improvement rules from the game database
 */
class GetImprovementTool extends DatabaseQueryTool<ImprovementSummary, ImprovementReport> {
  /**
   * Unique identifier for the tool
   */
  readonly name = "get-improvement";

  /**
   * Human-readable description of the tool
   */
  readonly description = "Looks up tile improvements (farms, mines, plantations, forts, unique improvements...) in the active mod's rules: the tech that allows them, " +
    "base yields, resources they harvest, where they can be built, mod-specific effects, and a short Civilopedia entry. Search by name; one match returns full details.";

  /**
   * Schema for improvement summary
   */
  protected readonly summarySchema = ImprovementSummarySchema;

  /**
   * Schema for full improvement information
   */
  protected readonly fullSchema = ImprovementReportSchema;

  /**
   * Fetch improvement summaries from the database (player-buildable and barbarian camps)
   */
  protected async fetchSummaries(): Promise<ImprovementSummary[]> {
    const list = await rows<{ Type: string; Name: string; Help: string | null; BuildTech: string | null }>(sql`
      select i.Type, i.Description as Name, i.Help, min(t.Description) as BuildTech
      from Improvements i
        left join Builds b on b.ImprovementType = i.Type
        left join Technologies t on t.Type = b.PrereqTech
      where i.Description is not null and i.GraphicalOnly = 0
      group by i.Type`);
    return list.map(i => ({ Type: i.Type, Name: i.Name, Help: i.Help ?? undefined, BuildTech: i.BuildTech ?? undefined }));
  }

  /**
   * Fetch full improvement information
   */
  protected fetchFullInfo = getImprovement;
}

/**
 * Fetch full information for one improvement
 * @param improvementType - Improvement type key, e.g. IMPROVEMENT_MINE
 */
export async function getImprovement(improvementType: string): Promise<ImprovementReport> {
  const [improvement] = await rows<{ Type: string; Name: string; Help: string | null; Civilopedia: string | null; UniqueTo: string | null }>(sql`
    select i.Type, i.Description as Name, i.Help, i.Civilopedia, c.ShortDescription as UniqueTo
    from Improvements i left join Civilizations c on c.Type = i.CivilizationType
    where i.Type = ${improvementType}`);
  if (!improvement) throw new Error(`Improvement ${improvementType} not found`);

  const [build] = await rows<{ BuildTech: string | null }>(sql`
    select min(t.Description) as BuildTech from Builds b join Technologies t on t.Type = b.PrereqTech
    where b.ImprovementType = ${improvementType}`);
  const yields = await rows<{ YieldType: string | null; Yield: number | null }>(sql`
    select YieldType, Yield from Improvement_Yields where ImprovementType = ${improvementType}`);
  const resources = await rows<{ Name: string }>(sql`
    select distinct r.Description as Name from Improvement_ResourceTypes irt
      join Resources r on r.Type = irt.ResourceType
    where irt.ImprovementType = ${improvementType}`);
  const terrains = await rows<{ Name: string }>(sql`
    select t.Description as Name from Improvement_ValidTerrains v join Terrains t on t.Type = v.TerrainType
    where v.ImprovementType = ${improvementType}`);
  const features = await rows<{ Name: string }>(sql`
    select f.Description as Name from Improvement_ValidFeatures v join Features f on f.Type = v.FeatureType
    where v.ImprovementType = ${improvementType}`);

  return {
    Type: improvement.Type,
    Name: improvement.Name,
    Help: improvement.Help ?? undefined,
    BuildTech: build?.BuildTech ?? undefined,
    UniqueTo: improvement.UniqueTo ?? undefined,
    Yields: yieldMap(yields),
    HarvestsResources: resources.length ? resources.map(r => r.Name) : undefined,
    ValidTerrains: terrains.length ? terrains.map(t => t.Name) : undefined,
    ValidFeatures: features.length ? features.map(f => f.Name) : undefined,
    Civilopedia: await localText(improvement.Civilopedia, pediaMaxChars)
  };
}

/**
 * Creates a new instance of the get-improvement tool
 */
export default function createGetImprovementTool(): GetImprovementTool {
  return new GetImprovementTool();
}
