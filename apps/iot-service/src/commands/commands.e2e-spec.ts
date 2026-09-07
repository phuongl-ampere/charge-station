import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { ServiceTokenGuard } from "../common/service-token.guard.js";
import { DeviceStateService } from "../devices/device-state.service.js";
import { ChargeStationEventClient } from "../events/charge-station-event.client.js";
import { CommandsController } from "./commands.controller.js";
import { CommandsService } from "./commands.service.js";

function startCommand(commandId: string) {
  return {
    commandId,
    sessionId: `session-${commandId}`,
    stationCode: "ST01",
    connectorCode: "ST01-C01",
    durationSeconds: 2,
    expiresAt: new Date(Date.now() + 2000).toISOString(),
    configVersion: 1,
  };
}

describe("internal command API", () => {
  let app: INestApplication;
  let eventClient: { post: ReturnType<typeof vi.fn> };

  beforeAll(async () => {
    process.env.SERVICE_TOKEN = "test-service-token";
    eventClient = { post: vi.fn().mockResolvedValue(undefined) };
    const module = await Test.createTestingModule({
      controllers: [CommandsController],
      providers: [
        CommandsService,
        DeviceStateService,
        ServiceTokenGuard,
        {
          provide: ChargeStationEventClient,
          useValue: eventClient,
        },
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();
  });

  beforeEach(() => {
    vi.useFakeTimers();
    eventClient.post.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.SERVICE_TOKEN;
  });

  it("requires the service token on command routes", async () => {
    await request(app.getHttpServer())
      .post("/internal/commands/start")
      .send(startCommand("command-auth"))
      .expect(401);
  });

  it("fails closed when SERVICE_TOKEN is not configured", async () => {
    delete process.env.SERVICE_TOKEN;

    await request(app.getHttpServer())
      .post("/internal/commands/start")
      .set("X-Service-Token", "local-service-token-change-me")
      .send(startCommand("command-missing-token"))
      .expect(401);

    process.env.SERVICE_TOKEN = "test-service-token";
  });

  it("deduplicates commands and rejects an occupied connector", async () => {
    const first = await request(app.getHttpServer())
      .post("/internal/commands/start")
      .set("X-Service-Token", "test-service-token")
      .send(startCommand("command-first"))
      .expect(201);
    const duplicate = await request(app.getHttpServer())
      .post("/internal/commands/start")
      .set("X-Service-Token", "test-service-token")
      .send(startCommand("command-first"))
      .expect(201);
    const occupied = await request(app.getHttpServer())
      .post("/internal/commands/start")
      .set("X-Service-Token", "test-service-token")
      .send(startCommand("command-second"))
      .expect(201);

    expect(duplicate.body).toEqual(first.body);
    expect(occupied.body).toMatchObject({
      commandId: "command-second",
      accepted: false,
      status: "REJECTED",
    });

    await vi.advanceTimersByTimeAsync(2100);
    expect(
      eventClient.post.mock.calls.filter(
        ([event]) => event.type === "COMMAND_ACCEPTED",
      ),
    ).toHaveLength(1);
  });

  it("stops an active command once and clears its expiry timer", async () => {
    await request(app.getHttpServer())
      .post("/internal/commands/start")
      .set("X-Service-Token", "test-service-token")
      .send(startCommand("command-stop"))
      .expect(201);
    await vi.advanceTimersByTimeAsync(100);

    const stopped = await request(app.getHttpServer())
      .post("/internal/commands/stop")
      .set("X-Service-Token", "test-service-token")
      .send({
        commandId: "stop-command",
        sessionId: "session-command-stop",
        reason: "USER_REQUESTED",
      })
      .expect(201);

    expect(stopped.body).toMatchObject({
      commandId: "stop-command",
      accepted: true,
      status: "STOPPED",
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(
      eventClient.post.mock.calls.filter(([event]) => event.type === "STOPPED"),
    ).toHaveLength(1);
  });
});
