import { ToolError } from "./errors.js";
import { RetryableError } from "./retry.js";

export interface ApiOptions {
  beforeRequest?: () => Promise<void>;
}
interface Stamper {
  stamp(
    payload: string,
  ): Promise<{ stampHeaderName: string; stampHeaderValue: string }>;
}
interface Client {
  config: { baseUrl: string };
  stamper: Stamper;
  request<TBody, TResponse>(path: string, body: TBody): Promise<TResponse>;
}

/** Use the generated SDK methods with bounded, non-redirecting, single-attempt transport. */
export function bindTransport<T extends Client>(
  client: T,
  options: ApiOptions,
): T {
  let origin: URL;
  try {
    origin = new URL(client.config.baseUrl);
  } catch {
    throw new ToolError("E_ENDPOINT_INVALID", "Invalid API base URL.");
  }
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/"
  ) {
    throw new ToolError(
      "E_ENDPOINT_INVALID",
      "API base URL must be a credential-free HTTPS origin.",
    );
  }
  client.request = async <TBody, TResponse>(
    path: string,
    body: TBody,
  ): Promise<TResponse> => {
    if (!path.startsWith("/public/v1/") || path.includes(".."))
      throw new ToolError("E_ENDPOINT_INVALID", "Unsupported API path.");
    await options.beforeRequest?.();
    const payload = JSON.stringify(body);
    const stamp = await client.stamper.stamp(payload);
    let response: Response;
    try {
      response = await fetch(origin.origin + path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [stamp.stampHeaderName]: stamp.stampHeaderValue,
        },
        body: payload,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new RetryableError(
        "API transport failed or timed out; the submission outcome may be unknown.",
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 429 || response.status >= 500)
        throw new RetryableError("API rate limit or server failure.");
      throw new ToolError(
        "E_API_REJECTED",
        "API rejected the request. Check credentials, authorization, and activity through your private operator channel.",
      );
    }
    try {
      return (await response.json()) as TResponse;
    } catch {
      throw new ToolError(
        "E_API_RESPONSE",
        "API returned an invalid response; raw response content is suppressed.",
      );
    }
  };
  return client;
}

export async function allAccounts<
  T extends {
    walletAccountId: string;
    organizationId: string;
    walletId: string;
  },
>(
  fetchPage: (after?: string) => Promise<T[]>,
  organizationId: string,
  walletId: string,
): Promise<T[]> {
  const rows: T[] = [];
  const seen = new Set<string>();
  let after: string | undefined;
  for (let page = 0; page < 10_000; page++) {
    const accounts = await fetchPage(after);
    if (!Array.isArray(accounts))
      throw new ToolError(
        "E_API_RESPONSE",
        "Wallet account response is malformed.",
      );
    if (!accounts.length) return rows;
    for (const account of accounts) {
      if (
        !account.walletAccountId ||
        seen.has(account.walletAccountId) ||
        account.organizationId !== organizationId ||
        account.walletId !== walletId
      ) {
        throw new ToolError(
          "E_PAGINATION",
          "Wallet account pagination/cursor or organization context is invalid; inventory may be incomplete.",
        );
      }
      seen.add(account.walletAccountId);
      rows.push(account);
    }
    after = accounts[accounts.length - 1].walletAccountId;
  }
  throw new ToolError(
    "E_PAGINATION",
    "Wallet account pagination exceeded the safety limit.",
  );
}
