import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { createHash, createHmac } from "node:crypto";
import type { EntityManager, Repository } from "typeorm";

import { StationQrToken } from "../database/data-source.js";

const TOKEN_BYTES = 24;
const TOKEN_DOMAIN = "charge-station:station-qr:v2";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const STATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidStationQrError extends Error {
  constructor() {
    super("Station QR is invalid or no longer active");
    this.name = InvalidStationQrError.name;
  }
}

export interface StationQrPayload {
  stationId: string;
  qrVersion: number;
}

@Injectable()
export class StationQrService {
  constructor(
    @InjectRepository(StationQrToken)
    private readonly tokenRepository: Repository<StationQrToken>,
  ) {}

  async issue(
    stationId: string,
    qrVersion: number,
    manager?: EntityManager,
  ): Promise<{ token: string; url: string }> {
    const key = readStationQrEncryptionKey();
    const payload = validatePayload({ stationId, qrVersion });
    const token = createHmac("sha256", key)
      .update(TOKEN_DOMAIN)
      .update("\0")
      .update(payload.stationId)
      .update("\0")
      .update(String(payload.qrVersion))
      .digest()
      .subarray(0, TOKEN_BYTES)
      .toString("base64url");

    const tokenRepository =
      manager?.getRepository(StationQrToken) ?? this.tokenRepository;
    await tokenRepository.upsert(
      {
        stationId: payload.stationId,
        qrVersion: payload.qrVersion,
        tokenHash: tokenHash(token),
      },
      ["stationId"],
    );

    const frontendUrl = new URL(
      process.env.FRONTEND_URL?.trim() || "http://localhost:3100",
    );
    return {
      token,
      url: new URL(`/scan/station/${token}`, frontendUrl.origin).toString(),
    };
  }

  async resolve(token: string): Promise<StationQrPayload> {
    if (
      !TOKEN_PATTERN.test(token) ||
      Buffer.from(token, "base64url").length !== TOKEN_BYTES
    ) {
      throw new InvalidStationQrError();
    }
    const record = await this.tokenRepository.findOneBy({
      tokenHash: tokenHash(token),
    });
    if (!record) {
      throw new InvalidStationQrError();
    }
    return validatePayload(record);
  }
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function readStationQrEncryptionKey(): Buffer {
  const value = process.env.STATION_QR_ENCRYPTION_KEY?.trim();
  if (!value || !/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error(
      "STATION_QR_ENCRYPTION_KEY must be a 64-character hexadecimal key",
    );
  }
  return Buffer.from(value, "hex");
}

function validatePayload(value: unknown): StationQrPayload {
  if (
    !isRecord(value) ||
    typeof value.stationId !== "string" ||
    !STATION_ID_PATTERN.test(value.stationId) ||
    typeof value.qrVersion !== "number" ||
    !Number.isInteger(value.qrVersion) ||
    value.qrVersion < 1
  ) {
    throw new InvalidStationQrError();
  }
  return { stationId: value.stationId, qrVersion: value.qrVersion };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
