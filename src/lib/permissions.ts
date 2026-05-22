export interface PermUser {
  id: string;
  role: string;
}

export interface PermTicket {
  authorId: string;
  assigneeId?: string | null;
}

export function canEditTicket(user: PermUser, ticket: PermTicket): boolean {
  if (user.role === 'ADMIN' || user.role === 'AGENT') return true;
  return ticket.authorId === user.id;
}
