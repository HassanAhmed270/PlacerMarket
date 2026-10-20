/**
 * lib/errors.js
 *
 * Shared error types for the Poshaak backend.
 *
 * NotYetSpecifiedError is the one that matters for the harness: every OPEN
 * item in specs.md (search specs.md for "(OPEN)") has a corresponding code
 * path that throws this instead of guessing at behavior. This is deliberate:
 * an agent hitting this error should stop and either (a) ask the human to
 * resolve the product decision, or (b) go update specs.md + this file
 * together once a decision is made — never quietly implement a guess here.
 *
 * DO NOT catch this error and fall back to default behavior. DO NOT remove
 * the throw to "make the endpoint work" without first resolving the FR in
 * specs.md and removing the (OPEN) tag there.
 */

class NotYetSpecifiedError extends Error {
  /**
   * @param {string} frCode - e.g. "FR-08b"
   * @param {string} reason - one line on what's undecided (mirror specs.md wording)
   */
  constructor(frCode, reason) {
    super(`${frCode} is not yet specified: ${reason}. See specs.md open decisions.`);
    this.name = 'NotYetSpecifiedError';
    this.frCode = frCode;
    this.statusCode = 501; // Not Implemented
  }
}

/**
 * Use when the behavior IS decided but the code simply hasn't been written
 * yet (e.g. the authenticate() stub). Distinct from NotYetSpecifiedError,
 * which means the product decision itself is missing. 501 either way, but
 * no frCode — there is no open spec question behind it.
 */
class NotImplementedError extends Error {
  constructor(what) {
    super(`${what} is not implemented yet`);
    this.name = 'NotImplementedError';
    this.statusCode = 501;
  }
}

class NotFoundError extends Error {
  constructor(entity, id) {
    super(`${entity} not found: ${id}`);
    this.name = 'NotFoundError';
    this.statusCode = 404;
  }
}

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
  }
}

class ForbiddenError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ForbiddenError';
    this.statusCode = 403;
  }
}

class ServiceUnavailableError extends Error {
  constructor(message = 'Database connection is temporarily unavailable') {
    super(message);
    this.name = 'ServiceUnavailableError';
    this.statusCode = 503;
  }
}

module.exports = {
  NotYetSpecifiedError, NotImplementedError, NotFoundError, ValidationError, ForbiddenError,
  ServiceUnavailableError,
};
