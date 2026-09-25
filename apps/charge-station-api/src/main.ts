import "reflect-metadata";
import { NestFactory } from "@nestjs/core";

import { AppModule } from "./app.module.js";
import { configureHttpApp } from "./http-app.js";
import { CommandDispatcherService } from "./iot/command-dispatcher.service.js";
import { CoreTelemetryMonitor } from "./iot/core-telemetry-monitor.service.js";
import { PaymentExpirationService } from "./payments/payment-expiration.service.js";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  configureHttpApp(app);
  await app.listen(Number(process.env.PORT ?? 4000));
  app.get(CommandDispatcherService).dispatchPendingAfterReady();
  app.get(CoreTelemetryMonitor).start();
  app.get(PaymentExpirationService).start();
}

void bootstrap();
