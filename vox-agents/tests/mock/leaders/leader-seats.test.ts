import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultDecisionTimeoutMs, loadLeaderSeat, parseLeaderSeats, readSoul, resolveSeatFromFile } from "../../../src/leaders/leader-seats.js";

describe("leader seats", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "civai-seats-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Write a seats file into the temp directory and return its path. */
  function writeSeats(content: unknown): string {
    const file = path.join(dir, "seats.json");
    fs.writeFileSync(file, JSON.stringify(content));
    return file;
  }

  it("should resolve paths relative to the seats file and apply timeout defaults", () => {
    const file = writeSeats({
      schemaVersion: 1,
      decisionLog: "logs/decisions.jsonl",
      seats: {
        "1": { soul: "seats/p01/SOUL.md", leaderType: "LEADER_AUGUSTUS" },
        "2": { soul: "seats/p02/SOUL.md", decisionTimeoutMs: 60_000 }
      }
    });

    const one = loadLeaderSeat(1, file)!;
    expect(one.soulPath).toBe(path.join(dir, "seats/p01/SOUL.md"));
    expect(one.decisionLogPath).toBe(path.join(dir, "logs/decisions.jsonl"));
    expect(one.decisionTimeoutMs).toBe(defaultDecisionTimeoutMs);
    expect(one.leaderType).toBe("LEADER_AUGUSTUS");

    expect(loadLeaderSeat(2, file)!.decisionTimeoutMs).toBe(60_000);
  });

  it("should return undefined for an unconfigured player or when no file is set", () => {
    const file = writeSeats({ schemaVersion: 1, seats: { "1": { soul: "SOUL.md" } } });
    expect(loadLeaderSeat(3, file)).toBeUndefined();
    expect(loadLeaderSeat(1, undefined)).toBeUndefined();
  });

  it("should reject invalid files rather than silently ignoring them", () => {
    expect(() => parseLeaderSeats(JSON.stringify({ schemaVersion: 2, seats: {} }))).toThrow(/Invalid leader seats file/);
    expect(() => parseLeaderSeats(JSON.stringify({ schemaVersion: 1, seats: { "x": { soul: "a" } } }))).toThrow(/Invalid leader seats file/);
    expect(() => parseLeaderSeats(JSON.stringify({ schemaVersion: 1, decisionTimeoutMs: 1, seats: {} }))).toThrow(/Invalid leader seats file/);
  });

  it("should prefer the seat timeout over the file default", () => {
    const parsed = parseLeaderSeats(JSON.stringify({ schemaVersion: 1, decisionTimeoutMs: 30_000, seats: { "4": { soul: "s" } } }));
    expect(resolveSeatFromFile(parsed, 4, dir)!.decisionTimeoutMs).toBe(30_000);
  });

  it("should read a SOUL and reject empty files or unresolved placeholders", () => {
    const soulPath = path.join(dir, "SOUL.md");
    const seat = { playerID: 1, soulPath, decisionTimeoutMs: 60_000 };

    fs.writeFileSync(soulPath, "# Identity\nYou are Augustus.\n");
    expect(readSoul(seat)).toContain("Augustus");

    fs.writeFileSync(soulPath, "You are {{LEADER_NAME}}.");
    expect(() => readSoul(seat)).toThrow(/LEADER_NAME/);

    fs.writeFileSync(soulPath, "  \n");
    expect(() => readSoul(seat)).toThrow(/empty/);
  });
});
