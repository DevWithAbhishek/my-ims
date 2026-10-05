import { z } from 'zod';

export const emailSchema = z
  .email()
  .max(72)
  .transform((email) => email.toLowerCase());

export const passwordSchema = z.string().min(8).max(24);

export const loginBodySchema = z.object({ email: emailSchema, password: passwordSchema }).strict();

export type LoginBody = z.output<typeof loginBodySchema>;
