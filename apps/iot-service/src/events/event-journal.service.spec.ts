import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import type { DeviceEvent } from "@charge-station/contracts";

import { EventJournalService } from "./event-journal.service.js";

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(
    paths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("EventJournalService", () => {
  it("can be constructed by Nest with the configured default journal path", async () => {
    const module = await Test.createTestingModule({
      providers: [EventJournalService],
    }).compile();

    try {
      expect(module.get(EventJournalService)).toBeInstanceOf(
        EventJournalService,
      );
    } finally {
      await module.close();
    }
  });

  it("persists stable critical event payloads, sequence, retries, and delivery state", async () => {
    const path = await journalPath();
    const journal = new EventJournalService(path);
    const event = criticalEvent("COMMAND_ACCEPTED");

    await journal.initialize();
    await journal.append(event);
    await journal.recordRetry(
      event.eventId,
      1,
      new Date("2026-09-08T12:00:01.000Z"),
    );
    await journal.markDelivered(event.eventId);

    const persisted = JSON.parse(await readFile(path, "utf8")) as {
      records: Array<Record<string, unknown>>;
    };
    expect(persisted.records).toEqual([
      expect.objectContaining({
        event,
        sequence: 1,
        retryCount: 1,
        delivered: true,
        nextAttemptAt: "2026-09-08T12:00:01.000Z",
      }),
    ]);
  });

  it("reloads undelivered records in per-session sequence order after a restart", async () => {
    const path = await journalPath();
    const first = new EventJournalService(path);
    const accepted = criticalEvent("COMMAND_ACCEPTED", "event-accepted");
    const running = criticalEvent("RUNNING", "event-running");

    await first.initialize();
    await first.append(accepted);
    await first.append(running);
    await first.recordRetry(
      accepted.eventId,
      2,
      new Date("2026-09-08T12:00:02.000Z"),
    );

    const restarted = new EventJournalService(path);
    const records = await restarted.initialize();

    expect(records).toEqual([
      expect.objectContaining({
        event: accepted,
        sequence: 1,
        retryCount: 2,
        delivered: false,
      }),
      expect.objectContaining({
        event: running,
        sequence: 2,
        retryCount: 0,
        delivered: false,
      }),
    ]);
  });
});

async function journalPath(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), "charge-station-iot-journal-"),
  );
  paths.push(directory);
  return join(directory, "events.json");
}

function criticalEvent(
  type: "COMMAND_ACCEPTED" | "RUNNING",
  eventId = `event-${type.toLowerCase()}`,
): DeviceEvent {
  return {
    eventId,
    commandId: "command-1",
    sessionId: "session-1",
    deviceId: "dev_ST01",
    connectorCode: "ST01-C01",
    type,
    occurredAt: "2026-09-08T12:00:00.000Z",
    payload:
      type === "RUNNING"
        ? { relayState: "ON", remainingSeconds: 3600 }
        : { relayState: "OFF" },
  };
}
