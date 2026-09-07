import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';

export function configureHttpApp(app: INestApplication): void {
  app.enableCors({
    origin: process.env.FRONTEND_URL ?? 'http://localhost:3000',
  });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
}
