/** Contract between the companion route and whatever backs it (Claude, or a fake in tests). */

export interface CompanionTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface CompanionInput {
  /** The only identity the model ever sees. */
  handle: string;
  /** Interests the member typed themselves. Never email, area or friends. */
  interests: string[];
  history: CompanionTurn[];
  message: string;
}

export interface CompanionResult {
  /** `end_turn`, `max_tokens`, `refusal`, or null when the stream was aborted. */
  stopReason: string | null;
}

export interface CompanionService {
  streamCompanionReply(
    input: CompanionInput,
    options?: { signal?: AbortSignal },
  ): AsyncGenerator<string, CompanionResult, void>;
}
