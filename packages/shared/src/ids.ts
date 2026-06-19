import { randomUUID } from 'crypto';

export function generateId(prefix?: string): string {
  const uuid = randomUUID();
  return prefix ? `${prefix}_${uuid.replace(/-/g, '')}` : uuid;
}
