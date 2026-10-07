/**
 * @module leaders/leader-seats
 *
 * CivAI leader seat configuration. A trusted launcher writes a seats file (JSON) and points
 * `CIVAI_SEATS_FILE` at it. Each seat names the player it controls and the generated SOUL
 * file that becomes the leader's identity. The file is read fresh for every decision so a
 * relaunch or regenerated SOUL takes effect without restarting vox-agents.
 *
 * Paths inside the file are resolved relative to the file's own directory.
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

/** Environment variable naming the seats file. */
export const leaderSeatsEnvVar = "CIVAI_SEATS_FILE";

/** Default wall-clock limit for one leader decision. */
export const defaultDecisionTimeoutMs = 180_000;

/** Upper bound on any configured decision timeout, so a typo cannot stall the game for hours. */
export const maxDecisionTimeoutMs = 900_000;

const timeoutSchema = z.number().int().min(5_000).max(maxDecisionTimeoutMs);

const seatSchema = z.object({
  /** Path to the seat's generated SOUL.md. */
  soul: z.string().min(1),
  /** Leader type, kept for validation against the live roster (for example LEADER_AUGUSTUS). */
  leaderType: z.string().min(1).optional(),
  /** Per-seat override of the decision timeout. */
  decisionTimeoutMs: timeoutSchema.optional()
});

const seatsFileSchema = z.object({
  schemaVersion: z.literal(1),
  /** Default decision timeout for every seat. */
  decisionTimeoutMs: timeoutSchema.optional(),
  /** Append-only decision log (JSON lines). Phase 2 replaces this with the durable ledger. */
  decisionLog: z.string().min(1).optional(),
  /** Seats keyed by player ID. */
  seats: z.record(z.string().regex(/^\d+$/), seatSchema)
});

/** Parsed seats file. */
export type LeaderSeatsFile = z.infer<typeof seatsFileSchema>;

/** One seat's resolved configuration, with absolute paths and an effective timeout. */
export interface ResolvedLeaderSeat {
  playerID: number;
  soulPath: string;
  leaderType?: string;
  decisionTimeoutMs: number;
  decisionLogPath?: string;
}

/**
 * Parse and validate seats-file JSON text. Throws with a readable message on invalid input.
 */
export function parseLeaderSeats(text: string): LeaderSeatsFile {
  const result = seatsFileSchema.safeParse(JSON.parse(text));
  if (!result.success) {
    throw new Error(`Invalid leader seats file: ${result.error.issues.map(i => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  }
  return result.data;
}

/**
 * Resolve one player's seat from a parsed seats file. Returns undefined when the player has no seat.
 */
export function resolveSeatFromFile(file: LeaderSeatsFile, playerID: number, baseDir: string): ResolvedLeaderSeat | undefined {
  const seat = file.seats[String(playerID)];
  if (!seat) return undefined;
  return {
    playerID,
    soulPath: path.resolve(baseDir, seat.soul),
    leaderType: seat.leaderType,
    decisionTimeoutMs: seat.decisionTimeoutMs ?? file.decisionTimeoutMs ?? defaultDecisionTimeoutMs,
    decisionLogPath: file.decisionLog ? path.resolve(baseDir, file.decisionLog) : undefined
  };
}

/**
 * Load the seats file named by `CIVAI_SEATS_FILE` (or an explicit path) and resolve one player's
 * seat. Returns undefined when no file is configured or the player has no seat; throws when the
 * file exists but is invalid, so misconfiguration is visible rather than silently ignored.
 */
export function loadLeaderSeat(playerID: number, seatsFile: string | undefined = process.env[leaderSeatsEnvVar]): ResolvedLeaderSeat | undefined {
  if (!seatsFile) return undefined;
  const absolute = path.resolve(seatsFile);
  const file = parseLeaderSeats(fs.readFileSync(absolute, "utf8"));
  return resolveSeatFromFile(file, playerID, path.dirname(absolute));
}

/**
 * Read a seat's SOUL text. Rejects an empty file or one with unresolved `{{PLACEHOLDER}}` markers,
 * since either means generation failed.
 */
export function readSoul(seat: ResolvedLeaderSeat): string {
  const soul = fs.readFileSync(seat.soulPath, "utf8").trim();
  if (!soul) throw new Error(`SOUL file is empty: ${seat.soulPath}`);
  const unresolved = soul.match(/\{\{[A-Z0-9_]+\}\}/g);
  if (unresolved) throw new Error(`SOUL file has unresolved placeholders (${[...new Set(unresolved)].join(", ")}): ${seat.soulPath}`);
  return soul;
}
