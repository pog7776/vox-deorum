/**
 * Shared helpers for CivAI's rules and Civilopedia tools: localized, tag-free, length-capped
 * text and raw queries against game tables the generated Kysely schema leaves commented out.
 */

import { sql } from "kysely";
import { gameDatabase } from "../../server.js";
import { stripTags } from "../../utils/database/localized.js";

/** Default cap for Civilopedia write-ups (mostly history; long and rarely decisive). */
export const pediaMaxChars = 600;

/** Default cap for game concept articles (mechanics; worth more room). */
export const conceptMaxChars = 2500;

/**
 * Shortens text to at most maxChars, cutting at a word boundary and marking the cut.
 * @param text - Text to shorten
 * @param maxChars - Maximum length before the marker
 */
export function capText(text: string | undefined, maxChars: number): string | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const cut = trimmed.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}… (shortened)`;
}

/**
 * Localizes a TXT_KEY, strips Civ 5 markup and caps the length.
 * @param key - Localization key, or null
 * @param maxChars - Maximum length
 * @returns Clean text, or undefined when the key is empty or has no translation
 */
export async function localText(key: string | null | undefined, maxChars: number): Promise<string | undefined> {
  if (!key) return undefined;
  const text = await gameDatabase.localize(key);
  if (!text || text === key) return undefined;
  return capText(stripTags(text), maxChars);
}

/**
 * Turns a game type key into a readable name, e.g. YIELD_FOOD -> Food, UNITCOMBAT_MOUNTED -> Mounted.
 * @param type - Type key such as YIELD_FOOD
 */
export function typeLabel(type: string | null | undefined): string {
  if (!type) return "";
  const body = type.includes("_") ? type.slice(type.indexOf("_") + 1) : type;
  return body.toLowerCase().split("_").map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

/**
 * Runs a read-only query against the game database and returns its rows.
 * Used for tables that the generated schema doesn't type.
 * @param query - Kysely raw SQL template
 */
export async function rows<T>(query: ReturnType<typeof sql<T>>): Promise<T[]> {
  const result = await query.execute(gameDatabase.getDatabase());
  return result.rows;
}

/**
 * Reads yield rows (YieldType, Yield) into a { Food: 1, Production: 2 } map.
 * @param list - Rows with YieldType and Yield
 */
export function yieldMap(list: { YieldType: string | null; Yield: number | null }[]): Record<string, number> | undefined {
  const yields: Record<string, number> = {};
  for (const row of list) {
    if (row.YieldType && row.Yield) yields[typeLabel(row.YieldType)] = (yields[typeLabel(row.YieldType)] ?? 0) + row.Yield;
  }
  return Object.keys(yields).length ? yields : undefined;
}
