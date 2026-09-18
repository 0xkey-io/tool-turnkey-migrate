/**
 * Secure memory utilities — minimize plaintext exposure in JS runtime.
 *
 * JS strings are immutable and GC-managed, so true zeroing is impossible.
 * We use Buffer (backed by ArrayBuffer) for sensitive data and zero it explicitly.
 * For APIs that require string input, we convert at the last moment and minimize scope.
 */

export class SecureBuffer {
  private buf: Buffer;
  private zeroed = false;

  private constructor(buf: Buffer) {
    this.buf = buf;
  }

  static fromString(s: string): SecureBuffer {
    return new SecureBuffer(Buffer.from(s, "utf-8"));
  }

  static fromHex(hex: string): SecureBuffer {
    const cleaned = hex.startsWith("0x") ? hex.slice(2) : hex;
    return new SecureBuffer(Buffer.from(cleaned, "hex"));
  }

  toString(): string {
    if (this.zeroed) throw new Error("SecureBuffer already zeroed");
    return this.buf.toString("utf-8");
  }

  toHex(): string {
    if (this.zeroed) throw new Error("SecureBuffer already zeroed");
    return this.buf.toString("hex");
  }

  zero(): void {
    if (!this.zeroed) {
      this.buf.fill(0);
      this.zeroed = true;
    }
  }

  get isZeroed(): boolean {
    return this.zeroed;
  }
}

/**
 * Execute a function with a sensitive value, ensuring zeroing afterward.
 * The value is only accessible inside the callback scope.
 */
export async function withSecureValue<T>(
  value: string,
  fn: (val: string) => Promise<T>,
): Promise<T> {
  const secure = SecureBuffer.fromString(value);
  try {
    return await fn(secure.toString());
  } finally {
    secure.zero();
  }
}
