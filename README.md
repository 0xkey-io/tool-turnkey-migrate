# Turnkey → 0xkey migration tool

A local TypeScript CLI for transferring HD wallets and standalone private keys from a Turnkey organization into a 0xkey organization.

The tool discovers selected resources, exports encrypted bundles from Turnkey, decrypts and re-encrypts them on your machine, and imports them into 0xkey. Users, policies, API credentials, sessions, tags, activity history, and application cutover are outside its scope.

## Requirements

- Node.js 22.13+ on the 22.x line, or Node.js 24.x; npm.
- Source credentials authorized to read and export the selected Turnkey resources.
- Target credentials authorized to read, initialize imports, and import resources for the target user.
- A target API endpoint and **signer public key confirmed independently with your 0xkey deployment operator**. Never take the trusted signer key from an import bundle.
- A trusted workstation with network access to both APIs. Avoid shared runners, heap snapshots, debug tracing, and core dumps during a migration.

This repository is distributed as source. There is no npm installation or publication step for the CLI.

## Install

From a clone or downloaded copy of this repository:

```sh
npm ci --ignore-scripts
npm run check
node dist/cli/index.js --help
```

## Configure

```sh
cp migration.example.yaml migration.yaml
```

Edit the target endpoint and select a small, explicit set of resource IDs for your first migration. Set the environment variables referenced by the configuration using your secret-management workflow. The tool does not load `.env` files automatically. Do not place private credentials in shell history or commit them to Git.

## Workflow

```sh
mkdir -m 700 migration-state

# Read source metadata and save the local plan. No secret export or import.
node dist/cli/index.js plan --config migration.yaml

# Read-only preflight. Does not change the manifest or prove write permissions.
node dist/cli/index.js dry-run --config migration.yaml

# Review source, target, selection, and plan before authorizing writes.
node dist/cli/index.js run --config migration.yaml --confirm

# Verify identities against the saved source metadata.
node dist/cli/index.js verify --config migration.yaml

# Compare against live source and target metadata.
node dist/cli/index.js validate-data --config migration.yaml

# Reconcile recorded activities and retry only safe, pre-import failures.
node dist/cli/index.js resume --config migration.yaml --confirm
```

A successful import is not a cutover approval. Complete resource verification and application-level signing checks before changing traffic or retiring any source access. Keep protected backups of the manifest until acceptance and recovery requirements are satisfied.

See the [migration guide](docs/migration-guide.md) for commands, recovery, and limitations, and [SECURITY.md](SECURITY.md) for the trust model and reporting guidance.

## Security and recovery

- Bundle signatures are checked against independently trusted signer keys; bundle-provided keys do not establish trust.
- The tool does not intentionally persist secret material or encrypted bundles. Its state file contains operational metadata and must remain private.
- Owned secret buffers are cleared on success and error. JavaScript strings, SDK internals, operating-system swap, and crash dumps prevent a guarantee of complete memory erasure.
- Imports are not automatically resubmitted after an uncertain response. An item without a recoverable activity ID requires manual reconciliation.
- A local lock prevents concurrent writers to the same manifest. Do not run two migrations against the same target user, even with different manifests.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm audit
npm run release:check
gitleaks dir . --redact --no-banner
```

Tests use synthetic data and mocked API boundaries. They do not establish compatibility with a particular live deployment. Qualify each source/target version with dedicated test organizations before customer production use.

## License

Apache-2.0. See [LICENSE](LICENSE).

Execution validates the saved plan; newly discovered resources require a fresh plan review. State directories must be owned by the current user with mode `700`. Use macOS or Linux and a trusted local account. Filesystem checks reject links and observed replacements; they do not isolate the process from malicious programs running as the same user or root.
