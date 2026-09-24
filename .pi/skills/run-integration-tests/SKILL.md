---
name: run-integration-tests
description: Run the integration test suite and verify all sessions end-to-end. Use when asked to run integration or e2e tests, test before release, or check everything works.
---

# Run integration tests

Run this workflow from inside herdr. This project supports no other terminal backend.

## Preflight

```bash
echo "HERDR_ENV=$HERDR_ENV"
command -v herdr
npm test
```

Stop and ask the user to start pi inside herdr if `HERDR_ENV` is not `1` or the CLI is missing.

## Integration suite

From the repository root, run the suite with the project's reliable test model:

```bash
PI_TEST_MODEL="deepseek/deepseek-flash" PI_TEST_TIMEOUT=180000 npm run test:integration
```

The full suite launches real Pi sessions and can take several minutes. `PI_TEST_TIMEOUT` is the per-test timeout in milliseconds; use at least `180000` for the lifecycle suite.

The harness loads the extension directly from the working tree and creates isolated test agents. `PI_TEST_MODEL` controls every real Pi/LLM session in the lifecycle suite; use `deepseek/deepseek-flash` instead of the slower, less predictable `openrouter/free` default. Report passing, failing, and skipped tests. Do not claim full verification when herdr-dependent tests were skipped.

## Diagnosing a failing suite

A model id that no longer exists does not fail loudly: pi falls back to its unauthenticated default, the parent session errors with "No API key found for openrouter", and every LLM-driven test times out waiting for a file or a screen pattern. Before reading a timeout as a regression, check that `PI_TEST_MODEL` resolves:

```bash
pi --list-models | grep deepseek
```

For a single test, pass `--test-name-pattern` and read the parent pane (`herdr pane read <pane> --source visible --lines 60`) to see the tool's actual error text.
