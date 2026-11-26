export class PublicError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 400
  ) {
    super(message);
    this.name = "PublicError";
  }
}

export function safeError(error: unknown): { code: string; message: string; httpStatus: number } {
  if (error instanceof PublicError) {
    return {
      code: error.code,
      message: error.message,
      httpStatus: error.httpStatus
    };
  }
  return {
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : "Unexpected internal error",
    httpStatus: 500
  };
}
