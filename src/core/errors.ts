/** Only curated tool errors may be persisted or displayed. SDK errors may contain payloads. */
export class ToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

export function safeError(error: unknown): string {
  if (error instanceof ToolError) return `${error.code}: ${error.message}`;
  return "E_OPERATION_FAILED: Operation failed. Check API activity and authorization through your private operator channel; raw SDK errors are not displayed.";
}
