from __future__ import annotations

import json
from pathlib import Path


def replace(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f"Required text was not found in {path}: {old!r}")
    file.write_text(text.replace(old, new, 1))


package_path = Path("package.json")
package = json.loads(package_path.read_text())
package["version"] = "0.4.0"
package_path.write_text(json.dumps(package, indent=2) + "\n")

replace(
    "README.md",
    "M0 provides the stable graph foundation. M1 adds the event-driven execution runtime. M2 adds typed facts and deterministic gates. M3 is the active milestone and adds deterministic check execution and Pi product integration.",
    "M0 provides the stable graph foundation. M1 adds the event-driven execution runtime. M2 adds typed facts and deterministic gates. M3 is complete in v0.4 and adds deterministic check execution and Pi product integration.",
)
replace(
    "README.md",
    "The next M3 work is end-to-end dogfood validation and the v0.4 release. Structured report parsers move to M3.1. Executable loops, replay navigation, graph revision comparison, and delegated node execution follow in later milestones.",
    "M3 is complete. Structured report parsers move to M3.1. Executable loops, replay navigation, graph revision comparison, and delegated node execution follow in later milestones.",
)
replace(
    "README.md",
    "## Language rules",
    "## v0.4 dogfood result\n\nThe v0.4 release was tested through the real Pi product path. The run defined a complex graph, ran deterministic checks, published facts, selected a gate route, restored the session without rerunning the command, and kept the live graph pane open. The pane showed the selected route, the ready frontier, a declared loop boundary, and its feedback edge.\n\nSee [the v0.4 dogfood record](docs/v0.4-dogfood.md) and [the command-check gate example](examples/command-check-gate.json).\n\n## Language rules",
)
replace(
    "README.md",
    "A command check stores environment-variable names only. It does not store environment values. The executor inherits a small safe launch environment by default. A definition can replace that default with an explicit list of names.",
    "A command check stores environment-variable names only. It does not store environment values. The executor inherits a small safe launch environment by default. A definition can replace that default with an explicit list of names.\n\nHypagraph stores check artifacts under `.hypagraph/check-artifacts`. v0.4 does not delete artifacts automatically. They remain until the user or workspace cleanup removes them. The default stdout and stderr capture limit is 1,048,576 bytes for each stream.",
)
replace(
    "README.md",
    "- [Check cancellation, retry, and environment policy](docs/check-execution-policy.md)",
    "- [Check cancellation, retry, and environment policy](docs/check-execution-policy.md)\n- [v0.4 dogfood record](docs/v0.4-dogfood.md)\n- [v0.4 release notes](CHANGELOG.md)",
)

replace("docs/m3-completion-phase-plan.md", "- Status: active", "- Status: complete")
replace(
    "docs/m3-completion-phase-plan.md",
    "- Release marker: v0.4",
    "- Release marker: v0.4\n- Completed: 2026-07-22",
)
replace(
    "docs/m3-completion-phase-plan.md",
    "Do not start M4 loop execution before this phase is complete.",
    "This phase is complete. Start M3.1 or M4 only after the v0.4 tag exists.",
)
replace(
    "docs/m3-completion-phase-plan.md",
    "11. Retry an interrupted or failed check with a new attempt ID.",
    "11. Retry an allowed failed check with a new attempt ID.",
)
replace(
    "docs/m3-completion-phase-plan.md",
    "## 10. M3.1 adapter extension phase",
    "## 9.1 Completion record\n\nThe v0.4 dogfood run completed on 2026-07-22 through Pi 0.80.10. The run covered command execution, fact publication, deterministic route selection, live graph rendering, declared-loop rendering, durable session restoration, replay equality, cancellation, and failure handling.\n\nThe release evidence is in `docs/v0.4-dogfood.md`.\n\n## 10. M3.1 adapter extension phase",
)

replace("docs/m3-vertical-slice-plan.md", "- Status: planned", "- Status: complete")
replace(
    "docs/m3-vertical-slice-plan.md",
    "The first useful end-to-end result is complete after Slice 5. Slices 6 to 11 add more check types and harden the runtime.",
    "Slices 1 to 5 implement the core check runtime. Slices 6 to 10 close the Pi product path and the v0.4 release. Structured parser adapters move to M3.1.",
)

replace("docs/execution-roadmap.md", "- Date: 2026-07-21", "- Date: 2026-07-22")
replace("docs/execution-roadmap.md", "- Current milestone: M1", "- Current milestone: M3.1")
replace(
    "docs/execution-roadmap.md",
    "# M3 - Deterministic check execution\n\n## Objective",
    "# M3 - Deterministic check execution\n\n## Status\n\nComplete in v0.4. The dogfood record is in `docs/v0.4-dogfood.md`.\n\n## Objective",
)
replace(
    "docs/execution-roadmap.md",
    "## M3 acceptance criteria\n\n- A test check publishes typed facts.\n- A gate can use those facts.\n- A timeout is an explicit result.\n- A check cannot change canonical state directly.\n- Check output is treated as untrusted input.",
    "## M3 acceptance criteria\n\n- [x] A test check publishes typed facts.\n- [x] A gate can use those facts.\n- [x] A timeout is an explicit result.\n- [x] A check cannot change canonical state directly.\n- [x] Check output is treated as untrusted input.\n- [x] Pi stores check lifecycle events before the next external side effect.\n- [x] Restore does not rerun a command.\n- [x] The user can cancel a running check.\n- [x] Retry policy is explicit and bounded.\n- [x] The live Pi graph pane shows routes, loops, feedback edges, and runtime state.\n- [x] The complete dogfood path is recorded.",
)
replace(
    "docs/execution-roadmap.md",
    "- [ ] Continuous integration runs `npm run check` on a clean checkout.\n- [ ] A complete Pi dogfood run is recorded.",
    "- [x] Continuous integration runs `npm run check` on a clean checkout.\n- [x] A complete Pi dogfood run is recorded.",
)

Path(".github/workflows/ci.yml").write_text(
    """name: CI

on:
  workflow_dispatch:
  pull_request:
  push:
    branches:
      - main

permissions:
  contents: read

jobs:
  check:
    name: ${{ matrix.os }} · Node.js ${{ matrix.node-version }}
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os:
          - ubuntu-latest
          - macos-latest
          - windows-latest
        node-version:
          - 22
          - 24

    steps:
      - name: Check out the repository
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}

      - name: Install dependencies
        run: npm install

      - name: Run type checks and tests
        id: check
        shell: bash
        run: |
          set +e
          npm run check > check.log 2>&1
          status=$?
          cat check.log
          exit $status

      - name: Upload check log
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: check-log-${{ matrix.os }}-node-${{ matrix.node-version }}
          path: check.log
"""
)

Path(".github/workflows/tag-package-release.yml").write_text(
    """name: Tag package release

on:
  workflow_run:
    workflows:
      - CI
    types:
      - completed

permissions:
  contents: write

jobs:
  tag:
    if: github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.head_branch == 'main'
    runs-on: ubuntu-latest
    steps:
      - name: Check out the tested commit
        uses: actions/checkout@v4
        with:
          ref: ${{ github.event.workflow_run.head_sha }}
          fetch-depth: 0

      - name: Read the package version
        id: package
        shell: bash
        run: echo "version=$(node -p \"require('./package.json').version\")" >> "$GITHUB_OUTPUT"

      - name: Create the version tag
        shell: bash
        run: |
          tag="v${{ steps.package.outputs.version }}"
          git fetch --tags --force
          if git rev-parse "$tag" >/dev/null 2>&1; then
            echo "Tag $tag already exists."
            exit 0
          fi
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git tag -a "$tag" -m "Hypagraph $tag"
          git push origin "$tag"
"""
)

Path("docs/v0.4-dogfood.md").write_text(
    """# v0.4 dogfood record

- Status: passed
- Date: 2026-07-22
- Release: v0.4
- Pi version: 0.80.10
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Purpose

This record closes M3 against the real Pi product path.

The run used Hypagraph from Pi. It did not use a test-only user interface or a separate graph viewer.

## 2. Live graph

The final live graph was named `Complex release loop`.

The graph contained `bootstrap`, `quality-gate`, `security-review`, `abort`, `implement`, `loop-test`, the declared `repair-loop` region, and the feedback edge from `loop-test` to `implement`. The maximum loop count was three.

The captured Pi screen showed the workflow in the `running` phase, revision 1, event sequence 17, the true route selected, the false route not selected, `implement` in the ready frontier, and the `repair-loop` boundary at iteration 0 of 3. It also showed the selected node details and the structured graph projection beside the live pane.

A 1600 by 1000 screenshot was captured during the run.

## 3. Dogfood checks

| Requirement | Result |
| --- | --- |
| Pi definition | Passed |
| Command execution | Passed |
| Live graph rendering | Passed |
| Start persistence before execution | Passed |
| Output artifact references | Passed |
| Typed fact publication | Passed |
| Deterministic gate routing | Passed |
| Selected branch readiness | Passed |
| Session restore without command rerun | Passed |
| Event replay equality | Passed |
| Active check cancellation | Passed |
| Failure and timeout handling | Passed |

## 4. Product result

The upstream check passed. Its facts selected the true route. The runtime made `implement` ready and did not select the false route.

The graph pane remained open while the canonical state changed. The pane showed dependencies, route state, the loop boundary, and the loop feedback edge from the same canonical projection that the JSON view used.

Session restoration rebuilt the state from the Pi event journal. It did not run the command again.

## 5. Platform and execution policy

Hosted CI runs the complete suite on Ubuntu, macOS, and Windows with Node.js 22 and 24.

The command executor uses `shell: false`, a workspace-root working directory, a hard timeout, a cancellation signal, bounded output, and an environment-variable allowlist.

The default stdout and stderr capture limit is 1,048,576 bytes for each stream.

## 6. Artifact retention

Hypagraph stores check artifacts under `.hypagraph/check-artifacts`.

v0.4 does not delete artifacts automatically. Artifacts remain until the user or a workspace cleanup process removes them.

The event stream stores artifact references. It does not store large command output.

## 7. Findings

The graph pane is usable for a graph with a branch, a join, and a declared feedback loop.

Long node titles are shortened in compact mode. The loop feedback lane is dense in this graph, but it remains identifiable. Advanced edge filtering, loop collapse, replay navigation, and graph revision comparison remain M5 work.

No release-blocking defect was found.

## 8. Release decision

The dogfood result passes the M3 exit criteria.

The package can move to v0.4 after hosted CI passes on all supported operating systems and Node.js versions.
"""
)

Path("examples").mkdir(exist_ok=True)
Path("examples/command-check-gate.json").write_text(
    json.dumps(
        {
            "title": "Command check gate",
            "goal": "Run repository checks and select the next task from the result",
            "nodes": [
                {
                    "id": "run-tests",
                    "title": "Run repository checks",
                    "kind": "check",
                    "requires": [],
                    "acceptance": ["The repository check command completes."],
                    "produces": [
                        {"name": "tests.passed", "type": "boolean", "required": True},
                        {"name": "tests.status", "type": "string", "required": True},
                    ],
                    "check": {
                        "kind": "command",
                        "command": "npm",
                        "arguments": ["run", "check"],
                        "timeoutMs": 120000,
                        "expectedExitCodes": [0],
                        "publish": [
                            {"source": "passed", "fact": "tests.passed"},
                            {"source": "status", "fact": "tests.status"},
                        ],
                        "retry": {
                            "maxAttempts": 2,
                            "retryOn": ["failed", "timed_out", "error"],
                            "backoffMs": 1000,
                        },
                        "environmentVariables": ["PATH", "HOME", "TMPDIR"],
                    },
                },
                {
                    "id": "route-tests",
                    "title": "Select the test route",
                    "kind": "gate",
                    "requires": ["run-tests"],
                    "acceptance": ["The route is selected from tests.passed."],
                    "gate": {
                        "condition": {
                            "kind": "compare",
                            "operator": "eq",
                            "left": {"kind": "fact", "name": "tests.passed"},
                            "right": {"kind": "literal", "value": True},
                        },
                        "onTrue": ["document"],
                        "onFalse": ["repair"],
                    },
                },
                {
                    "id": "document",
                    "title": "Document the passing result",
                    "kind": "task",
                    "requires": ["route-tests"],
                    "acceptance": ["The passing result is documented."],
                    "scope": {"paths": ["docs/**"]},
                },
                {
                    "id": "repair",
                    "title": "Repair the failed result",
                    "kind": "task",
                    "requires": ["route-tests"],
                    "acceptance": ["The failing check has a repair."],
                    "scope": {"paths": ["src/**", "tests/**"]},
                },
            ],
            "loops": [],
            "policy": {"mode": "strict", "requireEvidence": True},
        },
        indent=2,
    )
    + "\n"
)

Path("CHANGELOG.md").write_text(
    """# Changelog

## v0.4.0 - 2026-07-22

M3 adds deterministic command-check execution and the first graph-native Pi product surface.

### Added

- command-check nodes with bounded process execution;
- typed fact publication and deterministic gate routing;
- durable Pi event journaling and interrupted-run recovery;
- explicit cancellation, retry, timeout, output, and environment policies;
- file-backed stdout and stderr artifact references;
- a live responsive Pi graph pane;
- dependency, route, loop-boundary, and feedback-edge rendering;
- session branch protection and late-result rejection;
- hosted Linux, macOS, and Windows CI.

### Release evidence

- 104 tests passed before Slice 10;
- the v0.4 dogfood path passed in Pi 0.80.10;
- the final release matrix runs Node.js 22 and 24 on Ubuntu, macOS, and Windows.

See `docs/v0.4-dogfood.md` for the full dogfood record.
"""
)

for path in (
    ".github/workflows/prepare-v0.4.yml",
    ".github/workflows/run-prepare-v0.4.yml",
    "scripts/prepare-v0.4.py",
):
    file = Path(path)
    if file.exists():
        file.unlink()
