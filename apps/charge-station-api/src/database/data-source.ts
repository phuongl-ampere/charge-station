import "reflect-metadata";
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  OneToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from "typeorm";
import { DataSource, type DataSourceOptions } from "typeorm";

import { InitialSchemaMigration } from "./migrations/001-initial-schema.js";
import { AddDeviceCommandRetryAndSessionState } from "./migrations/002-device-command-retry-and-session-state.js";
import { AddDeviceCommandSessionTypeUnique } from "./migrations/003-device-command-session-type-unique.js";
import { AddActiveDeviceCommandSessionTypeUnique } from "./migrations/004-device-command-active-index.js";
import { AddPaymentReservationExpiry } from "./migrations/005-payment-reservation-expiry.js";
import { AddPaymentCancellationState } from "./migrations/006-payment-cancellation-state.js";
import { AddDeviceCommandDispatchClaim } from "./migrations/007-device-command-dispatch-claim.js";
import { AddStationQrVersion } from "./migrations/008-station-qr-version.js";
import { AddStationQrTokens } from "./migrations/010-station-qr-tokens.js";
import { AddDeviceHoldAndRemoveRelaySchedule } from "./migrations/011-device-hold.js";
import { RenameDeviceHoldToDeviceUsage } from "./migrations/012-device-usage.js";
import { MoveUsageStateToManagedDevices } from "./migrations/013-managed-device-availability.js";

export enum UserRole {
  CUSTOMER = "CUSTOMER",
  OPERATOR = "OPERATOR",
  ADMIN = "ADMIN",
}

export enum ConnectorStatus {
  AVAILABLE = "AVAILABLE",
  OCCUPIED = "OCCUPIED",
  OFFLINE = "OFFLINE",
}

export enum OrderStatus {
  PENDING_PAYMENT = "PENDING_PAYMENT",
  PAID = "PAID",
  PAYMENT_FAILED = "PAYMENT_FAILED",
  EXPIRED = "EXPIRED",
  REFUNDED = "REFUNDED",
}

export enum PaymentTransactionStatus {
  PENDING = "PENDING",
  PAID = "PAID",
  FAILED = "FAILED",
  EXPIRED = "EXPIRED",
}

export enum PaymentCancellationStatus {
  NONE = "NONE",
  PENDING = "PENDING",
  CANCELLED = "CANCELLED",
  PROVIDER_EXPIRED = "PROVIDER_EXPIRED",
  PROVIDER_PAID = "PROVIDER_PAID",
  PAID_AFTER_EXPIRY = "PAID_AFTER_EXPIRY",
}

export enum ChargingSessionStatus {
  PENDING = "PENDING",
  STARTING = "STARTING",
  CHARGING = "CHARGING",
  STOPPING = "STOPPING",
  COMPLETED = "COMPLETED",
  CANCELLED = "CANCELLED",
  START_FAILED = "START_FAILED",
  DEVICE_OFFLINE = "DEVICE_OFFLINE",
}

export enum DeviceCommandStatus {
  PENDING = "PENDING",
  DISPATCHING = "DISPATCHING",
  SENT = "SENT",
  ACCEPTED = "ACCEPTED",
  COMPLETED = "COMPLETED",
  FAILED = "FAILED",
}

export enum DeviceAvailability {
  AVAILABLE = "AVAILABLE",
  IN_USE = "IN_USE",
}

@Entity("users")
export class User {
  @PrimaryColumn("uuid")
  id!: string;

  @Column({ type: "varchar", unique: true })
  email!: string;

  @Column({ name: "password_hash", type: "varchar" })
  passwordHash!: string;

  @Column({ type: "varchar", default: UserRole.CUSTOMER })
  role!: UserRole;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}

@Entity("stations")
export class Station {
  @PrimaryColumn("uuid")
  id!: string;

  @Column({ type: "varchar", unique: true })
  code!: string;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ name: "device_id", type: "varchar", nullable: true })
  deviceId!: string | null;

  @Column({ name: "qr_version", type: "integer", default: 1 })
  qrVersion!: number;

  @OneToMany(() => Connector, (connector) => connector.station)
  connectors!: Connector[];

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}

@Entity("managed_devices")
export class ManagedDevice {
  @PrimaryColumn({ name: "device_id", type: "varchar" })
  deviceId!: string;

  @Column({ type: "varchar", default: DeviceAvailability.AVAILABLE })
  availability!: DeviceAvailability;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}

@Entity("station_qr_tokens")
export class StationQrToken {
  @PrimaryColumn("uuid", { name: "station_id" })
  stationId!: string;

  @Column({ name: "qr_version", type: "integer" })
  qrVersion!: number;

  @Column({ name: "token_hash", type: "varchar", length: 64, unique: true })
  tokenHash!: string;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}

@Entity("pricing_plans")
export class PricingPlan {
  @PrimaryColumn("uuid")
  id!: string;

  @Column({ type: "varchar", unique: true })
  name!: string;

  @Column({ name: "hourly_price_vnd", type: "integer" })
  hourlyPriceVnd!: number;

  @Column({ name: "allowed_durations_minutes", type: "integer", array: true })
  allowedDurationsMinutes!: number[];

  @OneToMany(() => Connector, (connector) => connector.pricingPlan)
  connectors!: Connector[];
}

@Entity("connectors")
export class Connector {
  @PrimaryColumn("uuid")
  id!: string;

  @Column({ type: "varchar", unique: true })
  code!: string;

  @Column({ type: "varchar", default: ConnectorStatus.AVAILABLE })
  status!: ConnectorStatus;

  @ManyToOne(() => Station, (station) => station.connectors, { eager: true })
  @JoinColumn({ name: "station_id" })
  station!: Station;

  @ManyToOne(() => PricingPlan, (pricingPlan) => pricingPlan.connectors, {
    nullable: true,
    eager: true,
  })
  @JoinColumn({ name: "pricing_plan_id" })
  pricingPlan!: PricingPlan | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}

@Entity("orders")
export class Order {
  @PrimaryColumn("uuid")
  id!: string;

  @Column({
    name: "payos_order_code",
    type: "bigint",
    unique: true,
    default: "nextval('payos_order_code_seq')",
  })
  payosOrderCode!: string;

  @Column({ name: "duration_minutes", type: "integer" })
  durationMinutes!: number;

  @Column({ name: "amount_vnd", type: "integer" })
  amountVnd!: number;

  @Column({ type: "varchar", length: 3, default: "VND" })
  currency!: string;

  @Column({ type: "varchar", default: OrderStatus.PENDING_PAYMENT })
  status!: OrderStatus;

  @ManyToOne(() => User, { nullable: true, eager: true })
  @JoinColumn({ name: "user_id" })
  user!: User | null;

  @ManyToOne(() => Connector, { eager: true })
  @JoinColumn({ name: "connector_id" })
  connector!: Connector;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}

@Entity("payment_transactions")
export class PaymentTransaction {
  @PrimaryColumn("uuid")
  id!: string;

  @OneToOne(() => Order, { eager: true })
  @JoinColumn({ name: "order_id" })
  order!: Order;

  @Column({ type: "varchar", length: 16, default: "PAYOS" })
  provider!: string;

  @Column({
    name: "payment_link_id",
    type: "varchar",
    unique: true,
    nullable: true,
  })
  paymentLinkId!: string | null;

  @Column({ name: "checkout_url", type: "varchar", nullable: true })
  checkoutUrl!: string | null;

  @Column({ type: "varchar", default: PaymentTransactionStatus.PENDING })
  status!: PaymentTransactionStatus;

  @Column({ name: "expires_at", type: "timestamptz" })
  expiresAt!: Date;

  @Column({ name: "raw_webhook_payload", type: "jsonb", nullable: true })
  rawWebhookPayload!: Record<string, unknown> | null;

  @Column({ name: "signature_valid", type: "boolean", default: false })
  signatureValid!: boolean;

  @Column({
    name: "cancellation_status",
    type: "varchar",
    default: PaymentCancellationStatus.NONE,
  })
  cancellationStatus!: PaymentCancellationStatus;

  @Column({ name: "cancellation_attempts", type: "integer", default: 0 })
  cancellationAttempts!: number;

  @Column({
    name: "cancellation_last_attempt_at",
    type: "timestamptz",
    nullable: true,
  })
  cancellationLastAttemptAt!: Date | null;

  @Column({
    name: "cancellation_next_attempt_at",
    type: "timestamptz",
    nullable: true,
  })
  cancellationNextAttemptAt!: Date | null;

  @Column({ name: "cancellation_last_error", type: "varchar", nullable: true })
  cancellationLastError!: string | null;

  @Column({ name: "cancellation_claim_token", type: "varchar", nullable: true })
  cancellationClaimToken!: string | null;

  @Column({
    name: "cancellation_claimed_at",
    type: "timestamptz",
    nullable: true,
  })
  cancellationClaimedAt!: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}

@Entity("charging_sessions")
export class ChargingSession {
  @PrimaryColumn("uuid")
  id!: string;

  @OneToOne(() => Order, { eager: true })
  @JoinColumn({ name: "order_id" })
  order!: Order;

  @ManyToOne(() => Connector, { eager: true })
  @JoinColumn({ name: "connector_id" })
  connector!: Connector;

  @Column({ type: "varchar", default: ChargingSessionStatus.PENDING })
  status!: ChargingSessionStatus;

  @Column({ name: "started_at", type: "timestamptz", nullable: true })
  startedAt!: Date | null;

  @Column({ name: "expected_end_at", type: "timestamptz", nullable: true })
  expectedEndAt!: Date | null;

  @Column({ name: "stopped_at", type: "timestamptz", nullable: true })
  stoppedAt!: Date | null;

  @Column({
    name: "estimated_remaining_seconds",
    type: "integer",
    nullable: true,
  })
  estimatedRemainingSeconds!: number | null;

  @Column({ name: "last_device_event_at", type: "timestamptz", nullable: true })
  lastDeviceEventAt!: Date | null;

  @Column({ name: "operational_warning", type: "varchar", nullable: true })
  operationalWarning!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}

@Entity("device_commands")
@Index(
  "uq_device_commands_active_session_command_type",
  ["session", "commandType"],
  {
    unique: true,
    where: `"status" IN ('PENDING', 'DISPATCHING', 'SENT', 'ACCEPTED')`,
  },
)
export class DeviceCommand {
  @PrimaryColumn("uuid")
  id!: string;

  @Column({ name: "command_id", type: "varchar", unique: true })
  commandId!: string;

  @ManyToOne(() => ChargingSession, { eager: true })
  @JoinColumn({ name: "session_id" })
  session!: ChargingSession;

  @Column({ name: "command_type", type: "varchar", length: 32 })
  commandType!: string;

  @Column({ type: "jsonb" })
  payload!: Record<string, unknown>;

  @Column({ name: "retry_count", type: "integer", default: 0 })
  retryCount!: number;

  @Column({ name: "next_attempt_at", type: "timestamptz", nullable: true })
  nextAttemptAt!: Date | null;

  @Column({ type: "varchar", default: DeviceCommandStatus.PENDING })
  status!: DeviceCommandStatus;

  @Column({ name: "acknowledged_at", type: "timestamptz", nullable: true })
  acknowledgedAt!: Date | null;

  @Column({ name: "dispatch_claim_token", type: "varchar", nullable: true })
  dispatchClaimToken!: string | null;

  @Column({
    name: "dispatch_claimed_at",
    type: "timestamptz",
    nullable: true,
  })
  dispatchClaimedAt!: Date | null;

  @Column({ name: "dispatch_version", type: "integer", default: 0 })
  dispatchVersion!: number;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}

@Entity("device_events")
export class DeviceEvent {
  @PrimaryColumn("uuid")
  id!: string;

  @Column({ name: "event_id", type: "varchar", unique: true })
  eventId!: string;

  @ManyToOne(() => ChargingSession, { nullable: true, eager: true })
  @JoinColumn({ name: "session_id" })
  session!: ChargingSession | null;

  @ManyToOne(() => DeviceCommand, { nullable: true, eager: true })
  @JoinColumn({ name: "command_id" })
  command!: DeviceCommand | null;

  @Column({ name: "device_id", type: "varchar" })
  deviceId!: string;

  @Column({ name: "connector_code", type: "varchar" })
  connectorCode!: string;

  @Column({ name: "event_type", type: "varchar", length: 32 })
  eventType!: string;

  @Column({ name: "occurred_at", type: "timestamptz" })
  occurredAt!: Date;

  @Column({ type: "jsonb" })
  payload!: Record<string, unknown>;

  @Column({ name: "processed_at", type: "timestamptz", nullable: true })
  processedAt!: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}

export const entities = [
  User,
  Station,
  ManagedDevice,
  StationQrToken,
  PricingPlan,
  Connector,
  Order,
  PaymentTransaction,
  ChargingSession,
  DeviceCommand,
  DeviceEvent,
];

export const migrations = [
  InitialSchemaMigration,
  AddDeviceCommandRetryAndSessionState,
  AddDeviceCommandSessionTypeUnique,
  AddActiveDeviceCommandSessionTypeUnique,
  AddPaymentReservationExpiry,
  AddPaymentCancellationState,
  AddDeviceCommandDispatchClaim,
  AddStationQrVersion,
  AddStationQrTokens,
  AddDeviceHoldAndRemoveRelaySchedule,
  RenameDeviceHoldToDeviceUsage,
  MoveUsageStateToManagedDevices,
];

export const databaseOptions: DataSourceOptions = {
  type: "postgres",
  url:
    process.env.DATABASE_URL ??
    "postgres://charge:charge@localhost:5432/charge_station",
  entities,
  migrations,
  migrationsRun: true,
  synchronize: false,
};

export const appDataSource = new DataSource(databaseOptions);
