import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  InvalidStationQrError,
  StationQrService,
} from "./station-qr.service.js";

describe("StationQrService", () => {
  const originalKey = process.env.STATION_QR_ENCRYPTION_KEY;
  const originalFrontendUrl = process.env.FRONTEND_URL;

  beforeEach(() => {
    process.env.STATION_QR_ENCRYPTION_KEY =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    process.env.FRONTEND_URL = "https://charge.example.test";
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.STATION_QR_ENCRYPTION_KEY;
    else process.env.STATION_QR_ENCRYPTION_KEY = originalKey;
    if (originalFrontendUrl === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = originalFrontendUrl;
  });

  it("issues a 32-character opaque URL token and persists only its digest", async () => {
    const repository = createTokenRepository();
    const service = createService(repository);
    const stationId = "3d20d6e7-5cbe-4fa2-af18-e8d1ab0ddbe6";

    const scan = await service.issue(stationId, 3);

    expect(scan.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(scan.url).toBe(
      `https://charge.example.test/scan/station/${scan.token}`,
    );
    expect(scan.token).not.toContain(stationId);
    expect(repository.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        stationId,
        qrVersion: 3,
        tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
      ["stationId"],
    );
  });

  it("resolves a persisted opaque token by digest", async () => {
    const repository = createTokenRepository();
    const service = createService(repository);
    const stationId = "3d20d6e7-5cbe-4fa2-af18-e8d1ab0ddbe6";
    const scan = await service.issue(stationId, 3);

    await expect(service.resolve(scan.token)).resolves.toEqual({
      stationId,
      qrVersion: 3,
    });
  });

  it("replaces the prior mapping when the station QR version rotates", async () => {
    const repository = createTokenRepository();
    const service = createService(repository);
    const stationId = "3d20d6e7-5cbe-4fa2-af18-e8d1ab0ddbe6";
    const previous = await service.issue(stationId, 1);
    const rotated = await service.issue(stationId, 2);

    expect(rotated.token).not.toBe(previous.token);
    await expect(service.resolve(previous.token)).rejects.toThrow(
      InvalidStationQrError,
    );
    await expect(service.resolve(rotated.token)).resolves.toEqual({
      stationId,
      qrVersion: 2,
    });
  });

  it("rejects a tampered station QR token", async () => {
    const service = createService(createTokenRepository());
    const scan = await service.issue("3d20d6e7-5cbe-4fa2-af18-e8d1ab0ddbe6", 1);
    const tamperedLastCharacter = scan.token.endsWith("x") ? "y" : "x";

    await expect(
      service.resolve(`${scan.token.slice(0, -1)}${tamperedLastCharacter}`),
    ).rejects.toThrow(InvalidStationQrError);
  });

  it("fails closed when the encryption key is missing", async () => {
    delete process.env.STATION_QR_ENCRYPTION_KEY;

    await expect(
      createService(createTokenRepository()).issue("station-id", 1),
    ).rejects.toThrow(
      "STATION_QR_ENCRYPTION_KEY must be a 64-character hexadecimal key",
    );
  });
});

function createTokenRepository() {
  const recordsByHash = new Map<
    string,
    { stationId: string; qrVersion: number; tokenHash: string }
  >();
  const hashesByStation = new Map<string, string>();
  return {
    upsert: vi.fn(
      async (record: {
        stationId: string;
        qrVersion: number;
        tokenHash: string;
      }) => {
        const previousHash = hashesByStation.get(record.stationId);
        if (previousHash) recordsByHash.delete(previousHash);
        hashesByStation.set(record.stationId, record.tokenHash);
        recordsByHash.set(record.tokenHash, record);
      },
    ),
    findOneBy: vi.fn(async ({ tokenHash }: { tokenHash: string }) => {
      return recordsByHash.get(tokenHash) ?? null;
    }),
  };
}

function createService(repository: ReturnType<typeof createTokenRepository>) {
  return new (
    StationQrService as unknown as new (
      value: typeof repository,
    ) => StationQrService
  )(repository);
}
