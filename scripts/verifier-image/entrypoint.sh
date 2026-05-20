#!/usr/bin/env bash
# IFleet verifier entrypoint — M1.W2
#
# Runs inside ifleet-verifier:base against a worktree mounted at /work.
# Phase order: install → build → typecheck → lint → test
# Exits non-zero on first hard failure (install/build). lint failure is
# non-fatal (continues but exits 1 at end). Prints structured headers so
# the failure parser in sandbox.ts can identify which phase failed.
#
# Usage (from DockerSandboxRunner):
#   docker run --rm -v /path/to/worktree:/work ifleet-verifier:base
#
# Environment variables honoured:
#   VERIFIER_SKIP_PHASES   comma-separated phase names to skip (e.g. "lint,test")
#   VERIFIER_FROZEN        set to "0" to use --no-frozen-lockfile (default: frozen)

set -euo pipefail

WORKDIR=/work
SKIP_PHASES="${VERIFIER_SKIP_PHASES:-}"
FROZEN="${VERIFIER_FROZEN:-1}"
EXIT_CODE=0

log_phase() {
  echo ""
  echo "=== PHASE: $1 ==="
}

is_skipped() {
  local phase="$1"
  case ",$SKIP_PHASES," in
    *",$phase,"*) return 0 ;;
    *) return 1 ;;
  esac
}

has_script() {
  local script_name="$1"
  node -e "
    const fs = require('fs');
    const p = JSON.parse(fs.readFileSync('${WORKDIR}/package.json', 'utf8'));
    process.exit(p.scripts && p.scripts['${script_name}'] ? 0 : 1);
  " 2>/dev/null
}

cd "$WORKDIR"

# ---- install ----
log_phase "install"
if is_skipped "install"; then
  echo "SKIP: install skipped via VERIFIER_SKIP_PHASES"
else
  # Patch pnpm-workspace.yaml for older SHAs (pre-PR #115): ensure
  # better-sqlite3 native build scripts are allowed.
  WSYAML="${WORKDIR}/pnpm-workspace.yaml"
  if [ -f "$WSYAML" ] && ! grep -q "better-sqlite3" "$WSYAML"; then
    printf '\nonlyBuiltDependencies:\n  - better-sqlite3\n' >> "$WSYAML"
    echo "INFO: patched pnpm-workspace.yaml to allow better-sqlite3 build scripts"
  fi

  INSTALL_FLAGS="--prefer-offline"
  if [ "$FROZEN" = "1" ]; then
    INSTALL_FLAGS="$INSTALL_FLAGS --frozen-lockfile"
  else
    INSTALL_FLAGS="$INSTALL_FLAGS --no-frozen-lockfile"
  fi

  # Retry once on network failure (per ADR-0002)
  # shellcheck disable=SC2086
  if ! pnpm install $INSTALL_FLAGS; then
    echo "WARN: pnpm install failed, retrying after 2s ..."
    sleep 2
    # shellcheck disable=SC2086
    if ! pnpm install $INSTALL_FLAGS; then
      echo "ERROR: install failed after retry"
      exit 1
    fi
  fi
fi

# ---- build ----
log_phase "build"
if is_skipped "build"; then
  echo "SKIP: build skipped via VERIFIER_SKIP_PHASES"
elif has_script "build"; then
  if ! pnpm run build; then
    echo "ERROR: build failed"
    exit 1
  fi
else
  echo "SKIP: no 'build' script in package.json"
fi

# ---- typecheck ----
log_phase "typecheck"
if is_skipped "typecheck"; then
  echo "SKIP: typecheck skipped via VERIFIER_SKIP_PHASES"
elif has_script "typecheck"; then
  if ! pnpm run typecheck; then
    echo "ERROR: typecheck failed"
    exit 1
  fi
else
  echo "SKIP: no 'typecheck' script in package.json"
fi

# ---- lint ----
log_phase "lint"
if is_skipped "lint"; then
  echo "SKIP: lint skipped via VERIFIER_SKIP_PHASES"
elif has_script "lint"; then
  if ! pnpm run lint; then
    echo "WARN: lint failed (non-fatal)"
    EXIT_CODE=1
  fi
else
  echo "SKIP: no 'lint' script in package.json"
fi

# ---- test ----
log_phase "test"
if is_skipped "test"; then
  echo "SKIP: test skipped via VERIFIER_SKIP_PHASES"
elif has_script "test"; then
  # The `test` script may use `node --test 'glob/**/*.ts'` with single-quoted
  # patterns. Node 20 (inside this container) does not expand globs in --test —
  # it requires real file paths. This causes "Could not find '.../*.test.ts'"
  # on all historical SHAs even though test files exist.
  #
  # Strategy: if vitest is installed, run it directly (covers Vitest tests).
  # Then if the test script also contains `node --test`, run that part with
  # explicit glob expansion via bash. This matches what the in-worktree
  # baseline does on macOS (zsh + Node 24 expands globs before node sees them).
  TEST_FAILED=0

  # Step 1: vitest (non-glob, always reliable)
  if [ -f "${WORKDIR}/node_modules/.bin/vitest" ]; then
    if ! pnpm exec vitest run; then
      echo "WARN: vitest failed"
      TEST_FAILED=1
    fi
  fi

  # Step 2: node --test portion — extract glob patterns from the test script
  # and expand them with bash's own globbing before handing to node.
  TEST_SCRIPT=$(node -e "
    const fs = require('fs');
    const p = JSON.parse(fs.readFileSync('${WORKDIR}/package.json', 'utf8'));
    process.stdout.write(p.scripts && p.scripts['test'] ? p.scripts['test'] : '');
  " 2>/dev/null)

  if echo "$TEST_SCRIPT" | grep -q 'node --'; then
    # Enable bash globstar so ** works
    shopt -s globstar nullglob
    cd "${WORKDIR}"
    # Collect all .test.ts / .test.js files
    TEST_FILES=( src/**/*.test.ts src/**/*.test.js )
    if [ "${#TEST_FILES[@]}" -gt 0 ]; then
      if ! node --import tsx --test "${TEST_FILES[@]}"; then
        echo "WARN: node --test runner failed"
        TEST_FAILED=1
      fi
    else
      echo "INFO: no .test.ts/.test.js files found — skipping node --test runner"
    fi
  fi

  if [ "$TEST_FAILED" -ne 0 ]; then
    echo "ERROR: test failed"
    EXIT_CODE=1
  fi
else
  echo "SKIP: no 'test' script in package.json (verified: partial)"
fi

if [ "$EXIT_CODE" -eq 0 ]; then
  echo ""
  echo "=== VERIFIER: PASSED ==="
else
  echo ""
  echo "=== VERIFIER: FAILED ==="
fi

exit "$EXIT_CODE"
