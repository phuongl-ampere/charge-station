import { describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { Repository } from 'typeorm';

import { User, UserRole } from '../database/data-source.js';
import { AuthService } from './auth.service.js';

describe('AuthService', () => {
  it('rejects blank registration credentials', async () => {
    const repository = {
      findOneBy: vi.fn().mockResolvedValue(null),
      create: vi.fn((user: User) => user),
      save: vi.fn().mockResolvedValue({
        id: 'user-1',
        email: 'user@example.com',
        passwordHash: 'hashed',
        role: UserRole.CUSTOMER,
      }),
    } as unknown as Repository<User>;
    const service = new AuthService(repository);

    await expect(service.register({ email: '  ', password: '' })).rejects.toThrow(
      'Email and password are required',
    );
  });

  it('hashes the password and puts a stable subject and role in the JWT', async () => {
    const savedUser = {
      id: 'user-1',
      email: 'user@example.com',
      passwordHash: 'hashed',
      role: UserRole.CUSTOMER,
    };
    const repository = {
      findOneBy: vi.fn().mockResolvedValue(null),
      create: vi.fn((user: User) => user),
      save: vi.fn().mockResolvedValue(savedUser),
    } as unknown as Repository<User>;
    const service = new AuthService(repository);

    const result = await service.register({
      email: 'USER@example.com',
      password: 'correct horse battery staple',
    });
    const savedInput = (repository.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const payload = jwt.decode(result.accessToken) as { sub: string; role: UserRole };

    expect(savedInput.email).toBe('user@example.com');
    expect(savedInput.passwordHash).not.toBe('correct horse battery staple');
    await expect(
      bcrypt.compare('correct horse battery staple', savedInput.passwordHash),
    ).resolves.toBe(true);
    expect(payload).toMatchObject({ sub: 'user-1', role: UserRole.CUSTOMER });
  });
});
