import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import {
  ChargingSession,
  Connector,
  DeviceCommand,
  DeviceEvent,
} from "../database/data-source.js";
import { CommandDispatcherService } from "./command-dispatcher.service.js";
import { CoreTelemetryMonitor } from "./core-telemetry-monitor.service.js";
import { DeviceEventsService } from "./device-events.service.js";
import { CoreIotClient } from "./core-iot.client.js";
import { RealtimeModule } from "../realtime/realtime.module.js";

@Module({
  imports: [
    RealtimeModule,
    TypeOrmModule.forFeature([
      ChargingSession,
      Connector,
      DeviceCommand,
      DeviceEvent,
    ]),
  ],
  providers: [
    CommandDispatcherService,
    CoreTelemetryMonitor,
    DeviceEventsService,
    CoreIotClient,
  ],
  exports: [CommandDispatcherService, CoreIotClient],
})
export class IotModule {}
