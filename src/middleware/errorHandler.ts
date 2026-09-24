import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';

interface BodyParserError extends Error {
  type?: string;
  status?: number;
}

interface MongoServerError extends Error {
  code?: number;
}

function translate(err: unknown): AppError {
  if (err instanceof AppError) return err;

  if (err instanceof Error) {
    const parserType = (err as BodyParserError).type;
    if (parserType === 'entity.too.large') {
      return new AppError(413, 'payload_too_large', 'Request body is too large.');
    }
    if (parserType === 'entity.parse.failed') {
      return new AppError(400, 'invalid_json', 'Request body is not valid JSON.');
    }
    if (err.name === 'CastError') {
      return new AppError(400, 'invalid_id', 'A provided id is not valid.');
    }
    if (err.name === 'ValidationError') {
      return new AppError(400, 'validation_error', 'A document failed validation.');
    }
    if ((err as MongoServerError).code === 11000) {
      return new AppError(409, 'conflict', 'That value is already taken.');
    }
  }
  return new AppError(500, 'internal_error', 'Something went wrong.');
}

/** Everything that falls off the end of the router is a 404 in the standard shape. */
export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new AppError(404, 'not_found', 'Route not found.'));
};

/**
 * Last middleware. Renders `{ error: { code, message } }` for every failure,
 * logs 5xx with the stack, and never echoes internal messages to the client.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const appError = translate(err);
  const log = (req as { log?: Logger }).log;
  if (appError.status >= 500) {
    log?.error({ err }, 'unhandled error');
  } else if (appError.status === 501) {
    log?.debug({ code: appError.code }, 'not implemented');
  }
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(appError.status).json(appError.toBody());
};
