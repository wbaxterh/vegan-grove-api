import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../lib/deps.js';
import { AppError, notFound, notImplemented } from '../lib/errors.js';
import { idParams, objectIdSchema, paginationQuery } from '../lib/schemas.js';
import { sendSse, startSse } from '../lib/sse.js';
import { currentUser, requireAuth } from '../middleware/auth.js';
import { createRateLimiters } from '../middleware/rateLimits.js';
import { getValidated, validate } from '../middleware/validate.js';
import {
  COMPANION_UNPINNED_TTL_MS,
  type CompanionConversationDoc,
  CompanionConversationModel,
  type Types,
} from '../models/index.js';
import type { CompanionTurn } from '../services/companion/types.js';

const chatBody = z
  .object({
    conversationId: objectIdSchema.optional(),
    message: z.string().trim().min(1).max(2000),
  })
  .strict();

/**
 * Ivy. `POST /chat` streams the reply as SSE (`meta`, `delta`*, `done` | `error`).
 * The prompt receives the handle and stated interests only. Turns are stored
 * in `companion_conversations` with a 24 h TTL unless the member pins them.
 */
async function loadConversation(
  userId: Types.ObjectId,
  conversationId: Types.ObjectId | undefined,
): Promise<CompanionConversationDoc> {
  if (!conversationId) {
    return new CompanionConversationModel({ userId, messages: [] });
  }
  const found = await CompanionConversationModel.findOne({ _id: conversationId, userId });
  if (!found) throw notFound('Conversation not found.');
  return found;
}

function asCompanionError(err: unknown, message: string): AppError {
  return err instanceof AppError ? err : new AppError(502, 'companion_error', message);
}

export function companionRouter(deps: AppDeps): Router {
  const router = Router();
  const limits = createRateLimiters(deps.env);
  router.use(requireAuth(deps));

  router.post('/chat', limits.companion, validate({ body: chatBody }), async (req, res) => {
    const user = currentUser(req);
    const { body } = getValidated<{ body: z.infer<typeof chatBody> }>(req);
    const conversation = await loadConversation(user._id, body.conversationId);

    const history: CompanionTurn[] = conversation.messages
      .slice(-deps.env.COMPANION_HISTORY_LIMIT)
      .map((m) => ({ role: m.role, content: m.content }));

    const abort = new AbortController();
    res.on('close', () => abort.abort());

    const stream = deps.companion.streamCompanionReply(
      { handle: user.handle, interests: user.interests, history, message: body.message },
      { signal: abort.signal },
    );
    const iterator = stream[Symbol.asyncIterator]();

    // Pull the first chunk before committing to SSE so a configuration or
    // upstream failure can still be answered as a normal JSON error.
    let step: IteratorResult<string, { stopReason: string | null }>;
    try {
      step = await iterator.next();
    } catch (err) {
      throw asCompanionError(err, 'The companion returned an error.');
    }

    startSse(res);
    sendSse(res, 'meta', { conversationId: conversation._id.toHexString() });

    const parts: string[] = [];
    let result: { stopReason: string | null };
    try {
      while (!step.done) {
        parts.push(step.value);
        sendSse(res, 'delta', { text: step.value });
        step = await iterator.next();
      }
      result = step.value;
    } catch (err) {
      const appError = asCompanionError(err, 'The companion stream failed.');
      deps.logger.warn({ code: appError.code }, 'companion stream ended with error');
      sendSse(res, 'error', appError.toBody().error);
      res.end();
      return;
    }

    const reply = parts.join('');
    if (reply.length > 0) {
      const now = new Date();
      conversation.messages.push({ role: 'user', content: body.message, at: now });
      conversation.messages.push({ role: 'assistant', content: reply, at: now });
      if (!conversation.pinned) {
        conversation.expiresAt = new Date(now.getTime() + COMPANION_UNPINNED_TTL_MS);
      }
      await conversation.save();
    }

    sendSse(res, 'done', { stopReason: result.stopReason, conversationId: conversation._id });
    res.end();
  });

  // TODO(m2): list, pin (clears `expiresAt`), and delete companion conversations.
  router.get('/conversations', validate({ query: paginationQuery }), notImplemented);
  router.post('/conversations/:id/pin', validate({ params: idParams }), notImplemented);
  router.delete('/conversations/:id', validate({ params: idParams }), notImplemented);

  return router;
}
