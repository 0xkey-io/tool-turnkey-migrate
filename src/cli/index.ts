#!/usr/bin/env node
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { ConfigValidationError, loadConfig } from "../core/config.js";
import { MigrationEngine } from "../core/engine.js";
import { ManifestStore } from "../core/manifest.js";
import { createZeroXKeyTargetClient } from "../core/target-0xkey.js";
import { createTurnkeySourceClient } from "../core/source-turnkey.js";
import { verifyMigration } from "../core/verify.js";
import { validateMigratedData } from "../core/data-validate.js";
import { createLogger } from "../core/logger.js";
import { ToolError, safeError } from "../core/errors.js";
import type { MigrationConfig } from "../types/config.js";

interface Options {
  config: string;
  json?: boolean;
  manifest?: string;
  confirm?: boolean;
  rps?: number;
}
const program = new Command()
  .name("turnkey-migrate")
  .version("0.1.0")
  .description(
    "Transfer selected wallets and private keys from Turnkey to 0xkey",
  )
  .exitOverride();
program.configureOutput({ outputError: () => {} });

function rateLimit(value: string): number {
  if (
    !/^[0-9]+$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < 1 ||
    Number(value) > 100
  ) {
    throw new InvalidArgumentError("--rps requires an integer from 1 to 100.");
  }
  return Number(value);
}
function command(name: string, description: string, json = true): Command {
  const cmd = program
    .command(name)
    .description(description)
    .requiredOption("-c, --config <path>", "Migration YAML configuration");
  if (json)
    cmd.option(
      "--json",
      "Write one JSON result to stdout; diagnostics go to stderr",
    );
  return cmd;
}
function output(value: unknown, json: boolean | undefined, text: string): void {
  process.stdout.write(
    json ? JSON.stringify(value, null, 2) + "\n" : text + "\n",
  );
}
function privateState(
  config: MigrationConfig,
  readOnly = false,
): ManifestStore {
  return new ManifestStore(
    config.state.manifestPath,
    config.source.organizationId,
    config.target.organizationId,
    config.target.userId,
    {
      memoryOnly: readOnly,
      deployment: {
        sourceApiBaseUrl: config.source.apiBaseUrl,
        targetApiBaseUrl: config.target.apiBaseUrl,
        targetSignerPublicKey: config.target.signerPublicKey,
      },
    },
  );
}
function logger(config: MigrationConfig, json?: boolean) {
  return createLogger({
    json,
    redactValues: [config.source.apiPrivateKey, config.target.apiPrivateKey],
  });
}
function stopHandlers(
  engine: MigrationEngine,
  config: MigrationConfig,
  json?: boolean,
): () => void {
  const log = logger(config, json);
  const stop = () => {
    engine.abort();
    log.warn(
      "Interrupt requested; finishing the current resource and saving state.",
    );
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return () => {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  };
}

command(
  "plan",
  "Read source metadata and save a plan; no secret export/import",
).action(async (opts: Options) => {
  const config = await loadConfig(opts.config);
  const engine = new MigrationEngine({
    config,
    logger: logger(config, opts.json),
  });
  await engine.init();
  try {
    const items = await engine.discover();
    output(
      {
        command: "plan",
        pending: items.length,
        manifest: engine.getManifest(),
      },
      opts.json,
      `Plan saved. Selected pending resources: ${items.length}.\nSource organization: ${config.source.organizationId}\nTarget organization: ${config.target.organizationId}\nReview the private manifest before authorizing transfer.`,
    );
  } finally {
    await engine.finish();
  }
});

command(
  "dry-run",
  "Read-only preflight; does not prove export/import authorization",
).action(async (opts: Options) => {
  const config = await loadConfig(opts.config);
  const engine = new MigrationEngine({
    config,
    dryRun: true,
    logger: logger(config, opts.json),
  });
  await engine.init();
  try {
    await engine.discover();
    const result = await engine.migrateAll();
    output(
      {
        command: "dry-run",
        result,
        manifest: engine.getManifest(),
        writePermissionsTested: false,
      },
      opts.json,
      `Read-only preflight finished. Candidates: ${result.skipped}; conflicts/unresolved: ${result.failed}.\nNo state was written. Export/import authorization has not been exercised.`,
    );
    if (result.failed) process.exitCode = 1;
  } finally {
    await engine.finish();
  }
});

for (const name of ["run", "resume"]) {
  const cmd = command(
    name,
    name === "run"
      ? "Transfer selected resources with explicit authorization"
      : "Reconcile recorded activities and retry safe pre-import failures",
  )
    .option(
      "--confirm",
      "Authorize export/import after reviewing the plan and destination",
    )
    .option(
      "--rps <number>",
      "API token-bucket rate, integer 1–100 (default 5)",
      rateLimit,
      5,
    );
  if (name === "resume")
    cmd.option(
      "-m, --manifest <path>",
      "Override the configured manifest path",
    );
  cmd.action(async (opts: Options) => {
    if (!opts.confirm)
      throw new ToolError(
        "E_CONFIRM_REQUIRED",
        "Review the plan and destination, then pass --confirm to authorize export/import.",
      );
    const config = await loadConfig(opts.config);
    if (opts.manifest) config.state.manifestPath = opts.manifest;
    const engine = new MigrationEngine({
      config,
      rateLimitRps: opts.rps,
      logger: logger(config, opts.json),
    });
    // Writes require an existing reviewed plan; resume never starts with empty state.
    await engine.init(true);
    const removeHandlers = stopHandlers(engine, config, opts.json);
    try {
      if (name === "resume") await engine.resetFailed();
      await engine.discover(false);
      const result = await engine.migrateAll();
      const manifest = engine.getManifest();
      const unresolved = manifest.items.filter((item) => {
        const filter =
          item.resourceType === "wallet"
            ? config.resources.wallets
            : config.resources.privateKeys;
        return (
          (filter === "all" || filter.includes(item.sourceId)) &&
          !["imported", "verified"].includes(item.status)
        );
      }).length;
      process.exitCode = result.aborted
        ? 130
        : result.failed || unresolved
          ? 1
          : 0;
      output(
        { command: name, result, unresolved, manifest },
        opts.json,
        `Transfer finished. Imported/reconciled: ${result.imported}; matching existing targets: ${result.skipped}; failed: ${result.failed}; unresolved: ${unresolved}.\nRun verify and validate-data before acceptance.`,
      );
    } finally {
      removeHandlers();
      await engine.finish();
    }
  });
}

command(
  "verify",
  "Verify target identities against saved source metadata; update state",
)
  .option("-m, --manifest <path>", "Override the configured manifest path")
  .action(async (opts: Options) => {
    const config = await loadConfig(opts.config);
    if (opts.manifest) config.state.manifestPath = opts.manifest;
    const store = privateState(config);
    await store.acquireLock();
    try {
      await store.load(true);
      const results = await verifyMigration(
        store,
        await createZeroXKeyTargetClient(config.target),
      );
      const failed = results.filter((r) => !r.passed).length;
      process.exitCode = !results.length || failed ? 1 : 0;
      output(
        { command: "verify", total: results.length, failed, results },
        opts.json,
        results.length
          ? `Verification finished. Passed: ${results.length - failed}/${results.length}.`
          : "No resources were verified. This does not establish migration success.",
      );
    } finally {
      await store.releaseLock();
    }
  });

command(
  "validate-data",
  "Compare current source and target identities; no state writes",
)
  .option("-m, --manifest <path>", "Override the configured manifest path")
  .action(async (opts: Options) => {
    const config = await loadConfig(opts.config);
    if (opts.manifest) config.state.manifestPath = opts.manifest;
    const store = privateState(config, true);
    await store.load(true);
    const report = await validateMigratedData(
      store,
      await createTurnkeySourceClient(config.source),
      await createZeroXKeyTargetClient(config.target),
    );
    process.exitCode = !report.total || report.failed ? 1 : 0;
    output(
      { command: "validate-data", ...report },
      opts.json,
      report.total
        ? `Live identity validation finished. Passed: ${report.passed}/${report.total}; failed: ${report.failed}.`
        : "No resources were validated. This does not establish migration success.",
    );
  });

try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof CommanderError && error.exitCode === 0)
    process.exitCode = 0;
  else {
    const message =
      error instanceof ConfigValidationError
        ? error.message
        : error instanceof CommanderError
          ? "E_CLI_OPTIONS: Invalid command/options; --rps requires an integer from 1 to 100. Use --help."
          : safeError(error);
    process.stderr.write(message + "\n");
    process.exitCode = 2;
  }
}
