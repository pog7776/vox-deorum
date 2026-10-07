/**
 * Tests for get-history (a civilization's own decisions and visible events) and get-lore
 * (Civilopedia history in sections). History runs against an in-memory knowledge store;
 * lore runs read-only against the local Civ V cache databases and skips without them.
 * Set CIVAI_PRINT=1 to print sample output, including history from a copy of a real game
 * store when CIVAI_HISTORY_DB points at one.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'kysely';
import { DatabaseManager } from '../../../src/database/manager.js';
import { getDocumentsPath } from '../../../src/utils/config.js';

const holder: { db?: DatabaseManager } = {};
vi.mock('../../../src/server.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/server.js')>();
  return {
    ...original,
    gameDatabase: new Proxy({}, { get: (_target, prop) => (holder.db as any)[prop].bind(holder.db) })
  };
});

import { knowledgeManager } from '../../../src/server.js';
import { KnowledgeStore } from '../../../src/knowledge/store.js';
import createGetHistoryTool, { formatHistoryDecision, formatHistoryEvent } from '../../../src/tools/civai/get-history.js';
import createGetLoreTool, { loreSectionChars } from '../../../src/tools/civai/get-lore.js';

/** In-memory store at a given current turn, wired into knowledgeManager. */
async function memoryStore(turn: number): Promise<KnowledgeStore> {
  const store = new KnowledgeStore();
  await store.initialize(':memory:', 'test');
  vi.spyOn(knowledgeManager, 'getStore').mockReturnValue(store);
  vi.spyOn(knowledgeManager, 'getTurn').mockReturnValue(turn);
  return store;
}

/** Inserts a game event visible to the given players. */
async function addEvent(store: KnowledgeStore, id: number, turn: number, type: string, payload: object, visibleTo: number[]) {
  const visibility = Object.fromEntries(visibleTo.map(player => [`Player${player}`, 2]));
  const columns = ['ID', 'Turn', 'Type', 'Payload', ...Object.keys(visibility)];
  const values = [id, turn, type, JSON.stringify(payload), ...Object.values(visibility)];
  await sql`insert into GameEvents (${sql.join(columns.map(c => sql.ref(c)))}) values (${sql.join(values)})`.execute(store.getDatabase());
}

afterEach(() => vi.restoreAllMocks());

describe('history formatting', () => {
  it('formats events from the player\'s point of view', () => {
    expect(formatHistoryEvent('TeamMeet', { CurrentTeam: { Player_3: 'Attila' }, OtherTeam: { Player_1: 'Ashurbanipal' } }, 1)).toBe('Met Attila');
    expect(formatHistoryEvent('TeamMeet', { CurrentTeam: { Player_1: 'Ashurbanipal' }, OtherTeam: {} }, 1)).toBe('Met a city-state');
    expect(formatHistoryEvent('TeamMeet', { CurrentTeam: { Player_2: 'X' }, OtherTeam: { Player_3: 'Y' } }, 1)).toBeUndefined();
    expect(formatHistoryEvent('CityConstructed', { OwnerID: 1, BuildingType: 'Granary', City: { Name: 'Assur' } }, 1)).toBe('Built Granary in Assur');
    expect(formatHistoryEvent('BarbariansCampCleared', { PlayerID: 1, PlotX: 50, PlotY: 18 }, 1)).toBe('Cleared a barbarian encampment at (50,18)');
    expect(formatHistoryEvent('UnitKilledInCombat', { KillerPlayerID: 1, KilledPlayerID: 63, KilledUnitType: 'Hand-Axe', KilledPlayer: { Civilization: 'Barbarians' } }, 1))
      .toBe('Destroyed a Hand-Axe of Barbarians');
    expect(formatHistoryEvent('PlayerAdoptPolicyBranch', { PlayerID: 1, BranchType: 'Authority' }, 1)).toBe('Adopted the Authority policy branch');
    expect(formatHistoryEvent('IdeologyAdopted', { PlayerID: 1, BranchType: 'Authority' }, 1)).toBeUndefined();
    expect(formatHistoryEvent('IdeologyAdopted', { PlayerID: 4, BranchType: 'Authority', Player: { Civilization: 'Japan' } }, 1)).toBe('Japan adopted the Authority policy branch');
    expect(formatHistoryEvent('TeamTechResearched', { TechID: 'Pottery', Team: { Player_1: 'Ashurbanipal' } }, 1)).toBe('Researched Pottery');
  });

  it('formats decisions with a shortened reason and skips empty reviews', () => {
    const base = { ID: 1, Turn: 27, Changes: null };
    expect(formatHistoryDecision({ ...base, Source: 'research', Subject: 'Bronze Working', Rationale: 'Reveal iron.' }))
      .toBe('Chose to research Bronze Working (Reveal iron.)');
    expect(formatHistoryDecision({ ...base, Source: 'flavors', Subject: 'Conquest', Changes: '["Rationale"]', Rationale: 'Steady.' }))
      .toBe('Reviewed strategy, kept course: Steady.');
    expect(formatHistoryDecision({ ...base, Source: 'flavors', Subject: 'Conquest', Changes: '["Rationale"]', Rationale: null })).toBeUndefined();
    expect(formatHistoryDecision({ ...base, Source: 'flavors', Subject: 'Conquest', Changes: '["Rationale","GrandStrategy","Offense"]', Rationale: 'War.' }))
      .toBe('Changed priorities (grand strategy Conquest, 1 flavors) (War.)');
  });
});

describe('get-history', () => {
  it('returns own decisions and visible events, never past the current turn', async () => {
    const store = await memoryStore(30);
    await store.storeMutableKnowledge('ResearchChanges', 1, { Technology: 'Pottery', Rationale: 'Settlers.' } as any, [1], undefined, 0);
    await store.storeMutableKnowledge('ResearchChanges', 2, { Technology: 'Writing', Rationale: 'Not ours.' } as any, [2], undefined, 3);
    await addEvent(store, 10, 10, 'TeamMeet', { CurrentTeam: { Player_3: 'Attila' }, OtherTeam: { Player_1: 'Ashurbanipal' } }, [1, 3]);
    await addEvent(store, 11, 12, 'CityConstructed', { OwnerID: 2, BuildingType: 'Temple', City: { Name: 'Secret' } }, [2]);
    await addEvent(store, 12, 15, 'UnitMoved', { PlayerID: 1 }, [1]);
    await addEvent(store, 13, 35, 'BarbariansCampCleared', { PlayerID: 1, PlotX: 1, PlotY: 2 }, [1]);

    const result = await createGetHistoryTool().execute({ PlayerID: 1, Topic: 'all', MaxEntries: 25 });
    expect(result.Turns).toBe('0-30');
    expect(result.Entries).toEqual(['T0: Chose to research Pottery (Settlers.)', 'T10: Met Attila']);
  });

  it('keeps the most recent entries and reports how many were left out', async () => {
    const store = await memoryStore(50);
    for (let turn = 1; turn <= 5; turn++) {
      await addEvent(store, turn, turn, 'BarbariansCampCleared', { PlayerID: 1, PlotX: turn, PlotY: 0 }, [1]);
    }
    const result = await createGetHistoryTool().execute({ PlayerID: 1, Topic: 'events', MaxEntries: 2 });
    expect(result.Entries).toEqual(['T4: Cleared a barbarian encampment at (4,0)', 'T5: Cleared a barbarian encampment at (5,0)']);
    expect(result.EarlierEntriesNotShown).toBe(3);
  });

  it('prints history from a copy of a real game store when asked', async () => {
    const source = process.env.CIVAI_HISTORY_DB;
    if (!process.env.CIVAI_PRINT || !source || !fs.existsSync(source)) return;
    const copy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'civai-history-')), 'game.db');
    fs.copyFileSync(source, copy);
    const store = new KnowledgeStore();
    await store.initialize(copy, 'copy');
    vi.spyOn(knowledgeManager, 'getStore').mockReturnValue(store);
    vi.spyOn(knowledgeManager, 'getTurn').mockReturnValue(999);
    console.log(JSON.stringify(await createGetHistoryTool().execute({ PlayerID: 1, Topic: 'all', MaxEntries: 50 }), null, 1));
    await store.close();
  });
});

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

describe.skipIf(!gameDb)('get-lore against the local game database', () => {
  beforeAll(async () => {
    holder.db = new DatabaseManager();
    await holder.db.initialize();
  });

  it('returns an outline for a civilization', async () => {
    const outline = await createGetLoreTool().execute({ Subject: 'Assyria' });
    expect(outline.Kind).toBe('Civilization');
    expect(outline.Sections).toContain('7. Neo-Assyrian Empire');
    expect(outline.Opening?.length ?? 0).toBeLessThanOrEqual(300 + ' (shortened)…'.length);
    if (process.env.CIVAI_PRINT) console.log(JSON.stringify(outline, null, 1));
  });

  it('returns a leader outline with dates and one capped section', async () => {
    const outline = await createGetLoreTool().execute({ Subject: 'ashurbanipal' });
    expect(outline.Kind).toBe('Leader');
    expect(outline.Lived).toMatch(/BC/);
    const section = await createGetLoreTool().execute({ Subject: 'Assyria', Section: 7 });
    expect(section.Heading).toBe('Neo-Assyrian Empire');
    expect(section.Text!.length).toBeLessThanOrEqual(loreSectionChars + ' (shortened)…'.length);
    if (process.env.CIVAI_PRINT) console.log(JSON.stringify(section, null, 1));
  });

  it('explains unknown subjects and sections', async () => {
    expect((await createGetLoreTool().execute({ Subject: 'Zzyzx Qwerty' })).Error).toMatch(/No Civilopedia history/);
    expect((await createGetLoreTool().execute({ Subject: 'Assyria', Section: 99 })).Error).toMatch(/doesn't exist/);
  });
});
