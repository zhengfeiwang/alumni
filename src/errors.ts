/**
 * Error model per spec §9. Every error is structured (code/message) AND
 * model-actionable (hint prescribing the recovery action).
 */

export type ErrorCode =
  | "INVALID_ARGS"
  | "SESSION_EXPIRED"
  | "REF_NOT_FOUND"
  | "INVALID_REF_TYPE"
  | "UNSUPPORTED_SCHEME"
  | "ELEMENT_NOT_FOUND"
  | "ELEMENT_NOT_ACTIONABLE"
  | "FETCH_FAILED"
  | "EXTRACTION_FAILED"
  | "RATE_LIMITED"
  | "BACKEND_ERROR";

export interface ToolError {
  code: ErrorCode;
  message: string;
  hint: string;
}

const DEFAULT_HINTS: Record<ErrorCode, string> = {
  INVALID_ARGS: "Check the tool's input schema and retry with valid arguments.",
  SESSION_EXPIRED:
    "This session is gone (evicted after 30 min idle, or never existed). Omit session_id to start a fresh session, then re-run the search or open to obtain new refs.",
  REF_NOT_FOUND:
    "This ref is unknown in the current session. Re-run the search or re-open the URL to obtain a fresh ref.",
  INVALID_REF_TYPE:
    "This ref type cannot be used here. find and click require a fetch ref (turn{N}fetch{idx}); open accepts search or fetch refs.",
  UNSUPPORTED_SCHEME:
    "Only http:// and https:// URLs can be fetched. Do not open file:, ftp:, data:, javascript: or other schemes.",
  ELEMENT_NOT_FOUND:
    "No element with this id exists on the referenced page instance. open the page ref again to see its current element map, and use an id shown as [{id}] in the rendered lines.",
  ELEMENT_NOT_ACTIONABLE:
    "This element is a button; buttons are display-only in v1. click only follows link elements ([{id}]). Look for a link with similar text, or open the target URL directly if one is visible.",
  FETCH_FAILED:
    "The fetch failed. You may retry once; if it persists, try a different source from search results.",
  EXTRACTION_FAILED:
    "The page yielded no readable content (paywall, app shell, or non-article page). Try a different source from search results.",
  RATE_LIMITED:
    "The search backend's quota is exhausted. Back off, narrow your batch, or try again later.",
  BACKEND_ERROR:
    "The search backend failed. Check its configuration (e.g. API key), or retry.",
};

/** Internal error type; converted to a plain ToolError at the tool boundary. */
export class GroundingError extends Error {
  readonly code: ErrorCode;
  readonly hint: string;

  constructor(code: ErrorCode, message: string, hint?: string) {
    super(message);
    this.name = "GroundingError";
    this.code = code;
    this.hint = hint ?? DEFAULT_HINTS[code];
  }

  toToolError(): ToolError {
    return { code: this.code, message: this.message, hint: this.hint };
  }
}

export function toolError(
  code: ErrorCode,
  message: string,
  hint?: string,
): ToolError {
  return new GroundingError(code, message, hint).toToolError();
}

/** Convert anything thrown inside a tool handler into a spec-shaped ToolError. */
export function asToolError(err: unknown): ToolError {
  if (err instanceof GroundingError) return err.toToolError();
  const message = err instanceof Error ? err.message : String(err);
  return { code: "BACKEND_ERROR", message, hint: DEFAULT_HINTS.BACKEND_ERROR };
}

export function invalidArgs(message: string, hint?: string): GroundingError {
  return new GroundingError("INVALID_ARGS", message, hint);
}

export function sessionExpired(sessionId: string): GroundingError {
  return new GroundingError(
    "SESSION_EXPIRED",
    `Session "${sessionId}" has expired or never existed.`,
  );
}

export function refNotFound(ref: string): GroundingError {
  return new GroundingError(
    "REF_NOT_FOUND",
    `Ref "${ref}" was not found in this session.`,
  );
}

export function invalidRefType(
  ref: string,
  actual: string,
  expected: string,
): GroundingError {
  return new GroundingError(
    "INVALID_REF_TYPE",
    `Ref "${ref}" is a ${actual} ref; this tool requires ${expected}.`,
  );
}

export function unsupportedScheme(url: string): GroundingError {
  let scheme = "unknown";
  try {
    scheme = new URL(url).protocol.replace(/:$/, "");
  } catch {
    /* keep "unknown" */
  }
  return new GroundingError(
    "UNSUPPORTED_SCHEME",
    `Cannot fetch "${url}": scheme "${scheme}" is not supported (http and https only).`,
  );
}

export function fetchFailed(message: string, hint?: string): GroundingError {
  return new GroundingError("FETCH_FAILED", message, hint);
}
