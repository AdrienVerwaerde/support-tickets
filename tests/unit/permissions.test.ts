import { describe, it, expect } from 'vitest';
import { canEditTicket } from '@/lib/permissions';

const ticket = { authorId: 'user-1' };

describe('permissions — canEditTicket', () => {
  it('allows ADMIN to edit any ticket', () => {
    expect(canEditTicket({ id: 'admin-1', role: 'ADMIN' }, ticket)).toBe(true);
  });

  it('allows AGENT to edit any ticket', () => {
    expect(canEditTicket({ id: 'agent-1', role: 'AGENT' }, ticket)).toBe(true);
  });

  it('allows USER to edit their own ticket', () => {
    expect(canEditTicket({ id: 'user-1', role: 'USER' }, ticket)).toBe(true);
  });

  it('denies USER editing another user ticket', () => {
    expect(canEditTicket({ id: 'user-2', role: 'USER' }, ticket)).toBe(false);
  });
});
