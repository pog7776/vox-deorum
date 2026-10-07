/**
 * Tests for the get-map-area tool. The Lua boundary is stubbed (no bridge); input
 * validation runs through a real MCP client, and formatting runs on canned Lua results.
 * The Lua script itself can't run here, so its fog-of-war calls are checked statically.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { LuaFunction } from '../../../src/bridge/lua-function.js';
import createGetMapAreaTool, { formatMapTile, summarizeMapArea, maxMapAreaRadius } from '../../../src/tools/knowledge/get-map-area.js';
import { getTools } from '../../../src/tools/index.js';
import { connectToolClient } from '../tool-client.js';

/** Stub the Lua boundary so the tool receives a canned result. */
function mockLua(result: unknown, success = true) {
  return vi.spyOn(LuaFunction.prototype, 'execute').mockResolvedValue(
    success ? { success: true, result } as any : { success: false, error: { code: 'LUA', message: 'boom' } } as any
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('get-map-area formatting', () => {
  it('formats a rich plot on one line', () => {
    expect(formatMapTile({
      X: 12, Y: 30, Distance: 1, Terrain: 'Grassland', Elevation: 'Hills', Feature: 'Forest', River: true,
      Resource: 'Iron', ResourceAmount: 2, Improvement: 'Mine', Route: 'Road', Owner: 'Assyria', Visible: true,
      Units: { 'Barbarians Brute': 2, 'Assyria Warrior': 1 }
    })).toBe('(12,30) d1: Grassland Hills, Forest, River | Iron x2 | Mine | Road | Owner Assyria | Units: Barbarians Brute x2, Assyria Warrior');
  });

  it('marks plots out of sight as possibly outdated', () => {
    expect(formatMapTile({ X: 1, Y: 2, Distance: 3, Terrain: 'Plains', Improvement: 'Barbarian Encampment', Visible: false }))
      .toBe('(1,2) d3: Plains | Barbarian Encampment | not in sight (may be outdated)');
  });

  it('sorts plots nearest first and reports unrevealed plots as a count only', () => {
    const summary = summarizeMapArea({
      Tiles: [
        { X: 6, Y: 5, Distance: 1, Terrain: 'Ocean' },
        { X: 5, Y: 5, Distance: 0, Terrain: 'Grassland', City: 'Nineveh', Owner: 'Assyria' }
      ],
      Unrevealed: 5
    }, 5, 5, 1);
    expect(summary).toEqual({
      Center: '(5,5)',
      Radius: 1,
      RevealedPlots: 2,
      UnrevealedPlots: 5,
      Plots: ['(5,5) d0: Grassland | City Nineveh | Owner Assyria', '(6,5) d1: Ocean']
    });
  });

  it('accepts the object form Lua uses for an empty tile list', () => {
    expect(summarizeMapArea({ Tiles: {}, Unrevealed: 7 }, 0, 0, 1)).toMatchObject({ RevealedPlots: 0, UnrevealedPlots: 7, Plots: [] });
    expect(summarizeMapArea(undefined, 0, 0, 1)).toMatchObject({ RevealedPlots: 0, UnrevealedPlots: 0 });
  });
});

describe('get-map-area tool', () => {
  it('is registered and asks for PlayerID to be filled from the seat', () => {
    const tool = getTools().getMapArea;
    expect(tool.name).toBe('get-map-area');
    expect(tool.metadata?.autoComplete).toContain('PlayerID');
    expect(tool.annotations?.readOnlyHint).toBe(true);
  });

  it('passes the player, center and default radius to Lua', async () => {
    const spy = mockLua({ Tiles: [], Unrevealed: 0 });
    const client = await connectToolClient(createGetMapAreaTool());
    try {
      const result = await client.call({ PlayerID: 1, X: 10, Y: 20 });
      expect(spy).toHaveBeenCalledWith(1, 10, 20, 3);
      expect(result.Center).toBe('(10,20)');
    } finally {
      await client.close();
    }
  });

  it('rejects radii above the cap and negative coordinates', async () => {
    mockLua({ Tiles: [], Unrevealed: 0 });
    const client = await connectToolClient(createGetMapAreaTool());
    try {
      await expect(client.call({ PlayerID: 1, X: 1, Y: 1, Radius: maxMapAreaRadius + 1 })).rejects.toThrow();
      await expect(client.call({ PlayerID: 1, X: -1, Y: 1 })).rejects.toThrow();
    } finally {
      await client.close();
    }
  });

  it('surfaces a Lua failure as an error', async () => {
    mockLua(undefined, false);
    await expect(createGetMapAreaTool().execute({ PlayerID: 1, X: 1, Y: 1, Radius: 2 })).rejects.toThrow(/boom/);
  });
});

describe('get-map-area.lua fog of war', () => {
  const script = fs.readFileSync(path.join(process.cwd(), 'lua', 'get-map-area.lua'), 'utf8');

  it('only reads team-scoped knowledge and never the debug reveal', () => {
    expect(script).toContain('pPlot:IsRevealed(iTeam, false)');
    expect(script).toContain('pPlot:GetResourceType(iTeam)');
    expect(script).toContain('GetRevealedImprovementType(iTeam, false)');
    expect(script).toContain('GetRevealedOwner(iTeam, false)');
    expect(script).toContain('pUnit:IsInvisible(iTeam, false)');
    expect(script).not.toMatch(/,\s*true\s*\)/);
    expect(script).not.toMatch(/GetResourceType\(\s*\)/);
  });

  it('lists units only on plots currently in sight', () => {
    expect(script).toMatch(/if tile\.Visible then[\s\S]*GetNumUnits/);
  });
});
