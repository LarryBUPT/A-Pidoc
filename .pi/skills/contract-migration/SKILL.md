---
name: contract-migration
description: Safe workflow for analyzing OpenAPI breaking changes, mapping impacted client code calls, and verifying patches in an isolated sandbox workspace.
---

# Contract Migration & Isolated Verification Skill

When analyzing OpenAPI contract upgrades or repairing mismatched client API calls:

1. **Compare contracts**: Run `diff_openapi_contracts` to obtain structured breaking and non-breaking changes.
2. **Map repository impact**: Run `analyze_repository_impact` (or delegate to the read-only specialist subagent for large repositories) to locate concrete client calls affected by breaking changes.
3. **Propose lossless patches**: Run `propose_migration_patches` to generate reviewable literal patches without touching the source repository.
4. **Request approval for sandbox mutations**: Call `apply_patches_isolated` to copy the repository to an isolated workspace and apply patches. Because this mutates files, wait for explicit human approval (`APPROVAL_REQUIRED`).
5. **Run regression tests**: After isolated patches are applied, call `run_isolated_tests` (requiring approval) to prove the migrated client calls pass generated contract assertions.
6. **Submit grounded completion**: Call `submit_completion` citing the contract diff, impact report, isolated patch, and passing test run Artifact IDs.
