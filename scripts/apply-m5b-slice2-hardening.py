from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise RuntimeError(f"Unable to find patch target: {label}")
    if text.count(old) != 1:
        raise RuntimeError(f"Patch target is not unique: {label}")
    return text.replace(old, new, 1)


extension_path = Path("src/extension.ts")
extension = extension_path.read_text()

extension = replace_once(
    extension,
    '  renderReplacementRequired,\n} from "./pi/hypagoal.js";',
    '  renderReplacementRequired,\n  type HypagoalCreationRequest,\n} from "./pi/hypagoal.js";',
    "Hypagoal creation request import",
)
extension = replace_once(
    extension,
    'export default function hypagraphExtension(pi: ExtensionAPI): void {\n',
    '''interface PendingHypagoalAuthoring {\n  objective: string;\n  creationRequest: HypagoalCreationRequest;\n  replacementConfirmation?: ReturnType<typeof replacementConfirmationFor>;\n}\n\nexport default function hypagraphExtension(pi: ExtensionAPI): void {\n''',
    "pending authoring interface",
)
extension = replace_once(
    extension,
    '  let hypagoalAuthoring = false;',
    '  let hypagoalAuthoring: PendingHypagoalAuthoring | undefined;',
    "authoring state type",
)
extension = extension.replace('    hypagoalAuthoring = false;', '    hypagoalAuthoring = undefined;')
extension = extension.replace('    if (hypagoalAuthoring) {', '    if (hypagoalAuthoring !== undefined) {')
extension = replace_once(
    extension,
    '    if (hypagoalAuthoring && (event.toolName === "write" || event.toolName === "edit")) {',
    '    if (hypagoalAuthoring !== undefined && (event.toolName === "write" || event.toolName === "edit")) {',
    "read-only authoring guard",
)

extension = replace_once(
    extension,
    '''      const input = normalizeHypagoalStartInput(params);\n      const workflowId = randomUUID();\n      const goalId = `goal-${randomUUID()}`;\n      const result = await startRootHypagoal(eventStore.lease(), state, {\n        objective: input.objective,\n        definition: input.definition,\n        workflowId,\n        goalId,\n        goalWorkflowId: workflowId,\n        at: new Date().toISOString(),\n        sessionGeneration,\n        branchGeneration,\n        advisories: input.advisories,\n        ...(input.replacementConfirmation === undefined\n          ? {}\n          : { replacementConfirmation: input.replacementConfirmation }),\n      });\n      hypagoalAuthoring = false;\n''',
    '''      const input = normalizeHypagoalStartInput(params);\n      const pending = hypagoalAuthoring;\n      const suppliedCreation = input.creationRequest;\n      const rejectCreationRequest = (code: string, message: string) => ({\n        content: [{ type: "text" as const, text: `Hypagoal was not created. Canonical state is unchanged.\\n${code}: ${message}` }],\n        details: { hypagoal: { kind: "rejected", diagnostics: [{ code, message }] } },\n        terminate: true,\n      });\n\n      if (pending) {\n        if (!suppliedCreation) {\n          hypagoalAuthoring = undefined;\n          return rejectCreationRequest(\n            "hypagoal_creation_request_required",\n            "The active /hypagoal authoring turn requires its exact creationRequest identity.",\n          );\n        }\n        const matches = suppliedCreation.operationId === pending.creationRequest.operationId\n          && suppliedCreation.sessionGeneration === pending.creationRequest.sessionGeneration\n          && suppliedCreation.branchGeneration === pending.creationRequest.branchGeneration\n          && sessionGeneration === pending.creationRequest.sessionGeneration\n          && branchGeneration === pending.creationRequest.branchGeneration;\n        if (!matches) {\n          hypagoalAuthoring = undefined;\n          return rejectCreationRequest(\n            "stale_hypagoal_creation_request",\n            "The creationRequest does not match the active Pi session and branch generation.",\n          );\n        }\n      } else if (suppliedCreation) {\n        return rejectCreationRequest(\n          "stale_hypagoal_creation_request",\n          "The creationRequest no longer belongs to an active /hypagoal authoring turn.",\n        );\n      }\n\n      const creationOperationId = pending?.creationRequest.operationId ?? `hypagoal-start:${randomUUID()}`;\n      const objective = pending?.objective ?? input.objective;\n      const replacementConfirmation = pending?.replacementConfirmation ?? input.replacementConfirmation;\n      const workflowId = randomUUID();\n      const goalId = `goal-${randomUUID()}`;\n      const result = await startRootHypagoal(eventStore.lease(), state, {\n        objective,\n        definition: input.definition,\n        workflowId,\n        goalId,\n        goalWorkflowId: workflowId,\n        at: new Date().toISOString(),\n        sessionGeneration,\n        branchGeneration,\n        advisories: input.advisories,\n        ...(replacementConfirmation === undefined\n          ? {}\n          : { replacementConfirmation }),\n      });\n      hypagoalAuthoring = undefined;\n''',
    "tool authoring binding",
)
extension = replace_once(
    extension,
    '''              advisories: structuredClone(result.advisories),\n              ...(result.replaced === undefined ? {} : { replaced: structuredClone(result.replaced) }),\n              autonomousContinuationStarted: false,''',
    '''              advisories: structuredClone(result.advisories),\n              creation: {\n                operationId: creationOperationId,\n                correlationId: result.events[0]?.correlationId,\n                sessionGeneration,\n                branchGeneration,\n              },\n              ...(result.replaced === undefined ? {} : { replaced: structuredClone(result.replaced) }),\n              autonomousContinuationStarted: false,''',
    "creation result identity",
)
extension = replace_once(
    extension,
    '''              replacementConfirmation: structuredClone(result.confirmation),\n            },''',
    '''              replacementConfirmation: structuredClone(result.confirmation),\n              creation: { operationId: creationOperationId, sessionGeneration, branchGeneration },\n            },''',
    "replacement result identity",
)
extension = replace_once(
    extension,
    '''    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {\n      ensureNoActiveExecution();\n      const result = await commitCreatedWorkflow(''',
    '''    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {\n      ensureNoActiveExecution();\n      if (state) {\n        throw new Error("An active Hypagraph already exists. Use hypagraph_revise for the current workflow or /hypagoal for explicit root replacement.");\n      }\n      const result = await commitCreatedWorkflow(''',
    "legacy define replacement guard",
)
extension = replace_once(
    extension,
    '''      hypagoalAuthoring = true;\n      pi.sendUserMessage(buildHypagoalAuthoringPrompt(objective, replacementConfirmation));''',
    '''      const creationRequest: HypagoalCreationRequest = {\n        operationId: `hypagoal-create:${randomUUID()}`,\n        sessionGeneration,\n        branchGeneration,\n      };\n      hypagoalAuthoring = {\n        objective,\n        creationRequest,\n        ...(replacementConfirmation === undefined ? {} : { replacementConfirmation }),\n      };\n      pi.sendUserMessage(buildHypagoalAuthoringPrompt(objective, creationRequest, replacementConfirmation));''',
    "slash command authoring lease",
)
extension_path.write_text(extension)


test_path = Path("tests/hypagoal-pi.test.ts")
test = test_path.read_text()
test = replace_once(
    test,
    'const authoredInput = (replacementConfirmation?: unknown) => ({\n  objective: proseObjective,',
    'const authoredInput = (replacementConfirmation?: unknown, creationRequest?: unknown, objective = proseObjective) => ({\n  objective,',
    "authored input arguments",
)
test = replace_once(
    test,
    '''  advisories: [{\n    code: "repository-test-command",\n    message: "The graph uses the test command declared by package.json.",\n  }],\n  ...(replacementConfirmation === undefined ? {} : { replacementConfirmation }),''',
    '''  advisories: [{\n    code: "repository-test-command",\n    message: "The graph uses the test command declared by package.json.",\n  }],\n  ...(creationRequest === undefined ? {} : { creationRequest }),\n  ...(replacementConfirmation === undefined ? {} : { replacementConfirmation }),''',
    "authored creation request",
)
test = replace_once(
    test,
    '''const text = (result: Record<string, unknown>): string => {\n  const content = result.content as Array<{ type: string; text: string }>;\n  return content.map((item) => item.text).join("\\n");\n};''',
    '''const text = (result: Record<string, unknown>): string => {\n  const content = result.content as Array<{ type: string; text: string }>;\n  return content.map((item) => item.text).join("\\n");\n};\n\nconst creationRequestFromPrompt = (prompt: string): unknown => {\n  const match = prompt.match(/Use this exact creation request identity without changing any field:\\n(\\{[\\s\\S]*?\\})\\n\\nCall hypagoal_start/);\n  if (!match?.[1]) throw new Error("The authoring prompt did not contain a creation request identity.");\n  return JSON.parse(match[1]);\n};''',
    "creation request prompt parser",
)
test = replace_once(
    test,
    '''      "definition",\n      "advisories",\n      "replacementConfirmation",''',
    '''      "definition",\n      "advisories",\n      "creationRequest",\n      "replacementConfirmation",''',
    "schema fields",
)
test = replace_once(
    test,
    '''    expect(prompt).toContain("Call hypagoal_start one time");\n    expect(prompt).toContain("Do not perform semantic implementation work after creation");''',
    '''    expect(prompt).toContain("Use this exact creation request identity");\n    expect(prompt).toContain("Call hypagoal_start one time");\n    expect(prompt).toContain("Do not perform semantic implementation work after creation");''',
    "authoring prompt assertions",
)
test = replace_once(
    test,
    '''    await command.handler(proseObjective, value.ctx);\n    const result = await tool.execute("hypagoal-smoke", authoredInput(), undefined, undefined, value.ctx);''',
    '''    await command.handler(proseObjective, value.ctx);\n    const prompt = String(value.sendUserMessage.mock.calls[0]?.[0]);\n    const creationRequest = creationRequestFromPrompt(prompt);\n    const result = await tool.execute(\n      "hypagoal-smoke",\n      authoredInput(undefined, creationRequest, "Model rewrote the user's objective."),\n      undefined,\n      undefined,\n      value.ctx,\n    );''',
    "smoke creation request",
)
test = replace_once(
    test,
    '''      hypagoal: { objective: string; goalControl: { status: string }; autonomousContinuationStarted: boolean };\n    };''',
    '''      hypagoal: {\n        objective: string;\n        goalControl: { status: string };\n        creation: { operationId: string; correlationId: string; sessionGeneration: number; branchGeneration: number };\n        autonomousContinuationStarted: boolean;\n      };\n    };''',
    "smoke result type",
)
test = replace_once(
    test,
    '''    expect(details.hypagoal.goalControl.status).toBe("active");\n    expect(details.hypagoal.autonomousContinuationStarted).toBe(false);''',
    '''    expect(details.hypagoal.goalControl.status).toBe("active");\n    expect(details.hypagoal.creation.operationId).toMatch(/^hypagoal-create:/);\n    expect(details.hypagoal.creation.correlationId).toMatch(/^define:/);\n    expect(details.hypagoal.creation.sessionGeneration).toBe(0);\n    expect(details.hypagoal.creation.branchGeneration).toBe(0);\n    expect(details.hypagoal.autonomousContinuationStarted).toBe(false);''',
    "smoke result identity assertions",
)
insert_before = '''  it("identifies the current root and requires an exact typed replacement", async () => {'''
insert_tests = '''  it("rejects a slash-command creation request after the Pi branch generation changes", async () => {\n    const value = harness();\n    await value.commands.get("hypagoal")!.handler(proseObjective, value.ctx);\n    const prompt = String(value.sendUserMessage.mock.calls[0]?.[0]);\n    const creationRequest = creationRequestFromPrompt(prompt);\n\n    const sessionTree = value.handlers.get("session_tree")?.[0];\n    expect(sessionTree).toBeDefined();\n    await sessionTree!({}, value.ctx);\n\n    const result = await value.tools.get("hypagoal_start")!.execute(\n      "stale-authoring",\n      authoredInput(undefined, creationRequest),\n      undefined,\n      undefined,\n      value.ctx,\n    );\n    expect(result.terminate).toBe(true);\n    expect(text(result)).toContain("stale_hypagoal_creation_request");\n    expect(value.entries).toHaveLength(0);\n  });\n\n  it("does not let the legacy define surface silently replace an active root", async () => {\n    const value = harness();\n    await value.tools.get("hypagoal_start")!.execute("first", authoredInput(), undefined, undefined, value.ctx);\n    await expect(value.tools.get("hypagraph_define")!.execute(\n      "legacy-replace",\n      authoredInput().definition,\n      undefined,\n      undefined,\n      value.ctx,\n    )).rejects.toThrow("explicit root replacement");\n    expect(value.entries).toHaveLength(1);\n  });\n\n'''
test = replace_once(test, insert_before, insert_tests + insert_before, "stale and legacy replacement tests")
test_path.write_text(test)

ci_path = Path(".github/workflows/ci.yml")
ci_path.write_text('''name: CI\n\non:\n  workflow_dispatch:\n  pull_request:\n    branches:\n      - main\n    types:\n      - opened\n      - reopened\n      - synchronize\n      - ready_for_review\n  push:\n    branches:\n      - "**"\n\npermissions:\n  contents: read\n\njobs:\n  check:\n    name: ${{ matrix.os }} · Node.js ${{ matrix.node-version }}\n    runs-on: ${{ matrix.os }}\n    strategy:\n      fail-fast: false\n      matrix:\n        os:\n          - ubuntu-latest\n          - macos-latest\n          - windows-latest\n        node-version:\n          - 22\n          - 24\n\n    steps:\n      - name: Check out the repository\n        uses: actions/checkout@v4\n\n      - name: Set up Node.js\n        uses: actions/setup-node@v4\n        with:\n          node-version: ${{ matrix.node-version }}\n          cache: npm\n\n      - name: Install locked dependencies\n        run: npm ci\n\n      - name: Run type checks and tests\n        id: check\n        shell: bash\n        run: |\n          set +e\n          npm run check > check.log 2>&1\n          status=$?\n          cat check.log\n          exit $status\n\n      - name: Upload check log\n        if: always()\n        uses: actions/upload-artifact@v4\n        with:\n          name: check-log-${{ matrix.os }}-node-${{ matrix.node-version }}\n          path: check.log\n''')
