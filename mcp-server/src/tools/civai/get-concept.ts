/**
 * Tool for reading the Civilopedia's game concept articles (happiness, city growth, combat,
 * city-states...). Under Vox Populi these explain the mod's reworked mechanics, which differ
 * from the base game a model may remember.
 */

import { sql } from "kysely";
import * as z from "zod";
import { gameDatabase } from "../../server.js";
import { stripTags } from "../../utils/database/localized.js";
import { DatabaseQueryTool } from "../abstract/database-query.js";
import { capText, conceptMaxChars, localText, rows } from "./rules-text.js";

/** Characters of the article kept in listings, so search can match on content. */
const previewChars = 160;

/**
 * Schema for concept summary information
 */
const ConceptSummarySchema = z.object({
  Type: z.string(),
  Name: z.string(),
  Topic: z.string().optional(),
  Preview: z.string().optional()
});

/**
 * Schema for a full concept article
 */
const ConceptReportSchema = ConceptSummarySchema.extend({
  Text: z.string().optional(),
  Related: z.array(z.string()).optional()
});

type ConceptSummary = z.infer<typeof ConceptSummarySchema>;
type ConceptReport = z.infer<typeof ConceptReportSchema>;

/**
 * Tool for querying game concept articles from the Civilopedia
 */
class GetConceptTool extends DatabaseQueryTool<ConceptSummary, ConceptReport> {
  /**
   * Unique identifier for the tool
   */
  readonly name = "get-concept";

  /**
   * Human-readable description of the tool
   */
  readonly description = "Reads the Civilopedia's game concept articles for the active mod (e.g. happiness, city growth, combat, city-states, " +
    "trade routes, religion, espionage). Use it to check how a mechanic really works in Vox Populi. Search by topic; one match returns the article.";

  /**
   * Schema for concept summary
   */
  protected readonly summarySchema = ConceptSummarySchema;

  /**
   * Schema for a full concept article
   */
  protected readonly fullSchema = ConceptReportSchema;

  /**
   * Search on the title, topic and opening text
   */
  protected getSearchFields(): string[] {
    return ["Name", "Topic", "Preview", "Type"];
  }

  /**
   * Fetch concept summaries with a short localized preview of each article
   */
  protected async fetchSummaries(): Promise<ConceptSummary[]> {
    const list = await rows<{ Type: string; Name: string; Topic: string | null; Summary: string | null }>(sql`
      select Type, Description as Name, Topic, Summary from Concepts where Description is not null`);
    const summaries: ConceptSummary[] = [];
    for (const concept of list) {
      summaries.push({
        Type: concept.Type,
        Name: concept.Name,
        Topic: concept.Topic ?? undefined,
        Preview: await localText(concept.Summary, previewChars)
      });
    }
    return summaries;
  }

  /**
   * Fetch one full concept article
   */
  protected fetchFullInfo = getConcept;
}

/**
 * Fetch a full concept article with its related concepts
 * @param conceptType - Concept type key, e.g. CONCEPT_HAPPINESS
 */
export async function getConcept(conceptType: string): Promise<ConceptReport> {
  const [concept] = await rows<{ Type: string; Name: string; Topic: string | null; Summary: string | null; Extended: string | null }>(sql`
    select Type, Description as Name, Topic, Summary, Extended from Concepts where Type = ${conceptType}`);
  if (!concept) throw new Error(`Concept ${conceptType} not found`);

  const parts: string[] = [];
  for (const key of [concept.Summary, concept.Extended]) {
    if (!key) continue;
    const text = await gameDatabase.localize(key);
    if (text && text !== key) parts.push(stripTags(text));
  }
  const related = await rows<{ Name: string }>(sql`
    select c.Description as Name from Concepts_RelatedConcept r join Concepts c on c.Type = r.RelatedConcept
    where r.ConceptType = ${conceptType}`);

  return {
    Type: concept.Type,
    Name: concept.Name,
    Topic: concept.Topic ?? undefined,
    Text: capText(parts.join("\n\n"), conceptMaxChars),
    Related: related.length ? related.map(r => r.Name) : undefined
  };
}

/**
 * Creates a new instance of the get-concept tool
 */
export default function createGetConceptTool(): GetConceptTool {
  return new GetConceptTool();
}
