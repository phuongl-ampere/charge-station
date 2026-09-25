import { afterEach, describe, expect, it, vi } from "vitest";
import type { DataSource } from "typeorm";

import {
  ChargingSession,
  ChargingSessionStatus,
  DeviceCommand,
} from "../database/data-source.js";
import { CoreIotClient } from "./core-iot.client.js";
import { CoreTelemetryMonitor } from "./core-telemetry-monitor.service.js";
import { DeviceEventsService } from "./device-events.service.js";

describe("CoreTelemetryMonitor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits timer expiry from a matching relay-off Core telemetry sample", async () => {
    const session = {
      id: "session-1",
      status: ChargingSessionStatus.CHARGING,
      lastDeviceEventAt: null,
      connector: { code: "ST01-C01", station: { deviceId: "core-device" } },
    } as ChargingSession;
    const startCommand = {
      commandId: "start-command",
      payload: { deviceId: "core-device", relayId: "relay-1" },
      session,
    } as DeviceCommand;
    const dataSource = {
      getRepository: vi.fn((entity) => {
        if (entity === ChargingSession) {
          return { find: vi.fn().mockResolvedValue([session]) };
        }
        if (entity === DeviceCommand) {
          return { findOne: vi.fn().mockResolvedValue(startCommand) };
        }
        throw new Error("unexpected repository");
      }),
    };
    const core = {
      latestTelemetry: vi.fn().mockResolvedValue({
        eventAt: new Date().toISOString(),
        relayState: false,
        sessionId: "session-1",
        remainingSeconds: 0,
        lastStopReason: "TIMER_EXPIRED",
        voltageV: 230,
        currentA: 0,
        powerW: 0,
        energyKwh: 0.02,
      }),
    };
    const events = { handle: vi.fn().mockResolvedValue({ accepted: true }) };
    const monitor = new CoreTelemetryMonitor(
      dataSource as unknown as DataSource,
      core as unknown as CoreIotClient,
      events as unknown as DeviceEventsService,
    );

    await monitor.pollOnce();

    expect(events.handle).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: "start-command",
        sessionId: "session-1",
        deviceId: "core-device",
        connectorCode: "ST01-C01",
        type: "STOPPED",
        payload: expect.objectContaining({ reason: "TIMER_EXPIRED" }),
      }),
    );
  });

  it("emits DEVICE_OFFLINE once for stale telemetry", async () => {
    const session = {
      id: "session-1",
      status: ChargingSessionStatus.CHARGING,
      lastDeviceEventAt: new Date("2020-01-01T00:00:00.000Z"),
      operationalWarning: null,
      connector: { code: "ST01-C01", station: { deviceId: "core-device" } },
    } as ChargingSession;
    const startCommand = {
      commandId: "start-command",
      payload: { deviceId: "core-device", relayId: "relay-1" },
      session,
    } as DeviceCommand;
    const dataSource = {
      getRepository: vi.fn((entity) => {
        if (entity === ChargingSession) {
          return { find: vi.fn().mockResolvedValue([session]) };
        }
        if (entity === DeviceCommand) {
          return { findOne: vi.fn().mockResolvedValue(startCommand) };
        }
        throw new Error("unexpected repository");
      }),
    };
    const core = {
      latestTelemetry: vi.fn().mockResolvedValue({
        eventAt: "2020-01-01T00:00:00.000Z",
        relayState: true,
        sessionId: "session-1",
        remainingSeconds: 10,
        lastStopReason: null,
        voltageV: 230,
        currentA: 1,
        powerW: 230,
        energyKwh: 0.02,
      }),
    };
    const events = {
      handle: vi.fn().mockImplementation(async (event) => {
        if (event.type === "DEVICE_OFFLINE") {
          session.operationalWarning = "DEVICE_OFFLINE";
        }
        return { accepted: true };
      }),
    };
    const monitor = new CoreTelemetryMonitor(
      dataSource as unknown as DataSource,
      core as unknown as CoreIotClient,
      events as unknown as DeviceEventsService,
    );

    await monitor.pollOnce();
    await monitor.pollOnce();

    expect(events.handle).toHaveBeenCalledTimes(1);
    expect(events.handle).toHaveBeenCalledWith(
      expect.objectContaining({ type: "DEVICE_OFFLINE" }),
    );
  });

  it("skips telemetry no newer than lastDeviceEventAt", async () => {
    const eventAt = new Date().toISOString();
    const session = {
      id: "session-1",
      status: ChargingSessionStatus.CHARGING,
      lastDeviceEventAt: new Date(eventAt),
      operationalWarning: null,
      connector: { code: "ST01-C01", station: { deviceId: "core-device" } },
    } as ChargingSession;
    const startCommand = {
      commandId: "start-command",
      payload: { deviceId: "core-device", relayId: "relay-1" },
      session,
    } as DeviceCommand;
    const dataSource = {
      getRepository: vi.fn((entity) => {
        if (entity === ChargingSession) {
          return { find: vi.fn().mockResolvedValue([session]) };
        }
        if (entity === DeviceCommand) {
          return { findOne: vi.fn().mockResolvedValue(startCommand) };
        }
        throw new Error("unexpected repository");
      }),
    };
    const core = {
      latestTelemetry: vi.fn().mockResolvedValue({
        eventAt,
        relayState: true,
        sessionId: "session-1",
        remainingSeconds: 10,
        lastStopReason: null,
        voltageV: 230,
        currentA: 1,
        powerW: 230,
        energyKwh: 0.02,
      }),
    };
    const events = { handle: vi.fn() };
    const monitor = new CoreTelemetryMonitor(
      dataSource as unknown as DataSource,
      core as unknown as CoreIotClient,
      events as unknown as DeviceEventsService,
    );

    await monitor.pollOnce();

    expect(events.handle).not.toHaveBeenCalled();
  });

  it("continues polling other devices after a Core telemetry failure", async () => {
    const sessions = ["core-device-1", "core-device-2"].map(
      (deviceId, index) =>
        ({
          id: `session-${index + 1}`,
          status: ChargingSessionStatus.CHARGING,
          lastDeviceEventAt: null,
          operationalWarning: null,
          connector: {
            code: `ST01-C0${index + 1}`,
            station: { deviceId },
          },
        }) as ChargingSession,
    );
    const dataSource = {
      getRepository: vi.fn((entity) => {
        if (entity === ChargingSession) {
          return { find: vi.fn().mockResolvedValue(sessions) };
        }
        if (entity === DeviceCommand) {
          return {
            findOne: vi.fn().mockImplementation(async ({ where }) => {
              const session = sessions.find(
                ({ id }) => id === where.session.id,
              )!;
              return {
                commandId: `start-${session.id}`,
                payload: {
                  deviceId: session.connector.station.deviceId,
                  relayId: "relay-1",
                },
                session,
              } as DeviceCommand;
            }),
          };
        }
        throw new Error("unexpected repository");
      }),
    };
    const core = {
      latestTelemetry: vi
        .fn()
        .mockRejectedValueOnce(new Error("Core unavailable"))
        .mockResolvedValueOnce({
          eventAt: new Date().toISOString(),
          relayState: true,
          sessionId: "session-2",
          remainingSeconds: 10,
          lastStopReason: null,
          voltageV: 230,
          currentA: 1,
          powerW: 230,
          energyKwh: 0.02,
        }),
    };
    const events = { handle: vi.fn().mockResolvedValue({ accepted: true }) };
    const monitor = new CoreTelemetryMonitor(
      dataSource as unknown as DataSource,
      core as unknown as CoreIotClient,
      events as unknown as DeviceEventsService,
    );

    await expect(monitor.pollOnce()).resolves.toBeUndefined();

    expect(events.handle).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "HEARTBEAT",
        deviceId: "core-device-2",
      }),
    );
  });

  it("runs an immediate unrefed poll and clears its interval when stopped", async () => {
    const timer = { unref: vi.fn() } as unknown as ReturnType<
      typeof setInterval
    >;
    const setIntervalSpy = vi
      .spyOn(globalThis, "setInterval")
      .mockReturnValue(timer);
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const monitor = new CoreTelemetryMonitor(
      {} as DataSource,
      {} as CoreIotClient,
      {} as DeviceEventsService,
    );
    const pollOnce = vi.spyOn(monitor, "pollOnce").mockResolvedValue();

    monitor.start();
    await Promise.resolve();

    expect(pollOnce).toHaveBeenCalledOnce();
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 15_000);
    expect(timer.unref).toHaveBeenCalledOnce();

    monitor.stop();

    expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
  });

  it("clears its interval during application shutdown", () => {
    const timer = { unref: vi.fn() } as unknown as ReturnType<
      typeof setInterval
    >;
    vi.spyOn(globalThis, "setInterval").mockReturnValue(timer);
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const monitor = new CoreTelemetryMonitor(
      {} as DataSource,
      {} as CoreIotClient,
      {} as DeviceEventsService,
    );
    vi.spyOn(monitor, "pollOnce").mockResolvedValue();

    monitor.start();
    monitor.onApplicationShutdown();

    expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
  });
});
