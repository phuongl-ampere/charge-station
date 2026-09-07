import { Body, Controller, Inject, Post, UseGuards } from "@nestjs/common";
import type {
  StartChargingCommand,
  StopChargingCommand,
} from "@charge-station/contracts";

import { ServiceTokenGuard } from "../common/service-token.guard.js";
import { CommandsService } from "./commands.service.js";

@Controller("internal/commands")
@UseGuards(ServiceTokenGuard)
export class CommandsController {
  constructor(
    @Inject(CommandsService) private readonly commandsService: CommandsService,
  ) {}

  @Post("start")
  start(@Body() command: StartChargingCommand) {
    return this.commandsService.start(command);
  }

  @Post("stop")
  stop(@Body() command: StopChargingCommand) {
    return this.commandsService.stop(command);
  }
}
