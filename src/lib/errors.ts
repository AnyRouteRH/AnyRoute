// OpenRouter-shaped errors: { error: { code: <http status>, message, metadata? } }.
// `type` carries a stable machine-readable reason (OpenAI SDKs read error.type/code).

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public type = "invalid_request",
    public metadata?: Record<string, unknown>,
    public headers?: Record<string, string>,
    /** Replaces the default error envelope (x402 responses have their own JSON shape). */
    public body?: Record<string, unknown>,
  ) {
    super(message);
  }
  toJSON() {
    return this.body ?? {
      error: {
        code: this.status,
        message: this.message,
        type: this.type,
        ...(this.metadata ? { metadata: this.metadata } : {}),
      },
    };
  }
}

export function fail(
  status: number,
  message: string,
  type = "invalid_request",
  metadata?: Record<string, unknown>,
  headers?: Record<string, string>,
): never {
  throw new ApiError(status, message, type, metadata, headers);
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;
