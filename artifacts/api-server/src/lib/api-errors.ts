export class ApiError extends Error {
  code: string;
  statusCode: number;
  details?: unknown;

  constructor(code: string, message: string, statusCode = 400, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function toErrorPayload(error: unknown) {
  if (error instanceof ApiError) {
    return {
      statusCode: error.statusCode,
      payload: {
        error: error.code,
        message: error.message,
        details: error.details ?? null,
      },
    };
  }

  return {
    statusCode: 500,
    payload: {
      error: "INTERNAL_ERROR",
      message: "An unexpected error occurred",
    },
  };
}
