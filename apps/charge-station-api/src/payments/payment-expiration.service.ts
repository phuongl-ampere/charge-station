import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
} from "@nestjs/common";

import { PaymentsService } from "./payments.service.js";

const DEFAULT_PAYMENT_REAPER_INTERVAL_MS = 60_000;

interface PaymentExpiryRunner {
  expireDueReservations(): Promise<number>;
}

@Injectable()
export class PaymentExpirationService implements OnApplicationShutdown {
  private readonly logger = new Logger(PaymentExpirationService.name);
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    @Inject(PaymentsService)
    private readonly paymentsService: PaymentExpiryRunner,
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }

    void this.expireDueReservations();
    this.timer = setInterval(() => {
      void this.expireDueReservations();
    }, paymentReaperIntervalMs());
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  onApplicationShutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async expireDueReservations(): Promise<void> {
    try {
      await this.paymentsService.expireDueReservations();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Unable to expire payment reservations: ${message}`);
    }
  }
}

function paymentReaperIntervalMs(): number {
  const configuredInterval = Number(process.env.PAYMENT_REAPER_INTERVAL_MS);
  return Number.isFinite(configuredInterval) && configuredInterval > 0
    ? configuredInterval
    : DEFAULT_PAYMENT_REAPER_INTERVAL_MS;
}
