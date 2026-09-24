import { createHash } from 'node:crypto';
import appleSignin from 'apple-signin-auth';
import { Router } from 'express';
import { OAuth2Client, type TokenPayload } from 'google-auth-library';
import { z } from 'zod';
import type { AppDeps } from '../lib/deps.js';
import { AppError, unavailable } from '../lib/errors.js';
import { emailSchema, handleSchema, passwordSchema } from '../lib/schemas.js';
import { currentSession, currentUser, requireAuth } from '../middleware/auth.js';
import { createRateLimiters } from '../middleware/rateLimits.js';
import { getValidated, validate } from '../middleware/validate.js';
import { CLIENTS, type Types } from '../models/index.js';
import {
  loginWithPassword,
  registerWithPassword,
  signInWithProvider,
  toPrivateUser,
} from '../services/auth.js';
import { consumeMagicLink, issueMagicLink } from '../services/magicLink.js';
import { createSession, revokeSession } from '../services/sessions.js';

const clientField = z.enum(CLIENTS).default('web');
type Client = z.infer<typeof clientField>;

const registerBody = z.object({
  email: emailSchema,
  password: passwordSchema,
  handle: handleSchema,
  client: clientField,
});

const loginBody = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
  client: clientField,
});

const magicLinkBody = z.object({ email: emailSchema });

const magicLinkVerifyBody = z.object({
  token: z.string().min(20).max(200),
  client: clientField,
});

const appleBody = z.object({
  identityToken: z.string().min(20).max(8192),
  nonce: z.string().min(8).max(256),
  client: clientField,
});

const googleBody = z.object({
  idToken: z.string().min(20).max(8192),
  client: clientField,
});

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function providerTokenRejected(): AppError {
  return new AppError(401, 'invalid_provider_token', 'The sign-in token could not be verified.');
}

/** Email/password, magic link, Apple and Google sign-in, all issuing the same opaque session. */
export function authRouter(deps: AppDeps): Router {
  const router = Router();
  const { env } = deps;
  const limits = createRateLimiters(env);
  const googleClient = new OAuth2Client();

  async function issueToken(userId: Types.ObjectId, client: Client): Promise<string> {
    const { token } = await createSession(userId, client, env.SESSION_TTL_DAYS);
    return token;
  }

  router.post('/register', limits.auth, validate({ body: registerBody }), async (req, res) => {
    const { body } = getValidated<{ body: z.infer<typeof registerBody> }>(req);
    const user = await registerWithPassword(body);
    const token = await issueToken(user._id, body.client);
    res.status(201).json({ token, user: toPrivateUser(user) });
  });

  router.post('/login', limits.auth, validate({ body: loginBody }), async (req, res) => {
    const { body } = getValidated<{ body: z.infer<typeof loginBody> }>(req);
    const user = await loginWithPassword(body);
    const token = await issueToken(user._id, body.client);
    res.json({ token, user: toPrivateUser(user) });
  });

  // 202 no matter what: an unknown email and a delivery failure look identical
  // from outside, so the endpoint cannot be used to enumerate accounts.
  router.post(
    '/magic-link',
    limits.magicLink,
    validate({ body: magicLinkBody }),
    async (req, res) => {
      const { body } = getValidated<{ body: z.infer<typeof magicLinkBody> }>(req);
      try {
        await issueMagicLink(body.email, deps);
      } catch (err) {
        deps.logger.error({ err }, 'magic link issue failed');
      }
      res.status(202).json({ accepted: true });
    },
  );

  router.post(
    '/magic-link/verify',
    limits.auth,
    validate({ body: magicLinkVerifyBody }),
    async (req, res) => {
      const { body } = getValidated<{ body: z.infer<typeof magicLinkVerifyBody> }>(req);
      const user = await consumeMagicLink(body.token);
      if (!user) {
        throw new AppError(401, 'invalid_magic_link', 'This link is invalid, used, or expired.');
      }
      const token = await issueToken(user._id, body.client);
      res.json({ token, user: toPrivateUser(user) });
    },
  );

  // Email is taken from the verified identity token only. The body carries the
  // token and the nonce the client generated; nothing else is trusted.
  router.post('/apple', limits.auth, validate({ body: appleBody }), async (req, res) => {
    if (!env.APPLE_CLIENT_ID) {
      throw unavailable('provider_unconfigured', 'Sign in with Apple is not configured.');
    }
    const { body } = getValidated<{ body: z.infer<typeof appleBody> }>(req);

    let payload: Awaited<ReturnType<typeof appleSignin.verifyIdToken>>;
    try {
      payload = await appleSignin.verifyIdToken(body.identityToken, {
        audience: env.APPLE_CLIENT_ID,
        ignoreExpiration: false,
      });
    } catch {
      throw providerTokenRejected();
    }
    // Clients send the raw nonce; Apple echoes either the raw value or its SHA-256.
    const tokenNonce = (payload as { nonce?: string }).nonce;
    if (!tokenNonce || (tokenNonce !== body.nonce && tokenNonce !== sha256Hex(body.nonce))) {
      throw providerTokenRejected();
    }

    const emailVerified = String(payload.email_verified ?? 'false') === 'true';
    const { user, created } = await signInWithProvider({
      provider: 'apple',
      subject: payload.sub,
      email: payload.email,
      emailVerified,
    });
    const token = await issueToken(user._id, body.client);
    res.status(created ? 201 : 200).json({ token, user: toPrivateUser(user) });
  });

  router.post('/google', limits.auth, validate({ body: googleBody }), async (req, res) => {
    if (env.GOOGLE_CLIENT_IDS.length === 0) {
      throw unavailable('provider_unconfigured', 'Sign in with Google is not configured.');
    }
    const { body } = getValidated<{ body: z.infer<typeof googleBody> }>(req);

    let payload: TokenPayload | undefined;
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken: body.idToken,
        audience: env.GOOGLE_CLIENT_IDS,
      });
      payload = ticket.getPayload();
    } catch {
      throw providerTokenRejected();
    }
    if (!payload?.sub) throw providerTokenRejected();

    const { user, created } = await signInWithProvider({
      provider: 'google',
      subject: payload.sub,
      email: payload.email,
      emailVerified: payload.email_verified === true,
    });
    const token = await issueToken(user._id, body.client);
    res.status(created ? 201 : 200).json({ token, user: toPrivateUser(user) });
  });

  router.post('/logout', requireAuth(deps), async (req, res) => {
    await revokeSession(currentUser(req)._id, currentSession(req)._id);
    res.status(204).end();
  });

  return router;
}
