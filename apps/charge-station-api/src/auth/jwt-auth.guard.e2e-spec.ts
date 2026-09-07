import { Controller, Get, UseGuards } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Repository } from 'typeorm';

import { User } from '../database/data-source.js';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';

process.env.JWT_SECRET = 'test-only-jwt-secret';
const testAuthService = new AuthService({} as Repository<User>);
const testAuthGuard = new JwtAuthGuard(testAuthService);

@Controller('protected')
class ProtectedTestController {
  @Get()
  @UseGuards(testAuthGuard)
  getProtectedResource() {
    return { ok: true };
  }
}

describe('JwtAuthGuard HTTP errors', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ProtectedTestController],
    }).compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    delete process.env.JWT_SECRET;
    await app.close();
  });

  it('maps malformed JWTs to HTTP 401', async () => {
    await request(app.getHttpServer())
      .get('/protected')
      .set('Authorization', 'Bearer not-a-jwt')
      .expect(401);
  });

  it('maps expired JWTs to HTTP 401', async () => {
    const expiredToken = jwt.sign(
      { sub: 'user-1', role: 'CUSTOMER' },
      'test-only-jwt-secret',
      { expiresIn: -1 },
    );

    await request(app.getHttpServer())
      .get('/protected')
      .set('Authorization', `Bearer ${expiredToken}`)
      .expect(401);
  });
});
