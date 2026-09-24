import type { SessionDoc, UserDoc } from '../models/index.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by `requireAuth`. The principal always comes from here, never from a body. */
    auth?: { user: UserDoc; session: SessionDoc };
    /** Set by `validate()`: the parsed, typed request parts. */
    validated?: { body: unknown; query: unknown; params: unknown };
  }
}
