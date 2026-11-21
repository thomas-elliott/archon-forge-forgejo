/** Forgejo users projected as forge actors. */

import type { SourceActor } from '@archon/forge';
import { z } from 'zod';

export const userSchema = z.object({ id: z.number().int(), login: z.string().min(1) }).nullable();
type User = z.infer<typeof userSchema>;

export function actor(host: string, user: User): SourceActor | null {
  return user ? { host, id: String(user.id), login: user.login } : null;
}

/** A response without `user` reports no author rather than claiming the forge has none. */
export function authorField(host: string, user: User | undefined): { author?: SourceActor | null } {
  return user === undefined ? {} : { author: actor(host, user) };
}
