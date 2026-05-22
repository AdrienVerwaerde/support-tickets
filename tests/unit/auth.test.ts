import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import { hashPassword, verifyPassword, signToken, verifyToken, getAuthFromRequest } from '@/lib/auth';
import { NextRequest } from 'next/server';

describe('auth.ts — password hashing', () => {
  it('hashes a password to a non-equal string', async () => {
    const hash = await hashPassword('Password123!');
    expect(hash).not.toBe('Password123!');
    expect(hash.length).toBeGreaterThan(20);
  });

  it('verifies a correct password', async () => {
    const hash = await hashPassword('MySecret42');
    expect(await verifyPassword('MySecret42', hash)).toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('MySecret42');
    expect(await verifyPassword('Wrong', hash)).toBe(false);
  });
});

describe('auth.ts — JWT', () => {
  it('signs and verifies a token', () => {
    const payload = { userId: 'abc', email: 'test@example.io', role: 'USER' };
    const token = signToken(payload);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const decoded = verifyToken(token);
    expect(decoded).not.toBeNull();
    expect(decoded?.userId).toBe('abc');
    expect(decoded?.email).toBe('test@example.io');
    expect(decoded?.role).toBe('USER');
  });

  it('returns null for a tampered token', () => {
    const token = signToken({ userId: 'x', email: 'y@example.com', role: 'USER' });
    expect(verifyToken(token + 'tampered')).toBeNull();
  });

  it('returns null for an invalid token format', () => {
    expect(verifyToken('not-a-token')).toBeNull();
  });

  it('returns null for an expired token', () => {
    const secret = process.env.JWT_SECRET || 'fallback-secret-change-me';
    const expired = jwt.sign(
      { userId: 'abc', email: 'test@example.io', role: 'USER', exp: Math.floor(Date.now() / 1000) - 3600 },
      secret,
    );
    expect(verifyToken(expired)).toBeNull();
  });
});

describe('auth.ts — getAuthFromRequest', () => {
  it('extracts the payload from a valid Bearer token', () => {
    const token = signToken({ userId: 'u1', email: 'a@b.io', role: 'USER' });
    const req = new NextRequest('http://localhost/api/test', {
      headers: { authorization: `Bearer ${token}` },
    });
    const payload = getAuthFromRequest(req);
    expect(payload?.userId).toBe('u1');
  });

  it('returns null when Authorization header is missing', () => {
    const req = new NextRequest('http://localhost/api/test');
    expect(getAuthFromRequest(req)).toBeNull();
  });

  it('returns null when the scheme is not Bearer', () => {
    const token = signToken({ userId: 'u1', email: 'a@b.io', role: 'USER' });
    const req = new NextRequest('http://localhost/api/test', {
      headers: { authorization: `Basic ${token}` },
    });
    expect(getAuthFromRequest(req)).toBeNull();
  });
});
