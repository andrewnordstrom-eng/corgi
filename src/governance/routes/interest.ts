/** Public contact intake. This never creates a pilot approval or research consent. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { logger } from '../../lib/logger.js';

const HANDLE_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;
const InterestSchema = z.object({
  email: z.string().trim().max(254).email().transform((value) => value.toLowerCase()),
  handle: z.string().trim().max(254).transform((value) => value.replace(/^@/, '').toLowerCase())
    .refine((value) => value === '' || (value.length <= 253 && HANDLE_RE.test(value))).optional(),
  interests: z.array(z.enum(['use', 'build', 'research', 'updates'])).min(1).max(4)
    .refine((values) => new Set(values).size === values.length),
  note: z.string().trim().max(500).optional(),
  contactConsent: z.literal(true),
  website: z.string().max(500).optional(),
}).strict();

const SUCCESS = { success: true, message: 'Thanks—your interest is recorded. We may contact you about the interests you selected.' } as const;

export function registerInterestRoute(app: FastifyInstance): void {
  app.post('/api/interest', { bodyLimit: 4096 }, async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = InterestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'ValidationError', message: 'Check your email, optional handle, interests and contact permission.' });
    }
    const { email, handle, interests, note, website } = parsed.data;
    // Identical response avoids teaching simple form-fill bots about this trap.
    if (website) return reply.send(SUCCESS);
    try {
      await db.query(
        `INSERT INTO contact_interest (email, handle, interests, note, consent_version)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (email) DO NOTHING`,
        [email, handle || null, interests, note || null, 'contact-interest-v1']
      );
      return reply.send(SUCCESS);
    } catch {
      // Database errors may contain submitted values; never log the raw error/body.
      logger.error({ requestId: request.id }, 'Contact interest storage failed');
      return reply.code(503).send({ error: 'ServiceUnavailable', message: 'Could not save your interest. Please try again later.' });
    }
  });
}
