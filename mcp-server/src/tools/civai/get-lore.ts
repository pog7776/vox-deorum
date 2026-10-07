/**
 * Tool for the real-world history behind a civilization or leader, from the installed game's
 * Civilopedia. Articles are long (Assyria is about 14,000 characters), so a call without a
 * section returns the outline (title, dates, section headings, a short opening) and a call
 * with a section returns that section, capped in length.
 */

import { sql } from "kysely";
import * as z from "zod";
import { search } from "fast-fuzzy";
import { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { gameDatabase } from "../../server.js";
import { stripTags } from "../../utils/database/localized.js";
import { ToolBase } from "../base.js";
import { capText, rows } from "./rules-text.js";

/** Characters of one section returned per call. */
export const loreSectionChars = 2000;

/** Characters of the opening shown with the outline. */
const openingChars = 300;

/** A civilization or leader with a Civilopedia history article. */
export interface LoreSubject {
  Kind: "Civilization" | "Leader";
  Type: string;
  Name: string;
  Tag: string;
}

/** Cached subjects (localized names); the article tags don't change during a session. */
let subjectCache: LoreSubject[] | undefined;

/**
 * Lists civilizations and leaders that have Civilopedia history articles.
 */
export async function loreSubjects(): Promise<LoreSubject[]> {
  if (subjectCache) return subjectCache;
  const list = await rows<{ Kind: "Civilization" | "Leader"; Type: string; NameKey: string; Tag: string }>(sql`
    select 'Civilization' as Kind, Type, ShortDescription as NameKey, CivilopediaTag as Tag from Civilizations
      where CivilopediaTag is not null and Playable = 1
    union all
    select 'Leader', Type, Description, CivilopediaTag from Leaders where CivilopediaTag is not null`);
  const subjects: LoreSubject[] = [];
  for (const row of list) {
    const name = await gameDatabase.localize(row.NameKey);
    if (name && name !== row.NameKey) subjects.push({ Kind: row.Kind, Type: row.Type, Name: stripTags(name), Tag: row.Tag });
  }
  subjectCache = subjects;
  return subjects;
}

/**
 * Reads one localized text key, stripped of markup; undefined when it has no translation.
 * @param key - Localization key
 */
async function text(key: string): Promise<string | undefined> {
  const value = await gameDatabase.localize(key);
  return value && value !== key ? stripTags(value).trim() : undefined;
}

/**
 * Lists an article's numbered section headings, e.g. [{ Number: 1, Heading: "History" }, ...].
 * @param tag - The subject's CivilopediaTag
 */
export async function loreSections(tag: string): Promise<{ Number: number; Heading: string }[]> {
  const sections: { Number: number; Heading: string }[] = [];
  for (let number = 1; number <= 20; number++) {
    const heading = await text(`${tag}_HEADING_${number}`);
    const body = heading ? heading : await text(`${tag}_TEXT_${number}`);
    if (!body) break;
    sections.push({ Number: number, Heading: heading ?? `Part ${number}` });
  }
  return sections;
}

/**
 * Tool returning Civilopedia history for civilizations and leaders
 */
class GetLoreTool extends ToolBase {
  /**
   * Unique identifier for the tool
   */
  readonly name = "get-lore";

  /**
   * Human-readable description of the tool
   */
  readonly description = "Reads the real-world history of a civilization or leader from the Civilopedia (e.g. your own civilization's past, a rival leader's life). " +
    "Without Section it returns the outline: title, dates, numbered section headings and a short opening. Then ask for one Section at a time.";

  /**
   * Input schema
   */
  readonly inputSchema = z.object({
    Subject: z.string().describe("Civilization or leader name, e.g. \"Assyria\" or \"Ashurbanipal\""),
    Section: z.number().int().min(1).optional().describe("Section number from the outline; omit to get the outline")
  });

  /**
   * Output schema
   */
  readonly outputSchema = z.object({
    Subject: z.string().optional(),
    Kind: z.string().optional(),
    Title: z.string().optional(),
    Lived: z.string().optional(),
    Sections: z.array(z.string()).optional(),
    Opening: z.string().optional(),
    Heading: z.string().optional(),
    Text: z.string().optional(),
    Error: z.string().optional()
  });

  /**
   * Annotations
   */
  readonly annotations: ToolAnnotations = { readOnlyHint: true };

  /**
   * Execute the tool
   */
  async execute(args: z.infer<typeof this.inputSchema>): Promise<z.infer<typeof this.outputSchema>> {
    const subjects = await loreSubjects();
    const exact = subjects.find(subject => subject.Name.toLowerCase() === args.Subject.trim().toLowerCase());
    const subject = exact ?? search(args.Subject, subjects, { keySelector: (item: LoreSubject) => item.Name, threshold: 0.6 })[0];
    if (!subject) return { Error: `No Civilopedia history found for "${args.Subject}". Try a civilization or leader name.` };

    const sections = await loreSections(subject.Tag);
    if (args.Section === undefined) {
      const subtitle = subject.Kind === "Leader" ? await text(`${subject.Tag}_SUBTITLE`) : undefined;
      return {
        Subject: subject.Name,
        Kind: subject.Kind,
        Title: subtitle ?? (await text(`${subject.Tag}_TITLE`)) ?? subject.Name,
        Lived: subject.Kind === "Leader" ? await text(`${subject.Tag}_LIVED`) : undefined,
        Sections: sections.map(section => `${section.Number}. ${section.Heading}`),
        Opening: capText(await text(`${subject.Tag}_TEXT_1`), openingChars)
      };
    }

    const section = sections.find(candidate => candidate.Number === args.Section);
    if (!section) return { Subject: subject.Name, Error: `Section ${args.Section} doesn't exist; there are ${sections.length}.` };
    return {
      Subject: subject.Name,
      Heading: section.Heading,
      Text: capText(await text(`${subject.Tag}_TEXT_${section.Number}`), loreSectionChars)
    };
  }
}

/**
 * Creates a new instance of the get-lore tool
 */
export default function createGetLoreTool(): GetLoreTool {
  return new GetLoreTool();
}
