---
name: api-doctor
description: Diagnose a failing HTTP API request using specification evidence, controlled retries, and post-fix verification.
---

# API Doctor

Use this skill when the user provides a curl command, HTTP request, OpenAPI operation, or API failure.

1. Normalize the input into method, URL, headers, query, body, expected response, and environment.
2. Never print secrets. Replace Authorization, Cookie, and token values with `<redacted>` in explanations and traces.
3. Read the provided API specification before proposing changes. Separate facts from hypotheses.
4. Execute only against an explicitly allowed test host. Treat write methods as state-changing even when the endpoint name looks harmless.
5. Diagnose in this order: transport, method/path, authentication/authorization, content type, schema, rate limit, server failure.
6. Make one evidence-backed change per attempt. Stop after the configured attempt budget.
7. A fix is complete only after the corrected request succeeds or the remaining blocker is explicitly reported.
8. Return root cause, evidence, changed fields, attempt history, final request with secrets redacted, and verification result.

For the repository's deterministic MVP, run `npm run demo`. The same workflow will later call the Pi-backed reasoner through the `Reasoner` interface.
