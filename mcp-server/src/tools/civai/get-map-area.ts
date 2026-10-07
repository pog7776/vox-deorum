/**
 * Tool for describing the terrain around a map position from one player's perspective.
 * Respects fog of war: unrevealed plots are only counted, resources follow the player's
 * tech reveal, and units appear only on plots the player can currently see.
 */

import { LuaFunctionTool } from "../abstract/lua-function.js";
import * as z from "zod";
import { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { MaxMajorCivs } from "../../knowledge/schema/base.js";

/** Largest radius allowed; radius 5 is 91 plots. */
export const maxMapAreaRadius = 5;

/**
 * Schema for one revealed plot as returned by get-map-area.lua
 */
const MapTileSchema = z.object({
  X: z.number(),
  Y: z.number(),
  Distance: z.number(),
  Terrain: z.string().optional(),
  Elevation: z.string().optional(),
  Feature: z.string().optional(),
  River: z.boolean().optional(),
  Lake: z.boolean().optional(),
  Impassable: z.boolean().optional(),
  Resource: z.string().optional(),
  ResourceAmount: z.number().optional(),
  Improvement: z.string().optional(),
  Route: z.string().optional(),
  Owner: z.string().optional(),
  City: z.string().optional(),
  Visible: z.boolean().optional(),
  Units: z.record(z.string(), z.number()).optional()
});
export type MapTile = z.infer<typeof MapTileSchema>;

/**
 * Schema for the raw Lua result. Lua serializes an empty array as an object, so Tiles accepts both.
 */
const MapAreaLuaSchema = z.object({
  Tiles: z.union([z.array(MapTileSchema), z.record(z.string(), MapTileSchema)]).optional(),
  Unrevealed: z.number().optional()
});
type MapAreaLuaResult = z.infer<typeof MapAreaLuaSchema>;

/**
 * Schema for the model-facing result
 */
const MapAreaResultSchema = z.object({
  Center: z.string().describe("Center plot as (X,Y)"),
  Radius: z.number(),
  RevealedPlots: z.number(),
  UnrevealedPlots: z.number().describe("Plots in range this player has never seen"),
  Plots: z.array(z.string()).describe("One line per revealed plot, nearest first")
});
export type MapAreaResult = z.infer<typeof MapAreaResultSchema>;

/**
 * Formats one plot as a compact line for the model.
 * @param tile - Revealed plot from the Lua script
 * @returns e.g. "(12,30) d1: Grassland Hills, Forest, River | Iron x2 | Owner Assyria"
 */
export function formatMapTile(tile: MapTile): string {
  const land = [tile.Terrain, tile.Elevation].filter(Boolean).join(" ") || "Unknown";
  const physical = [land, tile.Feature, tile.River ? "River" : undefined, tile.Lake ? "Lake" : undefined,
    tile.Impassable ? "Impassable" : undefined].filter(Boolean).join(", ");

  const parts = [`(${tile.X},${tile.Y}) d${tile.Distance}: ${physical}`];
  if (tile.Resource) parts.push(tile.ResourceAmount ? `${tile.Resource} x${tile.ResourceAmount}` : tile.Resource);
  if (tile.Improvement) parts.push(tile.Improvement);
  if (tile.Route) parts.push(tile.Route);
  if (tile.City) parts.push(`City ${tile.City}`);
  if (tile.Owner) parts.push(`Owner ${tile.Owner}`);
  if (tile.Units) {
    const units = Object.entries(tile.Units).map(([label, count]) => count > 1 ? `${label} x${count}` : label);
    parts.push(`Units: ${units.join(", ")}`);
  }
  if (tile.Visible === false) parts.push("not in sight (may be outdated)");
  return parts.join(" | ");
}

/**
 * Converts the raw Lua result into the model-facing summary.
 * @param raw - Lua result (may be undefined when the player doesn't exist)
 * @param x - Center X
 * @param y - Center Y
 * @param radius - Radius that was queried
 */
export function summarizeMapArea(raw: MapAreaLuaResult | undefined, x: number, y: number, radius: number): MapAreaResult {
  const tiles = raw?.Tiles ? (Array.isArray(raw.Tiles) ? raw.Tiles : Object.values(raw.Tiles)) : [];
  const sorted = [...tiles].sort((a, b) => a.Distance - b.Distance || a.Y - b.Y || a.X - b.X);
  return {
    Center: `(${x},${y})`,
    Radius: radius,
    RevealedPlots: sorted.length,
    UnrevealedPlots: raw?.Unrevealed ?? 0,
    Plots: sorted.map(formatMapTile)
  };
}

/**
 * Tool that describes terrain, resources, improvements and visible units in a hex area.
 */
class GetMapAreaTool extends LuaFunctionTool<MapAreaLuaResult> {
  /**
   * Unique identifier for the tool
   */
  readonly name = "get-map-area";

  /**
   * Human-readable description of the tool
   */
  readonly description = "Describes the map within a hex radius of a plot, as your civilization knows it: terrain, hills/mountains, features, rivers, " +
    "resources you can see, improvements (including barbarian encampments), roads, owners, cities and units currently in sight. " +
    "Use city or zone coordinates from your reports as the center. Plots you have never explored are only counted.";

  /**
   * Schema for validating tool inputs
   */
  readonly inputSchema = z.object({
    PlayerID: z.number().int().min(0).max(MaxMajorCivs - 1).describe("Player whose knowledge of the map is used"),
    X: z.number().int().min(0).describe("Center plot X coordinate"),
    Y: z.number().int().min(0).describe("Center plot Y coordinate"),
    Radius: z.number().int().min(1).max(maxMapAreaRadius).default(3).describe(`Hex radius around the center (1-${maxMapAreaRadius}, default 3)`)
  });

  /**
   * Schema for the Lua result data
   */
  protected readonly resultSchema = MapAreaLuaSchema;

  /**
   * Lua function arguments
   */
  protected readonly arguments = ["playerID", "centerX", "centerY", "radius"];

  /**
   * Path to the Lua script file
   */
  protected readonly scriptFile = "civai/get-map-area.lua";

  /**
   * Optional annotations for the tool
   */
  readonly annotations: ToolAnnotations = {
    readOnlyHint: true
  }

  /**
   * Optional metadata for the tool
   */
  readonly metadata = {
    autoComplete: ["PlayerID"]
  }

  /**
   * Output schema for the tool (replaces the generic Lua envelope)
   */
  // The base class types this as the generic Lua envelope; this tool returns the summary instead.
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  get outputSchema() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return MapAreaResultSchema as any;
  }

  /**
   * Execute the tool with the provided arguments
   */
  async execute(args: z.infer<typeof this.inputSchema>): Promise<MapAreaResult> {
    const radius = args.Radius ?? 3;
    const result = await this.call(args.PlayerID, args.X, args.Y, radius);
    if (!result.Success) {
      throw new Error(`Failed to read the map area: ${result.Error?.Message || 'Unknown error'}`);
    }
    return summarizeMapArea(result.Result, args.X, args.Y, radius);
  }
}

/**
 * Creates a new instance of the get-map-area tool.
 */
export default function createGetMapAreaTool(): GetMapAreaTool {
  return new GetMapAreaTool();
}
