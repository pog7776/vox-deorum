/**
 * Tests for CivAI's rules and Civilopedia tools (get-resource, get-improvement, get-promotion,
 * get-concept). The text helpers run anywhere. The tool queries run read-only against the
 * local Civ V cache databases (Civ5DebugDatabase.db and Localization-Merged.db, rebuilt by
 * the game from the active mods), so those tests skip on machines without Civ V installed.
 * server.js is mocked to hand the tools a real DatabaseManager without starting the server.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseManager } from '../../../src/database/manager.js';
import { getDocumentsPath } from '../../../src/utils/config.js';

const holder: { db?: DatabaseManager } = {};
vi.mock('../../../src/server.js', () => ({
  gameDatabase: new Proxy({}, { get: (_target, prop) => (holder.db as any)[prop].bind(holder.db) })
}));

import { capText, typeLabel, yieldMap } from '../../../src/tools/civai/rules-text.js';
import createGetResourceTool from '../../../src/tools/civai/get-resource.js';
import createGetImprovementTool from '../../../src/tools/civai/get-improvement.js';
import createGetPromotionTool from '../../../src/tools/civai/get-promotion.js';
import createGetConceptTool from '../../../src/tools/civai/get-concept.js';
import { getTools } from '../../../src/tools/index.js';

/** Whether this machine has the Civ V cache databases. */
async function hasGameDatabase(): Promise<boolean> {
  try {
    const cache = path.join(await getDocumentsPath(), 'My Games', "Sid Meier's Civilization 5", 'cache');
    return fs.existsSync(path.join(cache, 'Civ5DebugDatabase.db')) && fs.existsSync(path.join(cache, 'Localization-Merged.db'));
  } catch {
    return false;
  }
}
const gameDb = await hasGameDatabase();

describe('rules-text helpers', () => {
  it('caps long text at a word boundary and marks the cut', () => {
    expect(capText('short', 10)).toBe('short');
    expect(capText('one two three four five six', 15)).toBe('one two three… (shortened)');
    expect(capText(undefined, 10)).toBeUndefined();
  });

  it('turns type keys into readable labels', () => {
    expect(typeLabel('YIELD_FOOD')).toBe('Food');
    expect(typeLabel('UNITCOMBAT_MOUNTED')).toBe('Mounted');
    expect(typeLabel('RESOURCECLASS_LUXURY')).toBe('Luxury');
    expect(typeLabel(null)).toBe('');
  });

  it('sums yield rows by type and drops empty maps', () => {
    expect(yieldMap([{ YieldType: 'YIELD_FOOD', Yield: 1 }, { YieldType: 'YIELD_FOOD', Yield: 1 }, { YieldType: 'YIELD_GOLD', Yield: 2 }]))
      .toEqual({ Food: 2, Gold: 2 });
    expect(yieldMap([])).toBeUndefined();
  });
});

describe('CivAI tool registration', () => {
  it('registers every CivAI tool as read-only', () => {
    const tools = getTools();
    for (const key of ['getMapArea', 'getResource', 'getImprovement', 'getPromotion', 'getConcept'] as const) {
      expect(tools[key], key).toBeDefined();
      expect(tools[key].annotations?.readOnlyHint, key).toBe(true);
    }
  });
});

describe.skipIf(!gameDb)('CivAI rules tools against the local game database', () => {
  beforeAll(async () => {
    holder.db = new DatabaseManager();
    await holder.db.initialize();
  });

  it('get-resource returns Iron with its reveal tech, consumers and Civilopedia', async () => {
    const result = await createGetResourceTool().execute({ Search: 'Iron', MaxResults: 20 });
    expect(result.Count).toBe(1);
    const iron = result.Items[0];
    expect(iron.Name).toBe('Iron');
    expect(iron.Class).toBe('Strategic');
    expect(iron.RevealedBy).toBe('Bronze Working');
    expect(iron.HarvestedBy).toContain('Mine');
    expect(Object.keys(iron.UnitsRequiring ?? {}).length).toBeGreaterThan(0);
    expect(iron.Help).not.toMatch(/\[(NEWLINE|ICON_|COLOR_)/);
    expect(iron.Civilopedia?.length ?? 0).toBeLessThanOrEqual(600 + ' (shortened)…'.length);
  });

  it('prints sample output for review', async () => {
    if (!process.env.CIVAI_PRINT) return;
    const show = async (tool: any, search: string) => console.log(JSON.stringify((await tool.execute({ Search: search, MaxResults: 20 })).Items, null, 1));
    await show(createGetResourceTool(), 'Iron');
    await show(createGetImprovementTool(), 'IMPROVEMENT_MINE');
    await show(createGetPromotionTool(), 'Shock I');
    await show(createGetConceptTool(), 'CONCEPT_HAPPINESS');
  });

  it('get-improvement returns the Mine with its build tech and harvested resources', async () => {
    const result = await createGetImprovementTool().execute({ Search: 'Mine', MaxResults: 20 });
    const mine = result.Items.find((item: any) => item.Name === 'Mine') ?? result.Items[0];
    expect(result.Count).toBeGreaterThan(0);
    expect(mine.Name).toBe('Mine');
    if (result.Count === 1) {
      expect(mine.BuildTech).toBe('Mining');
      expect(mine.HarvestsResources).toContain('Iron');
    }
  });

  it('get-promotion lists promotions and gives full details for a single match', async () => {
    const list = await createGetPromotionTool().execute({ MaxResults: 5 });
    expect(list.Count).toBe(5);
    const single = await createGetPromotionTool().execute({ Search: list.Items[0].Type, MaxResults: 1 });
    expect(single.Count).toBe(1);
    expect(single.Items[0].Name).toBeTruthy();
  });

  it('get-concept finds the Vox Populi happiness article', async () => {
    const list = await createGetConceptTool().execute({ Search: 'Happiness', MaxResults: 10 });
    expect(list.Count).toBeGreaterThan(0);
    const article = await createGetConceptTool().execute({ Search: 'CONCEPT_HAPPINESS', MaxResults: 1 });
    expect(article.Count).toBe(1);
    expect(article.Items[0].Text).toMatch(/Vox Populi/);
    expect(article.Items[0].Text.length).toBeLessThanOrEqual(2500 + ' (shortened)…'.length);
  });
});
