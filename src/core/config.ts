import { parse as parseYaml } from "yaml";
import { readSafeText } from "./safe-files.js";
import type { MigrationConfig } from "../types/config.js";

export class ConfigValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Config validation failed:\n  ${issues.join("\n  ")}`);
    this.name = "ConfigValidationError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export async function loadConfig(path: string): Promise<MigrationConfig> {
  const raw = await readSafeText(path);
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch {
    throw new ConfigValidationError([
      "Config file is not valid YAML; parser details are suppressed to protect credentials",
    ]);
  }
  if (!record(parsed))
    throw new ConfigValidationError([
      "Config file is empty or not a valid YAML object",
    ]);
  const resolved = resolveEnvVars(parsed);
  return validateConfig(resolved as Record<string, unknown>);
}

function resolveEnvVars(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(
      /\$\{([A-Z_][A-Z0-9_]*)\}|\$([A-Z_][A-Z0-9_]*)/g,
      (_, braced: string, plain: string) => {
        const name = braced || plain;
        const replacement = process.env[name];
        if (replacement === undefined)
          throw new ConfigValidationError([
            `Environment variable $${name} is not set (referenced in config)`,
          ]);
        return replacement;
      },
    );
  }
  if (Array.isArray(value)) return value.map(resolveEnvVars);
  if (record(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, resolveEnvVars(entry)]),
    );
  return value;
}

function validateConfig(raw: Record<string, unknown>): MigrationConfig {
  const issues: string[] = [];
  const groups: Record<string, string[]> = {
    source: [
      "provider",
      "apiBaseUrl",
      "organizationId",
      "apiPublicKey",
      "apiPrivateKey",
    ],
    target: [
      "provider",
      "apiBaseUrl",
      "organizationId",
      "userId",
      "apiPublicKey",
      "apiPrivateKey",
      "signerPublicKey",
    ],
    resources: ["wallets", "privateKeys", "mnemonicLanguage"],
    state: ["manifestPath"],
  };
  if (Object.keys(raw).some((key) => !Object.hasOwn(groups, key)))
    issues.push("Config contains unsupported top-level fields");
  for (const [name, allowed] of Object.entries(groups)) {
    const group = raw[name];
    if (!record(group)) {
      issues.push(`${name}: missing or not an object`);
      continue;
    }
    if (Object.keys(group).some((key) => !allowed.includes(key)))
      issues.push(`${name}: contains unsupported fields`);
    if (name === "resources") {
      for (const key of ["wallets", "privateKeys"]) {
        const selection = group[key];
        if (
          selection !== undefined &&
          selection !== "all" &&
          !(
            Array.isArray(selection) &&
            selection.every(text) &&
            new Set(selection).size === selection.length
          )
        ) {
          issues.push(
            `resources.${key}: must be 'all' or a list of distinct non-empty IDs`,
          );
        }
      }
      if (
        group.mnemonicLanguage !== undefined &&
        group.mnemonicLanguage !== "MNEMONIC_LANGUAGE_ENGLISH"
      )
        issues.push("resources.mnemonicLanguage: only English is supported");
      continue;
    }
    for (const key of allowed)
      if (!text(group[key]))
        issues.push(`${name}.${key}: required non-empty string`);
    if (name === "source" || name === "target") {
      if (group.provider !== (name === "source" ? "turnkey" : "0xkey"))
        issues.push(`${name}.provider: incorrect provider`);
      if (text(group.apiBaseUrl)) {
        try {
          const url = new URL(group.apiBaseUrl);
          if (
            url.protocol !== "https:" ||
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            url.pathname !== "/"
          )
            throw new Error();
          if (name === "source" && url.origin !== "https://api.turnkey.com")
            throw new Error();
          if (
            name === "target" &&
            (url.hostname.endsWith(".example") || url.hostname === "localhost")
          )
            throw new Error();
          group.apiBaseUrl = url.origin;
        } catch {
          issues.push(
            `${name}.apiBaseUrl: requires an approved HTTPS origin without credentials, path, query, or fragment`,
          );
        }
      }
    }
  }
  if (
    record(raw.target) &&
    text(raw.target.signerPublicKey) &&
    !/^04[0-9a-fA-F]{128}$/.test(raw.target.signerPublicKey)
  )
    issues.push(
      "target.signerPublicKey: expected an independently verified uncompressed P-256 public key (hex)",
    );
  if (issues.length) throw new ConfigValidationError(issues);
  const config = raw as unknown as MigrationConfig;
  config.resources.wallets ??= [];
  config.resources.privateKeys ??= [];
  config.target.signerPublicKey = config.target.signerPublicKey.toLowerCase();
  return config;
}
