import type { ApiFailure, ApiResponse, ApiSuccess } from "@/lib/api/response";

export class ApiClientError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly supportId?: string;
  readonly raw?: unknown;

  constructor(message: string, opts: { status: number; code?: string; supportId?: string; raw?: unknown }) {
    super(message);
    this.name = "ApiClientError";
    this.status = opts.status;
    this.code = opts.code;
    this.supportId = opts.supportId;
    this.raw = opts.raw;
  }
}

function isApiSuccess<T>(body: unknown): body is ApiSuccess<T> {
  return !!body && typeof body === "object" && (body as { success?: unknown }).success === true && "data" in (body as object);
}

function isApiFailure(body: unknown): body is ApiFailure {
  return (
    !!body &&
    typeof body === "object" &&
    (body as { success?: unknown }).success === false &&
    !!(body as { error?: unknown }).error &&
    typeof (body as { error: { message?: unknown } }).error.message === "string"
  );
}

/** Default request timeout for normal API calls (ms). */
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

export type FetchJsonInit = RequestInit & {
  /** Abort the request after this many ms. Defaults to 30s. Pass 0 to disable. */
  timeoutMs?: number;
  /**
   * Number of automatic retries on transient failures.
   * Retries ONLY happen for idempotent requests (GET/HEAD, or `idempotent: true`).
   * Defaults to 2 for idempotent requests, 0 otherwise.
   */
  retries?: number;
  /** Force-allow retries for a non-GET request the caller knows is safe to repeat. */
  idempotent?: boolean;
};

const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function isIdempotentMethod(method: string | undefined): boolean {
  const m = (method ?? "GET").toUpperCase();
  return m === "GET" || m === "HEAD" || m === "OPTIONS";
}

function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");
}

function combineSignals(timeoutMs: number, external?: AbortSignal | null): AbortSignal | undefined {
  if (!timeoutMs || timeoutMs <= 0) return external ?? undefined;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!external) return timeoutSignal;
  // Combine caller cancellation with our timeout when supported.
  const anyFn = (AbortSignal as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === "function") return anyFn([external, timeoutSignal]);
  return timeoutSignal;
}

async function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch JSON with support for BOTH:
 * - New envelope: { success: true, data, message? } / { success: false, error: { code, message } }
 * - Legacy endpoints: { ... } on success, { error: string } on failure
 *
 * Reliability guards:
 * - Every request has a timeout (default 30s) so a stalled network never hangs the UI forever.
 * - Transient failures are retried with exponential backoff, but ONLY for idempotent requests
 *   (so we never duplicate a POST/PATCH that may have already mutated server state).
 */
export async function fetchJson<T>(
  input: RequestInfo | URL,
  init?: FetchJsonInit
): Promise<{ data: T; message?: string; raw: unknown }> {
  const { timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, retries, idempotent, signal: externalSignal, ...rest } = init ?? {};

  const canRetry = idempotent === true || isIdempotentMethod(rest.method);
  const maxRetries = Math.max(0, retries ?? (canRetry ? 2 : 0));

  let lastError: unknown = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res: Response;
    try {
      res = await fetch(input, { ...rest, signal: combineSignals(timeoutMs, externalSignal as AbortSignal | null | undefined) });
    } catch (e) {
      // Network failure or timeout/abort.
      lastError = e;

      // User-initiated cancellation should not be retried or rewritten.
      if (externalSignal && (externalSignal as AbortSignal).aborted) {
        throw e;
      }

      const timedOut = isAbortError(e);
      if (canRetry && attempt < maxRetries) {
        await wait(Math.min(1000 * 2 ** attempt, 8000) + Math.random() * 200);
        continue;
      }

      if (timedOut) {
        throw new ApiClientError("Request timed out. Please check your connection and try again.", {
          status: 0,
          code: "TIMEOUT",
        });
      }
      throw new ApiClientError(e instanceof Error ? e.message : "Network request failed.", {
        status: 0,
        code: "NETWORK",
      });
    }

    const clone = res.clone();
    const rawJson = (await res.json().catch(() => null)) as unknown;
    const rawText = rawJson === null ? await clone.text().catch(() => null) : null;
    const raw = rawJson ?? (typeof rawText === "string" && rawText.length ? { text: rawText.slice(0, 2000) } : null);

    // New envelope
    if (isApiSuccess<T>(raw)) {
      return { data: raw.data, message: raw.message, raw };
    }
    if (isApiFailure(raw)) {
      // Retry transient server failures for idempotent requests only.
      if (canRetry && attempt < maxRetries && TRANSIENT_STATUSES.has(res.status)) {
        await wait(Math.min(1000 * 2 ** attempt, 8000) + Math.random() * 200);
        continue;
      }
      const supportId = typeof (raw as { support_id?: unknown }).support_id === "string" ? (raw as { support_id: string }).support_id : undefined;
      throw new ApiClientError(raw.error.message, { status: res.status, code: raw.error.code, supportId, raw });
    }

    // Legacy success
    if (res.ok) {
      const msg = (raw && typeof raw === "object" && typeof (raw as { message?: unknown }).message === "string")
        ? ((raw as { message: string }).message)
        : undefined;
      return { data: raw as T, message: msg, raw };
    }

    // Retry transient server failures for idempotent requests only.
    if (canRetry && attempt < maxRetries && TRANSIENT_STATUSES.has(res.status)) {
      await wait(Math.min(1000 * 2 ** attempt, 8000) + Math.random() * 200);
      continue;
    }

    // Legacy error
    const legacyError =
      raw && typeof raw === "object" && typeof (raw as { error?: unknown }).error === "string"
        ? (raw as { error: string }).error
        : null;

    const fallback =
      legacyError ||
      (typeof rawText === "string" && rawText.trim().length > 0
        ? `Request failed (HTTP ${res.status})`
        : `Request failed (HTTP ${res.status})`);

    throw new ApiClientError(fallback, { status: res.status, raw });
  }

  // Should be unreachable, but keep TS happy and never hang.
  throw lastError instanceof Error ? lastError : new ApiClientError("Request failed.", { status: 0, code: "NETWORK" });
}

export type { ApiResponse };

