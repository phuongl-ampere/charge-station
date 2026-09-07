import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { Repository } from 'typeorm';

import { User, UserRole } from '../database/data-source.js';

export interface AuthTokenPayload {
  sub: string;
  role: UserRole;
}

export interface CredentialsInput {
  email: string;
  password: string;
}

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET?.trim();
  if (!secret) {
    throw new Error('JWT_SECRET must be set');
  }

  return secret;
}

@Injectable()
export class AuthService {
  private readonly jwtSecret: string;

  constructor(
    @InjectRepository(User)
    private readonly repository: Repository<User>,
  ) {
    this.jwtSecret = getJwtSecret();
  }

  async register(input: CredentialsInput): Promise<{ accessToken: string }> {
    const { email, password } = this.validateCredentials(input);
    const existingUser = await this.repository.findOneBy({ email });
    if (existingUser) {
      throw new ConflictException('Email is already registered');
    }

    const user = this.repository.create({
      id: randomUUID(),
      email,
      passwordHash: await bcrypt.hash(password, 12),
      role: UserRole.CUSTOMER,
    });
    const savedUser = await this.repository.save(user);

    return { accessToken: this.issueToken(savedUser) };
  }

  async login(input: CredentialsInput): Promise<{ accessToken: string }> {
    const { email, password } = this.validateCredentials(input);
    const user = await this.repository.findOneBy({ email });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return { accessToken: this.issueToken(user) };
  }

  verifyToken(token: string): AuthTokenPayload {
    try {
      const payload = jwt.verify(token, this.jwtSecret);
      if (
        typeof payload === 'string' ||
        typeof payload.sub !== 'string' ||
        typeof payload.role !== 'string'
      ) {
        throw new UnauthorizedException('Invalid token');
      }

      return {
        sub: payload.sub,
        role: payload.role as UserRole,
      };
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }

      throw new UnauthorizedException('Invalid token');
    }
  }

  private issueToken(user: User): string {
    const payload: AuthTokenPayload = { sub: user.id, role: user.role };
    return jwt.sign(payload, this.jwtSecret, { expiresIn: '1h' });
  }

  private validateCredentials(input: CredentialsInput): CredentialsInput {
    if (
      !input ||
      typeof input.email !== 'string' ||
      typeof input.password !== 'string' ||
      !input.email.trim() ||
      !input.password
    ) {
      throw new BadRequestException('Email and password are required');
    }

    return {
      email: input.email.trim().toLowerCase(),
      password: input.password,
    };
  }
}
