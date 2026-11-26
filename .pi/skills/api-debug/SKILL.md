---
name: api-debug
description: Systematic workflow for diagnosing and verifying HTTP API failures against OpenAPI contracts with strict evidence grounding.
---

# API Debug & Verification Skill

When investigating a failing HTTP request or unexpected API response:

1. **Locate the contract first**: Use `search_openapi` to find the matching operation and inspect required headers, path/query parameters, and JSON body schema before guessing fixes.
2. **Establish a baseline observation**: Execute the failing request through `execute_http` to capture an immutable, redacted baseline Evidence Artifact (status code, headers, body).
3. **Form explicit hypotheses**: Distinguish verified tool observations from hypotheses. Check failure classes in order: network/host -> HTTP method/path -> auth/headers -> Content-Type -> request body schema -> rate limit -> upstream 5xx.
4. **Apply minimal single-variable fixes**: Change only the evidence-backed parameter or header. If a write/mutating request triggers `APPROVAL_REQUIRED`, stop immediately and wait for human approval; after approval, reissue the exact tool call.
5. **Verify before completion**: Never claim a fix succeeded without a post-fix `execute_http` observation returning 2xx for the same target operation. Cite exact Evidence Artifact IDs when calling `submit_completion`.
