/**
 * Tool for looking up unit promotions (Shock, Drill, Cover, Medic...) in the active mod's rules:
 * what each does, which unit types can take it, and which promotions lead to it.
 */

import { sql } from "kysely";
import * as z from "zod";
import { DatabaseQueryTool } from "../abstract/database-query.js";
import { rows, typeLabel } from "./rules-text.js";

/** Columns holding a promotion's "requires one of" prerequisites. */
const prereqColumns = ["PromotionPrereqOr1", "PromotionPrereqOr2", "PromotionPrereqOr3", "PromotionPrereqOr4",
  "PromotionPrereqOr5", "PromotionPrereqOr6", "PromotionPrereqOr7", "PromotionPrereqOr8", "PromotionPrereqOr9"];

/**
 * Schema for promotion summary information
 */
const PromotionSummarySchema = z.object({
  Type: z.string(),
  Name: z.string(),
  Help: z.string().optional()
});

/**
 * Schema for full promotion information
 */
const PromotionReportSchema = PromotionSummarySchema.extend({
  UnitCombatTypes: z.array(z.string()).optional(),
  RequiresOneOf: z.array(z.string()).optional(),
  LeadsTo: z.array(z.string()).optional(),
  CannotBeChosen: z.boolean().optional()
});

type PromotionSummary = z.infer<typeof PromotionSummarySchema>;
type PromotionReport = z.infer<typeof PromotionReportSchema>;

/**
 * Tool for querying promotion rules from the game database
 */
class GetPromotionTool extends DatabaseQueryTool<PromotionSummary, PromotionReport> {
  /**
   * Unique identifier for the tool
   */
  readonly name = "get-promotion";

  /**
   * Human-readable description of the tool
   */
  readonly description = "Looks up unit promotions in the active mod's rules: what each promotion does, which unit types can take it, " +
    "and which promotions it requires or unlocks. Search by name; one match returns full details.";

  /**
   * Schema for promotion summary
   */
  protected readonly summarySchema = PromotionSummarySchema;

  /**
   * Schema for full promotion information
   */
  protected readonly fullSchema = PromotionReportSchema;

  /**
   * Fetch promotion summaries from the database
   */
  protected async fetchSummaries(): Promise<PromotionSummary[]> {
    const list = await rows<{ Type: string; Name: string; Help: string | null }>(sql`
      select Type, Description as Name, Help from UnitPromotions where Description is not null`);
    return list.map(p => ({ Type: p.Type, Name: p.Name, Help: p.Help ?? undefined }));
  }

  /**
   * Fetch full promotion information
   */
  protected fetchFullInfo = getPromotion;
}

/**
 * Fetch full information for one promotion
 * @param promotionType - Promotion type key, e.g. PROMOTION_SHOCK_1
 */
export async function getPromotion(promotionType: string): Promise<PromotionReport> {
  const [promotion] = await rows<Record<string, string | number | null>>(sql`
    select * from UnitPromotions where Type = ${promotionType}`);
  if (!promotion) throw new Error(`Promotion ${promotionType} not found`);

  const combats = await rows<{ UnitCombatType: string }>(sql`
    select UnitCombatType from UnitPromotions_UnitCombats where PromotionType = ${promotionType}`);
  const prereqTypes = prereqColumns.map(column => promotion[column]).filter((value): value is string => typeof value === "string" && value.length > 0);
  const prereqs = prereqTypes.length ? await rows<{ Name: string }>(sql`
    select Description as Name from UnitPromotions where Type in (${sql.join(prereqTypes)})`) : [];
  const leadsTo = await rows<{ Name: string }>(sql`
    select Description as Name from UnitPromotions
    where ${sql.join(prereqColumns.map(column => sql`${sql.ref(column)} = ${promotionType}`), sql` or `)}`);

  return {
    Type: String(promotion.Type),
    Name: String(promotion.Description ?? promotion.Type),
    Help: typeof promotion.Help === "string" ? promotion.Help : undefined,
    UnitCombatTypes: combats.length ? combats.map(c => typeLabel(c.UnitCombatType)) : undefined,
    RequiresOneOf: prereqs.length ? prereqs.map(p => p.Name) : undefined,
    LeadsTo: leadsTo.length ? leadsTo.map(p => p.Name) : undefined,
    CannotBeChosen: promotion.CannotBeChosen ? true : undefined
  };
}

/**
 * Creates a new instance of the get-promotion tool
 */
export default function createGetPromotionTool(): GetPromotionTool {
  return new GetPromotionTool();
}
