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

export interface SafeError {
  code: string;
  message: string;
  httpStatus: number;
}

export function safeError(error: unknown): SafeError {
  if (error instanceof PublicError) {
    return { code: error.code, message: error.message, httpStatus: error.httpStatus };
  }
  return { code: "INTERNAL_ERROR", message: "The operation failed safely.", httpStatus: 500 };
}
