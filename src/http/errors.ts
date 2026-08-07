import { json } from "./responses";

export class AppError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof AppError) {
    return json({ error: error.message }, error.status);
  }

  console.error("Unhandled request error", error);
  return json({ error: "Internal server error; retry later" }, 500);
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new AppError(400, "Invalid JSON body");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError(400, "JSON body must be an object");
  }
  return value as Record<string, unknown>;
}
