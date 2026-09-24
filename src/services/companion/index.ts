import Anthropic from '@anthropic-ai/sdk';
import type { Env } from '../../config/env.js';
import { AppError, unavailable } from '../../lib/errors.js';
import type { Logger } from '../../lib/logger.js';
import { buildMemberContext, IVY_SYSTEM_PROMPT } from './prompt.js';
import type { CompanionInput, CompanionResult, CompanionService } from './types.js';

export type { CompanionInput, CompanionResult, CompanionService, CompanionTurn } from './types.js';

const REFUSAL_TEXT =
  "I can't help with that one. Ask me about places, events, guides, or outreach.";

function translateError(err: unknown, logger: Logger): AppError {
  if (err instanceof Anthropic.AuthenticationError) {
    logger.error('companion: Anthropic rejected the API key');
    return unavailable('companion_unavailable', 'The companion is not available right now.');
  }
  if (err instanceof Anthropic.RateLimitError) {
    return unavailable('companion_busy', 'The companion is busy. Try again in a moment.');
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return unavailable('companion_unavailable', 'The companion could not be reached.');
  }
  if (err instanceof Anthropic.APIError) {
    logger.error({ status: err.status, name: err.name }, 'companion: API error');
    return new AppError(502, 'companion_error', 'The companion returned an error.');
  }
  if (err instanceof AppError) return err;
  logger.error({ err }, 'companion: unexpected error');
  return new AppError(500, 'internal_error', 'Something went wrong.');
}

/**
 * Streams Ivy's reply as text deltas. The prompt carries the handle and the
 * member's stated interests and nothing else. The model id is configuration
 * (`COMPANION_MODEL`), never a literal in this code path.
 */
export function createCompanionService(
  env: Pick<Env, 'ANTHROPIC_API_KEY' | 'COMPANION_MODEL' | 'COMPANION_MAX_TOKENS'>,
  logger: Logger,
): CompanionService {
  const client = env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }) : null;

  function buildParams(input: CompanionInput): Anthropic.MessageStreamParams {
    const messages: Anthropic.MessageParam[] = [
      ...input.history.map((turn) => ({ role: turn.role, content: turn.content })),
      { role: 'user', content: input.message },
    ];
    return {
      model: env.COMPANION_MODEL,
      max_tokens: env.COMPANION_MAX_TOKENS,
      thinking: { type: 'adaptive' },
      system: [
        { type: 'text', text: IVY_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: buildMemberContext(input) },
      ],
      messages,
    };
  }

  /** Inspect the finished message; a refusal gets a fixed, friendly closing line. */
  function describeOutcome(final: Anthropic.Message): CompanionResult & { trailingText?: string } {
    const stopReason = final.stop_reason;
    logger.debug(
      {
        stopReason,
        inputTokens: final.usage.input_tokens,
        outputTokens: final.usage.output_tokens,
        cacheRead: final.usage.cache_read_input_tokens ?? 0,
      },
      'companion: turn complete',
    );
    if (stopReason === 'refusal') {
      logger.warn({ category: final.stop_details?.category ?? null }, 'companion: refusal');
      return { stopReason, trailingText: REFUSAL_TEXT };
    }
    if (stopReason === 'max_tokens') {
      logger.warn({ maxTokens: env.COMPANION_MAX_TOKENS }, 'companion: reply truncated');
    }
    return { stopReason };
  }

  function openStream(api: Anthropic, input: CompanionInput, signal?: AbortSignal) {
    try {
      return api.messages.stream(buildParams(input), { signal });
    } catch (err) {
      throw translateError(err, logger);
    }
  }

  return {
    async *streamCompanionReply(
      input: CompanionInput,
      options: { signal?: AbortSignal } = {},
    ): AsyncGenerator<string, CompanionResult, void> {
      if (!client) {
        throw unavailable('companion_unavailable', 'The companion is not configured.');
      }
      const stream = openStream(client, input, options.signal);

      try {
        for await (const event of stream) {
          if (isTextDelta(event)) yield event.delta.text;
        }
        const outcome = describeOutcome(await stream.finalMessage());
        if (outcome.trailingText) yield outcome.trailingText;
        return { stopReason: outcome.stopReason };
      } catch (err) {
        if (options.signal?.aborted) return { stopReason: null };
        throw translateError(err, logger);
      }
    },
  };
}

function isTextDelta(
  event: Anthropic.MessageStreamEvent,
): event is Anthropic.RawContentBlockDeltaEvent & { delta: Anthropic.TextDelta } {
  return event.type === 'content_block_delta' && event.delta.type === 'text_delta';
}
