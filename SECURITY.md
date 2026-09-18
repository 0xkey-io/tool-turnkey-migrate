# Security

## Trust model

This is a customer-operated local migration client. It holds API signing credentials and briefly processes plaintext key material. Trust the machine, the installed dependencies, both API deployments, and the independently provisioned signer keys before running it.

Turnkey exports use the signer trust anchor supplied by the pinned official crypto SDK. The 0xkey import signer key must be provided through configuration after independent verification with the deployment operator. A bundle's own public key is not a trust anchor. Signature, organization, or user validation failures must not be bypassed.

The tool intentionally persists only resource metadata and migration state, not mnemonic/private-key values or bundles. State still identifies organizations and resources and must remain private. Avoid tracing SDK requests, heap snapshots, crash dumps, shared execution hosts, and synced state directories. JavaScript and the operating system do not provide a guarantee that all plaintext copies can be erased.

Import submissions with uncertain results are not automatically repeated. Preserve state and reconcile activities and target resources before authorizing any further transfer. This tool does not authorize production cutover or delete source resources.

## Reporting a vulnerability

Do not open a public issue containing exploit details, secrets, customer data, or bundles. Use the repository's private vulnerability reporting feature when enabled, or your established private 0xkey support channel.

Include the affected version/commit, impact, synthetic reproduction steps, and relevant safe error codes. Never send real private keys or mnemonics. Sanitized metadata should be shared only when necessary and through an approved channel.
