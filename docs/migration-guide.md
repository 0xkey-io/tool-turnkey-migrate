# Migration guide

## Scope and qualification

This CLI transfers HD wallets with their selected source account specifications and standalone secp256k1 / Ed25519 private keys. It does not migrate authorization, users, credentials, sessions, tags, sub-organization structure, or historical activities. Recreate and verify those separately.

Use one source organization, target organization, and target user per manifest. To migrate another organization, use a new configuration and manifest. The target API endpoint and trusted signer key must be obtained independently from your deployment operator. HTTPS is required; credentials, query parameters, and fragments are not allowed in base URLs.

Before production use, test the exact API deployments, resource curves, derivation paths, address formats, policies, and dependency versions you will use. A passing unit-test suite does not establish live compatibility.

## Installation and configuration

Use the Node.js version specified in `package.json` and install with `npm ci --ignore-scripts`, then run `npm run check`. The lockfile is part of the supported dependency baseline.

Copy `migration.example.yaml` to `migration.yaml`. The example intentionally selects no resources. Select explicit IDs first; use `all` only after reviewing the full discovery result. `$VARIABLE_NAME` and `${VARIABLE_NAME}` references are resolved within YAML string values without re-parsing their contents. Missing or empty required values fail configuration validation.

The manifest path is relative to the command's working directory. Its parent directory must already exist, be owned by the current user, and have mode `700` (for example, `mkdir -m 700 migration-state`). Use a trusted macOS or Linux account; same-user or root processes are outside the filesystem threat model. Configurations, manifests, and lock paths must not be symlinks, including their parent directories. Custom configuration filenames and custom state locations are still private; do not assume `.gitignore` protects every possible name.

Configure credentials using a local secret manager or a protected environment. Do not paste private credentials into tickets, terminal commands that retain history, or public issues. The source credentials need resource-read and export authorization; target credentials need resource-read, activity-read, initialization, and import authorization. Approval policies remain in force.

## Commands

| Command            | Effects                                                          | Notes                                                                                           |
| ------------------ | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `plan`             | Reads metadata and writes local state                            | Does not export or import secrets; reports selected pending resources.                          |
| `dry-run`          | Reads source and target metadata                                 | Does not write state or call export/import APIs; cannot prove write authorization.              |
| `run --confirm`    | Exports and imports selected resources; writes state             | Requires explicit confirmation. Does not automatically retry a submitted import.                |
| `resume --confirm` | Reconciles recorded activities; retries safe pre-import failures | Does not resubmit imports with an uncertain outcome.                                            |
| `verify`           | Reads target; updates verification state                         | Checks identity against the saved source metadata, including account derivation specifications. |
| `validate-data`    | Reads both APIs                                                  | Checks current source and target data; does not approve traffic cutover.                        |

All commands require `--config <path>`. `verify`, `validate-data`, and `resume` support `--manifest <path>`. `run` and `resume` support a positive integer `--rps`; this limits calls through the tool's API adapters, including pagination, retries, and polling. SDK-internal traffic is outside that limiter. `--json` keeps result JSON on stdout and diagnostic logs on stderr for commands that support it.

Exit codes: `0` for successful command execution; `1` for failed verification, incomplete migration, or unresolved items; `2` for configuration, initialization, or command errors; `130` for an interrupted migration. An empty verification result is not proof of successful migration and exits with code `1`.

## Recommended procedure

1. Confirm the source/target deployment baseline, organization IDs, target user, signer key, and authorization policies. Make a separate application rollback plan.
2. Select a small set of resources, run `plan`, and review the complete source metadata and destination.
3. Run `dry-run`. Resolve read errors and metadata conflicts. Export/import authorization still needs a controlled live test.
4. Run `run --confirm` from a trusted machine. Only one process may operate on a target user at a time.
5. Run both `verify` and `validate-data`. Missing addresses, wrong derivation paths, missing public keys, and mismatched identities are failures.
6. In a dedicated test environment, verify application signing behavior for each relevant chain and address format. Complete your own policy and credential checks.
7. Obtain your organization's cutover approval. Retain the protected manifest for reconciliation and audit; revoke migration credentials when no longer needed.

Wallet names and counts alone do not prove that keys were migrated correctly. Addresses are compared using their formats: Ethereum hex addresses are case-insensitive; Solana and other case-sensitive encodings are compared exactly. Wallet account comparison includes curve, path format, derivation path, address format, and address.

## State and interrupted runs

The state file stores organization/resource identifiers, names, public metadata, activity identifiers, status, and safe error codes. These are operationally sensitive even though they are not secret key material. Files created by the tool have owner-only permissions on platforms supporting POSIX permissions. Store them outside shared or synced folders.

| Status             | Meaning                                                  | Recovery                                                                       |
| ------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `discovered`       | Metadata recorded, transfer not started                  | Can be transferred if still selected.                                          |
| Export/init states | Import has not been submitted                            | Fresh ephemeral export/init can be attempted on resume.                        |
| `import_started`   | Submission intent recorded, possibly with an activity ID | Reconcile the activity; do not submit again blindly.                           |
| `imported`         | Target identity recorded                                 | Run verification.                                                              |
| `verified`         | Saved metadata checks passed                             | Recheck before acceptance; this is not a production compatibility certificate. |
| `failed`           | Failure occurred before import submission                | Resume can retry after resolving the cause.                                    |
| `needs_review`     | Import outcome or identity is uncertain                  | Reconcile manually; no automatic resubmission.                                 |

When an activity ID is available, `resume` queries that activity and records a completed result without re-exporting or re-importing. Pending approval, timeouts, rejected activities, and unavailable result identifiers require review. If the import response was lost before an activity ID could be recorded, inspect the target and its activities with your operator. Do not delete the manifest to bypass this protection.

If a duplicate has a fully matching target identity, the tool records its target ID for verification. Partial address overlap or uncertain identity is a conflict requiring review; it is not accepted as a migrated wallet.

Use Ctrl+C once to request stopping after the current resource. Allow state saving to finish. A second signal or forced process termination may leave a lock and an uncertain import outcome.

## Lock recovery

If a process crashed, the lock is retained rather than reclaimed automatically. Confirm that no process is using the manifest or target user, preserve the state file, and have an operator remove the stale lock. Never remove an active lock. A save failure is a reason to stop and inspect state, not to restart with an empty manifest.

## Limitations

- Processing is serial, and a manifest lock is local rather than distributed.
- English wallet mnemonics and the supported private-key curves are the qualified scope of this version. Other curves/languages are rejected rather than silently converted.
- Pagination is handled by the adapters; discovery rejects malformed or repeated cursors. Independently check resource counts against your source inventory.
- The tool does not freeze the source organization. Resource or account changes during transfer need reconciliation; prevent concurrent changes during your migration window.
- Policies requiring approval may interrupt the automated path. Do not weaken policies just to make a command complete.
- Old or malformed manifests are not upgraded silently. Preserve them and reconcile their deployment context before any conversion.

## Troubleshooting and support

Consult the safe error code in the manifest and investigate API activities in the relevant deployment. For authentication/read errors, verify the organization, user, credentials, and policy grants. For signer mismatches, stop and verify the signer key through an independent channel; never copy the bundle key into configuration as a workaround.

For support, share the CLI version, Node.js version, command name, a sanitized error code, and synthetic reproduction steps. Do not post a full configuration, manifest, encrypted bundle, mnemonic, or key. Use an approved private channel for any necessary operational metadata. See `SECURITY.md` for vulnerability reports.
