import { Injectable } from "@nestjs/common";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const TOKEN_VERSION = 1;
const INITIALIZATION_VECTOR_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const AAD = Buffer.from("charge-station:station-qr:v1", "utf8");
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
  issue(stationId: string, qrVersion: number): {
    token: string;
    url: string;
  } {
    const key = readStationQrEncryptionKey();
    const payload = validatePayload({ stationId, qrVersion });
    const initializationVector = randomBytes(INITIALIZATION_VECTOR_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, initializationVector, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    cipher.setAAD(AAD);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(payload), "utf8"),
      cipher.final(),
    ]);
    const token = Buffer.concat([
      Buffer.from([TOKEN_VERSION]),
      initializationVector,
      cipher.getAuthTag(),
      encrypted,
    ]).toString("base64url");
    const frontendUrl = new URL(
      process.env.FRONTEND_URL?.trim() || "http://localhost:3100",
    );

    return {
      token,
      url: new URL(`/scan/station/${token}`, frontendUrl.origin).toString(),
    };
  }

  resolve(token: string): StationQrPayload {
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(token)) {
        throw new InvalidStationQrError();
      }
      const tokenBuffer = Buffer.from(token, "base64url");
      const minimumLength =
        1 + INITIALIZATION_VECTOR_LENGTH + AUTH_TAG_LENGTH + 1;
      if (
        tokenBuffer.length < minimumLength ||
        tokenBuffer[0] !== TOKEN_VERSION
      ) {
        throw new InvalidStationQrError();
      }
      const initializationVector = tokenBuffer.subarray(
        1,
        1 + INITIALIZATION_VECTOR_LENGTH,
      );
      const tagStart = 1 + INITIALIZATION_VECTOR_LENGTH;
      const authTag = tokenBuffer.subarray(tagStart, tagStart + AUTH_TAG_LENGTH);
      const ciphertext = tokenBuffer.subarray(tagStart + AUTH_TAG_LENGTH);
      const decipher = createDecipheriv(
        ALGORITHM,
        readStationQrEncryptionKey(),
        initializationVector,
        { authTagLength: AUTH_TAG_LENGTH },
      );
      decipher.setAAD(AAD);
      decipher.setAuthTag(authTag);
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString("utf8");
      return validatePayload(JSON.parse(plaintext));
    } catch (error) {
      if (error instanceof InvalidStationQrError) {
        throw error;
      }
      throw new InvalidStationQrError();
    }
  }
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
  return {
    stationId: value.stationId,
    qrVersion: value.qrVersion,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
