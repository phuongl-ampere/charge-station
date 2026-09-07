import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';
import { configureHttpApp } from './http-app.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  configureHttpApp(app);
  await app.listen(Number(process.env.PORT ?? 4000));
}

void bootstrap();
