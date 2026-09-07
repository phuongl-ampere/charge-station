import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import type { DataSource } from "typeorm";

import type { DeviceEvent as DeviceEventContract } from "@charge-station/contracts";

import {
  ChargingSession,
  ChargingSessionStatus,
  Connector,
  ConnectorStatus,
  DeviceCommand,
  DeviceEvent,
} from "../database/data-source.js";
import { DeviceEventsService } from "./device-events.service.js";

describe("DeviceEventsService", () => {
  it("changes a session to CHARGING once when RUNNING arrives twice", async () => {
    const harness = createHarness(ChargingSessionStatus.STARTING);
    const service = new DeviceEventsService(
      harness.dataSource as unknown as DataSource,
    );
    const runningEvent = createEvent(
      harness.command.commandId,
      harness.session.id,
      {
        type: "RUNNING",
        payload: { relayState: "ON", remainingSeconds: 3600 },
      },
    );

    await service.handle(runningEvent);
    await service.handle({
      ...runningEvent,
      eventId: "evt_duplicate_delivery",
    });

    expect(harness.sessionRepository.save).toHaveBeenCalledTimes(1);
    expect(harness.session.status).toBe(ChargingSessionStatus.CHARGING);
    expect(harness.session.startedAt).toBeInstanceOf(Date);
    expect(harness.events).toHaveLength(2);
  });

  it("persists one accepted event when its eventId is delivered twice", async () => {
    const harness = createHarness(ChargingSessionStatus.STARTING);
    const service = new DeviceEventsService(
      harness.dataSource as unknown as DataSource,
    );
    const runningEvent = createEvent(
      harness.command.commandId,
      harness.session.id,
      {
        type: "RUNNING",
        payload: { relayState: "ON", remainingSeconds: 3600 },
      },
    );

    await service.handle(runningEvent);
    await service.handle(runningEvent);

    expect(harness.events).toHaveLength(1);
    expect(harness.sessionRepository.save).toHaveBeenCalledTimes(1);
  });

  it("releases a connector only after a confirmed STOPPED event", async () => {
    const harness = createHarness(ChargingSessionStatus.CHARGING);
    const service = new DeviceEventsService(
      harness.dataSource as unknown as DataSource,
    );

    await service.handle(
      createEvent(harness.command.commandId, harness.session.id, {
        type: "COMMAND_FAILED",
        payload: { reason: "COMMAND_FAILED" },
      }),
    );

    expect(harness.connector.status).toBe(ConnectorStatus.OCCUPIED);

    await service.handle(
      createEvent(harness.command.commandId, harness.session.id, {
        type: "STOPPED",
        payload: { reason: "TIMER_EXPIRED", relayState: "OFF" },
      }),
    );

    expect(harness.session.status).toBe(ChargingSessionStatus.COMPLETED);
    expect(harness.connector.status).toBe(ConnectorStatus.AVAILABLE);
    expect(harness.connectorRepository.save).toHaveBeenCalledTimes(1);
  });

  it("releases an occupied connector when STOPPED confirms relay-off after start failure", async () => {
    const harness = createHarness(ChargingSessionStatus.START_FAILED);
    const service = new DeviceEventsService(
      harness.dataSource as unknown as DataSource,
    );

    await service.handle(
      createEvent(harness.command.commandId, harness.session.id, {
        type: "STOPPED",
        payload: { reason: "COMMAND_FAILED", relayState: "OFF" },
      }),
    );

    expect(harness.session.status).toBe(ChargingSessionStatus.START_FAILED);
    expect(harness.connector.status).toBe(ConnectorStatus.AVAILABLE);
    expect(harness.connectorRepository.save).toHaveBeenCalledTimes(1);
  });

  it.each([
    ChargingSessionStatus.PENDING,
    ChargingSessionStatus.STARTING,
    ChargingSessionStatus.CHARGING,
    ChargingSessionStatus.STOPPING,
    ChargingSessionStatus.DEVICE_OFFLINE,
  ])(
    "makes STOPPED terminal from %s and ignores later stale start events",
    async (status) => {
      const harness = createHarness(status);
      const service = new DeviceEventsService(
        harness.dataSource as unknown as DataSource,
      );

      await service.handle(
        createEvent(harness.command.commandId, harness.session.id, {
          type: "STOPPED",
          payload: { reason: "TIMER_EXPIRED", relayState: "OFF" },
        }),
      );
      await service.handle(
        createEvent(harness.command.commandId, harness.session.id, {
          type: "COMMAND_ACCEPTED",
          payload: {},
        }),
      );
      await service.handle(
        createEvent(harness.command.commandId, harness.session.id, {
          type: "RUNNING",
          payload: { relayState: "ON" },
        }),
      );

      expect(harness.session.status).toBe(ChargingSessionStatus.COMPLETED);
      expect(harness.session.stoppedAt).toBeInstanceOf(Date);
      expect(harness.connector.status).toBe(ConnectorStatus.AVAILABLE);
      expect(harness.connectorRepository.save).toHaveBeenCalledTimes(1);
    },
  );

  it("persists current heartbeat and offline state on the charging session", async () => {
    const harness = createHarness(ChargingSessionStatus.CHARGING);
    const service = new DeviceEventsService(
      harness.dataSource as unknown as DataSource,
    );

    await service.handle(
      createEvent(harness.command.commandId, harness.session.id, {
        type: "HEARTBEAT",
        occurredAt: "2026-09-08T11:00:00.000Z",
        payload: { remainingSeconds: 3600 },
      }),
    );
    await service.handle(
      createEvent(harness.command.commandId, harness.session.id, {
        type: "DEVICE_OFFLINE",
        occurredAt: "2026-09-08T11:01:00.000Z",
        payload: { reason: "CONNECTION_LOST" },
      }),
    );

    expect(harness.session).toMatchObject({
      estimatedRemainingSeconds: 3600,
      lastDeviceEventAt: new Date("2026-09-08T11:01:00.000Z"),
      operationalWarning: "DEVICE_OFFLINE",
    });
    expect(harness.sessionRepository.save).toHaveBeenCalledTimes(2);
  });
});

function createHarness(status: ChargingSessionStatus) {
  const connector = {
    id: randomUUID(),
    code: "ST01-C01",
    status: ConnectorStatus.OCCUPIED,
  } as Connector;
  const session = {
    id: randomUUID(),
    status,
    connector,
    startedAt: null,
    expectedEndAt: new Date("2026-09-08T12:00:00.000Z"),
    stoppedAt: null,
  } as ChargingSession;
  const command = {
    id: randomUUID(),
    commandId: randomUUID(),
    session,
    payload: {
      deviceId: "dev_ST01",
      connectorCode: connector.code,
      sessionId: session.id,
    },
  } as unknown as DeviceCommand;
  const events: DeviceEvent[] = [];
  const sessionRepository = {
    findOneBy: vi.fn().mockResolvedValue(session),
    save: vi.fn().mockImplementation(async (entity) => entity),
  };
  const commandRepository = {
    findOne: vi.fn().mockResolvedValue(command),
    save: vi.fn().mockImplementation(async (entity) => entity),
  };
  const connectorRepository = {
    save: vi.fn().mockImplementation(async (entity) => entity),
  };
  const eventRepository = {
    findOneBy: vi.fn().mockImplementation(async ({ eventId }) => {
      return events.find((event) => event.eventId === eventId) ?? null;
    }),
    create: vi.fn().mockImplementation((entity) => entity),
    save: vi.fn().mockImplementation(async (entity) => {
      events.push(entity);
      return entity;
    }),
  };
  const manager = {
    query: vi.fn().mockResolvedValue([{ id: session.id }]),
    getRepository: vi.fn((entity) => {
      if (entity === ChargingSession) return sessionRepository;
      if (entity === DeviceCommand) return commandRepository;
      if (entity === Connector) return connectorRepository;
      if (entity === DeviceEvent) return eventRepository;
      throw new Error("Unexpected repository");
    }),
  };
  const dataSource = {
    transaction: vi.fn(async (callback) => callback(manager)),
  };

  return {
    command,
    connector,
    connectorRepository,
    dataSource,
    events,
    session,
    sessionRepository,
  };
}

function createEvent(
  commandId: string,
  sessionId: string,
  overrides: Partial<DeviceEventContract>,
): DeviceEventContract {
  return {
    eventId: randomUUID(),
    commandId,
    sessionId,
    deviceId: "dev_ST01",
    connectorCode: "ST01-C01",
    type: "RUNNING",
    occurredAt: "2026-09-08T11:00:00.000Z",
    payload: {},
    ...overrides,
  };
}
