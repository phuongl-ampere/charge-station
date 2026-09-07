export type ChargingStatus =
  | 'PENDING'
  | 'STARTING'
  | 'CHARGING'
  | 'STOPPING'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'START_FAILED'
  | 'DEVICE_OFFLINE';

export type DeviceCommandType = 'START_CHARGING' | 'STOP_CHARGING';

export type DeviceEventType =
  | 'COMMAND_ACCEPTED'
  | 'RUNNING'
  | 'HEARTBEAT'
  | 'STOPPED'
  | 'COMMAND_FAILED'
  | 'DEVICE_OFFLINE';

export interface StartChargingCommand {
  commandId: string;
  sessionId: string;
  stationCode: string;
  connectorCode: string;
  durationSeconds: number;
  expiresAt: string;
  configVersion: number;
}

export interface StopChargingCommand {
  commandId: string;
  sessionId: string;
  reason: 'USER_REQUESTED' | 'SYSTEM_REQUESTED';
}

export interface DeviceEvent {
  eventId: string;
  commandId: string;
  sessionId: string;
  deviceId: string;
  connectorCode: string;
  type: DeviceEventType;
  occurredAt: string;
  payload: Record<string, unknown>;
}
