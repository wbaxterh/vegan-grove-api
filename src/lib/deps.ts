import type { Env } from '../config/env.js';
import type { CompanionService } from '../services/companion/types.js';
import type { Logger } from './logger.js';

/** Outbound email. The test suite swaps in a capturing implementation. */
export interface EmailSender {
  sendMagicLink(input: { to: string; url: string }): Promise<void>;
}

/**
 * Everything a router or socket handler needs that is not a Mongoose model.
 * `buildApp(deps)` threads this through every `<name>Router(deps)` factory so
 * tests can substitute the pieces that talk to the outside world.
 */
export interface AppDeps {
  env: Env;
  logger: Logger;
  email: EmailSender;
  companion: CompanionService;
}
