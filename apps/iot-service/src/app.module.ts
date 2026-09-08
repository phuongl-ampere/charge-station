import { Module } from "@nestjs/common";

import { ServiceTokenGuard } from "./common/service-token.guard.js";
import { CommandsController } from "./commands/commands.controller.js";
import { CommandsService } from "./commands/commands.service.js";
import { DeviceStateService } from "./devices/device-state.service.js";
import { ChargeStationEventClient } from "./events/charge-station-event.client.js";
import { EventJournalService } from "./events/event-journal.service.js";
import { HealthController } from "./health.controller.js";

@Module({
  controllers: [CommandsController, HealthController],
  providers: [
    CommandsService,
    DeviceStateService,
    ChargeStationEventClient,
    EventJournalService,
    ServiceTokenGuard,
  ],
})
export class AppModule {}
