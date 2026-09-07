import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import {
  ChargingSession,
  Connector,
  DeviceCommand,
  DeviceEvent,
} from "../database/data-source.js";
import { CommandDispatcherService } from "./command-dispatcher.service.js";
import {
  DeviceEventsController,
  ServiceTokenGuard,
} from "./device-events.controller.js";
import { DeviceEventsService } from "./device-events.service.js";
import { IotServiceClient } from "./iot-service.client.js";
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
  controllers: [DeviceEventsController],
  providers: [
    CommandDispatcherService,
    DeviceEventsService,
    IotServiceClient,
    ServiceTokenGuard,
  ],
  exports: [CommandDispatcherService],
})
export class IotModule {}
