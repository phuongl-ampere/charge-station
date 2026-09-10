import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
    if (originalKey === undefined) {
      delete process.env.STATION_QR_ENCRYPTION_KEY;
    } else {
      process.env.STATION_QR_ENCRYPTION_KEY = originalKey;
    }
    if (originalFrontendUrl === undefined) {
      delete process.env.FRONTEND_URL;
    } else {
      process.env.FRONTEND_URL = originalFrontendUrl;
    }
  });

  it("creates an opaque station scan URL and resolves its versioned payload", () => {
    const service = new StationQrService();
    const stationId = "3d20d6e7-5cbe-4fa2-af18-e8d1ab0ddbe6";

    const scan = service.issue(stationId, 3);

    expect(scan.url).toMatch(
      /^https:\/\/charge\.example\.test\/scan\/station\/[A-Za-z0-9_-]+$/,
    );
    expect(scan.url).not.toContain(stationId);
    expect(scan.token).not.toContain(stationId);
    expect(service.resolve(scan.token)).toEqual({
      stationId,
      qrVersion: 3,
    });
  });

  it("rejects a tampered station QR token", () => {
    const service = new StationQrService();
    const token = service.issue("3d20d6e7-5cbe-4fa2-af18-e8d1ab0ddbe6", 1)
      .token;

    expect(() => service.resolve(`${token.slice(0, -1)}x`)).toThrow(
      InvalidStationQrError,
    );
  });

  it("fails closed when the encryption key is missing", () => {
    delete process.env.STATION_QR_ENCRYPTION_KEY;

    expect(() => new StationQrService().issue("station-id", 1)).toThrow(
      "STATION_QR_ENCRYPTION_KEY must be a 64-character hexadecimal key",
    );
  });
});
