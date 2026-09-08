import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  Inject,
  Injectable,
  Optional,
  type OnModuleDestroy,
} from "@nestjs/common";
import type { DeviceEvent } from "@charge-station/contracts";

const JOURNAL_VERSION = 1;
export const IOT_EVENT_JOURNAL_PATH = Symbol("IOT_EVENT_JOURNAL_PATH");

export interface JournalRecord {
  event: DeviceEvent;
  sequence: number;
  retryCount: number;
  delivered: boolean;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
}

interface EventJournalFile {
  version: number;
  records: JournalRecord[];
}

@Injectable()
export class EventJournalService implements OnModuleDestroy {
  private readonly path: string;
  private records: JournalRecord[] = [];
  private initialized = false;

  constructor(
    @Optional()
    @Inject(IOT_EVENT_JOURNAL_PATH)
    path?: string,
  ) {
    this.path = path ?? journalPath();
  }

  initialize(): JournalRecord[] {
    if (!this.initialized) {
      this.load();
    }
    return this.getUndelivered();
  }

  append(event: DeviceEvent): JournalRecord {
    this.initialize();
    return this.mutate(() => {
      const existing = this.records.find(
        (record) => record.event.eventId === event.eventId,
      );
      if (existing) {
        return cloneRecord(existing);
      }

      const record: JournalRecord = {
        event: structuredClone(event),
        sequence: this.nextSequence(),
        retryCount: 0,
        delivered: false,
        nextAttemptAt: null,
        deliveredAt: null,
      };
      this.records.push(record);
      return cloneRecord(record);
    });
  }

  recordRetry(
    eventId: string,
    retryCount: number,
    nextAttemptAt: Date,
  ): JournalRecord | undefined {
    this.initialize();
    return this.mutate(() => {
      const record = this.records.find(
        (candidate) => candidate.event.eventId === eventId,
      );
      if (!record || record.delivered) {
        return undefined;
      }

      record.retryCount = retryCount;
      record.nextAttemptAt = nextAttemptAt.toISOString();
      return cloneRecord(record);
    });
  }

  markDelivered(eventId: string): JournalRecord | undefined {
    this.initialize();
    return this.mutate(() => {
      const record = this.records.find(
        (candidate) => candidate.event.eventId === eventId,
      );
      if (!record || record.delivered) {
        return record ? cloneRecord(record) : undefined;
      }

      record.delivered = true;
      record.deliveredAt = new Date().toISOString();
      return cloneRecord(record);
    });
  }

  getUndelivered(): JournalRecord[] {
    return this.records
      .filter((record) => !record.delivered)
      .sort((left, right) => left.sequence - right.sequence)
      .map(cloneRecord);
  }

  getRecords(): JournalRecord[] {
    this.initialize();
    return this.records
      .sort((left, right) => left.sequence - right.sequence)
      .map(cloneRecord);
  }

  onModuleDestroy(): void {}

  private load(): void {
    let source: string;
    try {
      source = readFileSync(this.path, "utf8");
    } catch (error: unknown) {
      if (isMissingFile(error)) {
        this.initialized = true;
        return;
      }
      throw error;
    }

    const parsed = parseJournal(source, this.path);
    this.records = parsed.records.sort((left, right) => left.sequence - right.sequence);
    this.initialized = true;
  }

  private mutate<T>(mutator: () => T): T {
    const result = mutator();
    this.persist();
    return result;
  }

  private nextSequence(): number {
    return (this.records.at(-1)?.sequence ?? 0) + 1;
  }

  private persist(): void {
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true });
    const temporaryPath = join(
      directory,
      `.${randomUUID()}.iot-event-journal.tmp`,
    );
    const content = JSON.stringify(
      {
        version: JOURNAL_VERSION,
        records: this.records,
      } satisfies EventJournalFile,
      null,
      2,
    );
    writeFileSync(temporaryPath, content, "utf8");
    renameSync(temporaryPath, this.path);
  }
}

function journalPath(): string {
  return (
    process.env.IOT_EVENT_JOURNAL_PATH ??
    join(process.cwd(), "data", "iot-event-journal.json")
  );
}

function parseJournal(source: string, path: string): EventJournalFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error(`IoT event journal is not valid JSON: ${path}`);
  }

  if (!isRecord(parsed) || parsed.version !== JOURNAL_VERSION || !Array.isArray(parsed.records)) {
    throw new Error(`IoT event journal has an unsupported format: ${path}`);
  }

  const records = parsed.records.map((record, index) =>
    parseRecord(record, path, index),
  );
  const eventIds = new Set(records.map((record) => record.event.eventId));
  const sequences = new Set(records.map((record) => record.sequence));
  if (eventIds.size !== records.length || sequences.size !== records.length) {
    throw new Error(`IoT event journal contains duplicate records: ${path}`);
  }
  return { version: JOURNAL_VERSION, records };
}

function parseRecord(value: unknown, path: string, index: number): JournalRecord {
  if (
    !isRecord(value) ||
    !isPositiveSafeInteger(value.sequence) ||
    !isNonnegativeSafeInteger(value.retryCount) ||
    typeof value.delivered !== "boolean" ||
    !isNullableString(value.nextAttemptAt) ||
    !isNullableString(value.deliveredAt) ||
    !isDeviceEvent(value.event)
  ) {
    throw new Error(`IoT event journal record ${index} is invalid: ${path}`);
  }
  return {
    event: structuredClone(value.event),
    sequence: value.sequence,
    retryCount: value.retryCount,
    delivered: value.delivered,
    nextAttemptAt: value.nextAttemptAt,
    deliveredAt: value.deliveredAt,
  };
}

function isDeviceEvent(value: unknown): value is DeviceEvent {
  return (
    isRecord(value) &&
    typeof value.eventId === "string" &&
    typeof value.commandId === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.deviceId === "string" &&
    typeof value.connectorCode === "string" &&
    typeof value.type === "string" &&
    typeof value.occurredAt === "string" &&
    isRecord(value.payload)
  );
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneRecord(record: JournalRecord): JournalRecord {
  return structuredClone(record);
}
