import type { Request, RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { badRequest } from '../lib/errors.js';

export interface ValidationSchemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

/**
 * Validate and coerce request parts at the boundary. Parsed values land on
 * `req.validated` (Express 5 makes `req.query` read-only), and a failure
 * answers 400 `validation_error` with the field paths that failed.
 */
export function validate(schemas: ValidationSchemas): RequestHandler {
  return (req, _res, next) => {
    const out = { body: req.body, query: req.query, params: req.params } as {
      body: unknown;
      query: unknown;
      params: unknown;
    };
    const details: Array<{ path: string; message: string }> = [];

    for (const part of ['body', 'query', 'params'] as const) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part] ?? {});
      if (result.success) {
        out[part] = result.data;
      } else {
        for (const issue of result.error.issues) {
          details.push({ path: [part, ...issue.path].join('.'), message: issue.message });
        }
      }
    }

    if (details.length > 0) {
      return next(badRequest('validation_error', 'Request validation failed.', details));
    }
    req.validated = out;
    next();
  };
}

/** Typed access to what `validate()` parsed. */
export function getValidated<T extends { body?: unknown; query?: unknown; params?: unknown }>(
  req: Request,
): T {
  if (!req.validated) {
    throw new Error('getValidated() called on a route without validate()');
  }
  return req.validated as T;
}
