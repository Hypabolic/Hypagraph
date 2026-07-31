# Skill guidance audit — trust fix goal

Source: skills/hypagraph/SKILL.md
Also checked: README.md Current status; src/extension.ts hypagoal_start description

## Criterion 5 observations

### 1. Ordered start-to-run sequence (wayfinder)
```
12| ## Wayfinder (start-to-run)
13| 
14| | Situation | Action |
15| | --- | --- |
16| | User asks for repository work | Arm (optional trigger word) → inspect → author → create → wait for **Run** |
17| | Graph is only task/check/loop | Draft tools + `draftId` on `hypagoal_start` |
18| | Graph needs interaction, gate, code, or effect | Free-form `definition` on `hypagoal_start` (see interaction recipe below) |
19| | After create in TUI | Wait for post-create dock: **Run** / **Question** / **Cancel** |
20| | After Question, never started | `/hypagraph resume` re-opens the dock; user must choose **Run** |
21| | Default model task after Run | Isolated worker (`isolated-pi`); do not implement in orchestrator |
22| | User must answer a question | Interaction node on the orchestrator (bottom dock) |
23| | Stuck worker | `/hypagraph executor cancel` |
24| | Inspect state | `/hypagraph status`, `hypagraph_read` |
25| 
26| Ordered path: **arm → inspect → construct or free-form → validate → create → Run/Question/Cancel → isolated workers → interaction on orchestrator**.
27| 
```

### 2. Shipped draft constructor tool names
```
44| ### Construction tools versus free-form definition
45| 
46| Construction tools currently cover:
47| 
48| - task nodes (`hypagraph_add_task`);
49| - check nodes (`hypagraph_add_check`);
50| - dependencies (`hypagraph_require`);
51| - bounded loops (`hypagraph_loop`);
52| - the implement-then-verify recipe (`hypagraph_recipe_implement_verify_loop`).
53| 
54| Construction tools do **not** yet cover interaction, gate, code, or effect nodes.
55| 
56| When the workflow needs an interaction question, a gate, a code program, or an external effect, author those nodes with free-form `definition` on `hypagoal_start` (or mix a validated draft for the covered part and free-form for the rest only when you rebuild the full definition). Free-form remains a supported product path for those node kinds, not only a test or import escape hatch.
57| 
58| During authoring:
59| 
60| 1. Do not call `write`, `edit`, or `bash`. Authoring is read-only for the repository.
61| 2. Use construction tools, `hypagraph_read`, `hypagraph_draft_validate`, and `hypagraph_validate`.
62| 3. Call `hypagoal_start` as the final action of the authoring turn.
63| 
```

### 3. Free-form interaction recipe (demo graph)
```
64| ### Free-form interaction recipe (demo product path)
65| 
66| There is no `hypagraph_add_interaction` constructor yet. When the user must approve, choose, or answer before later work, author an interaction node with free-form `definition` on `hypagoal_start`.
67| 
68| Use this linear shape for the standard product path (isolated task, then user approval):
69| 
70| 1. Task node with no `requires` (ready first; default `isolated-pi` worker).
71| 2. Interaction node with `requires` set to the task id.
72| 3. Interaction `produces` facts that match each response `publish` entry.
73| 4. `presentation.class: "deterministic"` and `presentation.kind: "none"` for the default bottom dock (no extra presentation effect).
74| 5. At least one response with an `id`, `label`, and `publish` list.
75| 
76| Call `hypagraph_validate` on the definition when useful, then `hypagoal_start` with matching `objective` and `definition`.
77| 
78| ```json
79| {
80|   "title": "Product surface E2E",
81|   "goal": "Run one isolated task, then ask the user to approve",
82|   "nodes": [
83|     {
84|       "id": "do-work",
85|       "title": "Do the work",
86|       "kind": "task",
87|       "requires": [],
88|       "acceptance": ["The work is done."]
89|     },
90|     {
91|       "id": "approve-work",
92|       "title": "Approve the work",
93|       "kind": "interaction",
94|       "requires": ["do-work"],
95|       "acceptance": ["The user answers the approval question."],
96|       "produces": [
97|         { "name": "work.approved", "type": "boolean", "required": true }
98|       ],
99|       "interaction": {
100|         "kind": "interaction",
101|         "version": 1,
102|         "presentation": { "class": "deterministic", "kind": "none" },
103|         "question": "Approve the completed work?",
104|         "responses": [
105|           {
106|             "id": "approve",
107|             "label": "Approve",
108|             "publish": [
109|               { "name": "work.approved", "type": "boolean", "value": true }
110|             ]
111|           },
112|           {
113|             "id": "reject",
114|             "label": "Reject",
115|             "publish": [
116|               { "name": "work.approved", "type": "boolean", "value": false }
117|             ]
118|           }
119|         ]
120|       }
121|     }
122|   ],
123|   "loops": [],
124|   "policy": { "mode": "guided", "requireEvidence": false }
125| }
126| ```
127| 
128| After create and **Run**:
129| 
130| 1. `do-work` runs in an isolated worker (not in the orchestrator chat).
131| 2. When `approve-work` is ready, the controller presents the question in the **bottom** interaction dock on the orchestrator session.
132| 3. Do not use `/hypagraph ask` as a substitute for an interaction node. Use `/hypagraph ask` only to re-present an already-open interaction after dismiss.
133| 4. Do not answer the interaction from a worker session. Workers that open ask-user tools stall or fail; only the orchestrator presents interaction.
134| 
135| Gate nodes, code nodes, and effect nodes also require free-form `definition` until constructors exist. Follow the Code node authoring and Effect node authoring sections below for those kinds.
136| 
```

### 4. Post-create Run / Question / Cancel
```
155| ### After create (interactive TUI)
156| 
157| In interactive TUI, Hypagraph presents a bottom dock with a Mermaid graph diagram and three actions:
158| 
159| 1. **Run** — start autonomous controller execution for the created goal;
160| 2. **Question** — keep the goal active without starting work so the user can ask about the graph;
161| 3. **Cancel** — cancel the created goal.
162| 
163| Esc dismisses like Question (safe dismiss). Cancel requires the Cancel row.
164| 
165| Until the user chooses **Run** on the post-create dock, do not start repository work, call task tools for this goal, or assume continuation is active.
166| 
167| After **Question** (or Esc):
168| 
169| 1. answer the user's questions with `hypagraph_read` and status surfaces;
170| 2. do not start tasks, checks, revisions, or repository edits while the gate is open;
171| 3. when no node has ever started, `/hypagraph resume` **re-opens the post-create dock**; it does not auto-start work;
172| 4. after reload or branch change, a never-started goal re-arms the same gate and notifies the user; resume again opens the dock.
173| 
174| Headless hosts do not show the dock. They may auto-continue after create.
175| 
```

### 5. Orchestrator vs isolated worker + interaction on main session
```
180| ## Orchestrator versus worker
181| 
182| The main Pi session is the orchestrator. It is not the default runner for model task work.
183| 
184| 1. Default task nodes run in isolated worker sessions (`isolated-pi`).
185| 2. Deterministic checks, gates, code, and effects stay in the host. They do not use a worker session.
186| 3. Interaction questions stay in the orchestrator session so the user can answer them.
187| 4. Automatic revision turns may still use an orchestrator follow-up in this release when selected.
188| 5. A node may set `executorProfile.kind: "current-session"` only as an explicit opt-in. Prefer the default.
189| 
190| While an isolated worker owns a mutating task attempt:
191| 
192| 1. Do not call task lifecycle tools or edit repository files as if you were the worker.
193| 2. Use `hypagraph_read` and `/hypagraph status` or `/hypagraph executor status` for progress. Status reports the root worker node, attempt, profile, and elapsed time when one is active.
194| 3. Cancel a stuck worker with `/hypagraph executor cancel`. Cancel aborts the worker signal and cancels the tracked attempt.
195| 4. Reload, branch change, and session shutdown also abort the in-flight worker and cancel the tracked attempt.
196| 
197| Default root model attempts use a hard host timeout (15 minutes). A timed-out worker settles as failed rather than running forever.
198| 
199| After create and Run, the first ready task must not implement in the orchestrator chat under default policy. The controller starts a worker and settles the structured result. There is no production environment variable that switches the default to current-session. Only an explicit `executorProfile.kind: "current-session"` on the node opts in.
200| 
```

### 6. hypagoal_start tool description honesty (extension)
```
2479|     name: "hypagoal_start",
2480|     label: "Start Hypagoal",
2481|     description: "Atomically create and persist one root graph-backed goal from an ordinary prose objective. Prefer draftId when construction tools cover the graph. Use free-form definition for interaction, gate, code, and effect nodes (constructors do not yet build those kinds), and for tests or import.",
2482|     promptSnippet: "Create a root Hypagoal from a prose objective",
2483|     promptGuidelines: [
2484|       "Prefer hypagoal_start with draftId after hypagraph_draft_validate when constructors cover the graph.",
2485|       "Use free-form definition for interaction, gate, code, and effect nodes, and for tests or import.",
2486|       "hypagoal_start accepts authoring advisories separately from canonical workflow fields and never accepts terminal goal state.",
2487|       "Do not hand-author feedbackEdges. Use hypagraph_loop or hypagraph_recipe_implement_verify_loop.",
2488|       "If hypagoal_start rejects the draft or definition, repair with tools and call hypagoal_start again with the same creationRequest.",
2489|       "Call hypagoal_start as the final action of a Hypagoal authoring turn. It creates durable state but does not continue execution.",
2490|     ],
2491|     parameters: hypagoalStartSchema,
```

## Result
- Ordered path present: arm → inspect → construct/free-form → validate → create → Run/Question/Cancel → workers → interaction.
- Constructors listed: add_task, add_check, require, loop, recipe_implement_verify_loop.
- Free-form interaction recipe includes full JSON fixture (do-work → approve-work).
- hypagoal_start description states free-form for interaction/gate/code/effect.
- Interaction presentation: bottom dock on orchestrator; workers must not ask-user.
