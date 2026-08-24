/**
 * The whole of this server's knowledge about GetFacade: a base URL, a key, and
 * how a JSON:API error is worded.
 *
 * No message is composed here. Whatever the API says about a refusal (402 cap reached, 422 duplicate
 * building name, 429 slow down) is handed to the agent verbatim, because the
 * agent is the one who has to decide what to do about it, and a second wording
 * on this side is exactly where the two would drift apart.
 */

import { randomUUID } from 'node:crypto';

const DEFAULT_BASE_URL = 'https://api.getfacade.ai/api/v1';
const DEFAULT_LANGUAGE = 'en';

// A paid create call is retried by this wrapper, never by the agent: the agent
// has no way of knowing whether the request that timed out had already been
// charged. Gateway failures and "the original is still running" are the two
// answers worth waiting on; everything else is the API's verdict and is handed
// over as it stands.
const RETRY_DELAYS_MS = [500, 1500];
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

// Node's fetch waits forever by default. An MCP tool that never answers is
// worse than one that fails: the client model has nothing to react to and the
// conversation stalls with a paid job possibly already queued. Every call is
// therefore bounded, and a bounded failure is exactly the case `postPaid`
// knows how to retry under the same name.
const REQUEST_TIMEOUT_MS = 60_000;
// The upload leg carries the photo itself over somebody's home connection, so
// it gets its own, longer budget rather than the API one.
const UPLOAD_TIMEOUT_MS = 180_000;

export class ApiError extends Error {
  constructor(status, detail, code) {
    super(detail);
    this.status = status;
    this.code = code;
  }
}

export class GetFacadeApi {
  constructor({ apiKey, baseUrl, language }) {
    if (!apiKey) {
      throw new Error(
        'GETFACADE_API_KEY is not set. Issue an agent key at https://app.getfacade.ai/account/agent-keys and pass it in the environment.',
      );
    }

    this.apiKey = apiKey;
    this.baseUrl = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    // Every message a caller sees is the API's own text, so the language of a
    // refusal is a wire decision, not a display one. Without this header the
    // server falls back to whatever locale the account was last saved with,
    // and the same refusal reaches one agent in English and another in
    // Romanian. Pinning it keeps the answer reproducible; a deployment that
    // wants its user's language sets GETFACADE_LANG.
    this.language = language || DEFAULT_LANGUAGE;
  }

  async request(method, path, { body, query, idempotencyKey } = {}) {
    const url = new URL(this.baseUrl + path);

    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const response = await fetchWithin(REQUEST_TIMEOUT_MS, url, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'application/json',
        'Accept-Language': this.language,
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (response.status === 204) return null;

    const payload = await response.json().catch(() => null);

    if (!response.ok) throw toApiError(response.status, payload);

    return payload;
  }

  get(path, query) {
    return this.request('GET', path, { query });
  }

  post(path, body) {
    return this.request('POST', path, { body });
  }

  /**
   * A create call that costs money (a render, an estimate, an album, an
   * upscale).
   *
   * BILLING-CRITICAL. The API charges per created row, so a call that times out
   * and is sent again produces a second job and a second charge. The agent
   * cannot be asked to think about that: it names the attempt here, once, and
   * this method owns the retries. The API answers a repeat of the same named
   * attempt with the original result instead of doing the work twice.
   *
   * The name is generated per CALL, not per set of arguments: two identical
   * orders are legitimately two designs (an agent exploring variants sends the
   * same body on purpose), so only the caller of this method can say that a
   * second request is the same request.
   */
  async postPaid(path, body) {
    const idempotencyKey = randomUUID();

    for (let attempt = 0; ; attempt++) {
      try {
        return await this.request('POST', path, { body, idempotencyKey });
      } catch (error) {
        const retryable = error instanceof ApiError
          ? RETRYABLE_STATUSES.has(error.status) || error.code === 'IDEMPOTENCY_IN_PROGRESS'
          : true; // fetch itself failed: timeout, reset, DNS. The job may exist.

        if (!retryable || attempt >= RETRY_DELAYS_MS.length) throw error;

        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
      }
    }
  }

  patch(path, body) {
    return this.request('PATCH', path, { body });
  }

  delete(path) {
    return this.request('DELETE', path);
  }

  /**
   * Bytes go straight to storage on a presigned URL — they never pass through
   * our API, and this call carries no Authorization header on purpose (the
   * signature IS the authorisation; adding a second one makes S3 refuse).
   */
  async putFile(policy, bytes, contentType) {
    if (policy?.skip_upload) return;

    const headers = { ...(policy.headers ?? {}) };
    if (contentType && !headers['Content-Type']) headers['Content-Type'] = contentType;

    const response = await fetchWithin(UPLOAD_TIMEOUT_MS, policy.url, {
      method: policy.method || 'PUT',
      headers,
      body: bytes,
    });

    if (!response.ok) {
      throw new ApiError(response.status, `Upload to storage failed with HTTP ${response.status}.`, 'UPLOAD_FAILED');
    }
  }
}

/**
 * `fetch` with a deadline, and a timeout that says so.
 *
 * The abort reason has to be reworded here because there is no API text to
 * quote: nothing answered. Everything the API DID say still travels verbatim
 * (see the note at the top of this file).
 */
async function fetchWithin(timeoutMs, url, options) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error(
        `GetFacade did not answer within ${Math.round(timeoutMs / 1000)}s. The request may still have been accepted: check the job list before ordering the same thing again.`,
      );
    }

    throw error;
  }
}

function toApiError(status, payload) {
  const first = Array.isArray(payload?.errors) ? payload.errors[0] : null;

  if (first) {
    return new ApiError(status, first.detail || first.title || `HTTP ${status}`, first.code);
  }

  // Laravel validation replies (422) are not JSON:API-shaped; their message is
  // still the API's own text, so it is passed through unchanged too.
  if (payload?.message) return new ApiError(status, payload.message, payload.code);

  return new ApiError(status, `HTTP ${status}`);
}
