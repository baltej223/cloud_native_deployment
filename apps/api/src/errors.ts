import type { ApiErrorCode, ApiErrorResponse } from "@cloud-platform/contracts";

/** An error whose code and message are safe to return to clients. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }

  toBody(): ApiErrorResponse {
    return { error: { code: this.code, message: this.message } };
  }
}
