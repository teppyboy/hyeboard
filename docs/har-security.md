# HAR Security

HAR captures are sensitive. They may contain cookies, SAML responses, OAuth codes, tokens, student IDs, names, emails, and internal endpoint details.

Rules:

- Never commit raw `.har` files.
- Never paste raw header values, cookies, SAML payloads, auth codes, or response bodies containing PII into docs or logs.
- Store only manually redacted samples under `samples/har-redacted/`.
- Document endpoint shapes and field names, not real values.
- Use Worker secrets for encryption keys.
