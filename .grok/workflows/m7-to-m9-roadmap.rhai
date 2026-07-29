let meta = #{
    name: "m7-to-m9-roadmap",
    description: "Implement Hypagraph roadmap M7 through M9 in order; each slice uses the implement skill",
    when_to_use: "When driving remaining roadmap work from M7 family persistence through M9 external executors",
    phases: [
        #{ title: "Setup", detail: "branch and baseline" },
        #{ title: "M7", detail: "goal families and isolated Pi (v0.11)" },
        #{ title: "M8", detail: "worktrees and concurrency (v0.12)" },
        #{ title: "M8.1", detail: "dynamic fan-out (v0.13)" },
        #{ title: "M9", detail: "ACP and named CLI adapters (v0.14)" },
        #{ title: "Report", detail: "summary of what landed" },
    ],
};

// Optional: start_from = "m7" | "m8" | "m8.1" | "m9" (default m7)
// Optional: stop_after = milestone id to pause after that milestone completes
// Optional: slice_limit = max slices per milestone (0 = all)
let start_from = "m7";
let stop_after = "";
let slice_limit = 0;
if args != () {
    if args.start_from != () { start_from = args.start_from; }
    if args.stop_after != () { stop_after = args.stop_after; }
    if args.slice_limit != () { slice_limit = args.slice_limit; }
}

fn repo_rules() {
    let s = "";
    s += "Repository: /Users/matthew/Development/hypabolic/Hypagraph\n";
    s += "Product name: Hypagraph only. ASD-STE100 house style for all repo prose.\n";
    s += "Domain reducer must stay pure (no clock, random, files, network, input mutation).\n";
    s += "All persisted state needs a schema version; reject unsupported versions clearly.\n";
    s += "Do not cut a release unless the user later asks. Do commit after each green slice when practical.\n";
    s += "Read AGENTS.md and docs/session-handoff.md first.\n";
    s
}

fn implement_skill_preamble() {
    let s = "";
    s += "You are the ORCHESTRATOR for the /implement skill for ONE scoped vertical slice only.\n";
    s += "Read and follow: /Users/matthew/.claude/skills/implement/SKILL.md\n";
    s += "Also load implementer/reviewer personas from /Users/matthew/.grok/bundled/personas/ or /Users/matthew/.claude/skills/shared/personas/ if present.\n";
    s += "Rules:\n";
    s += "1. Do NOT implement the slice yourself with write/search_replace. Delegate ALL code changes to a spawn_subagent implementer (model grok-4.5 or grok-composer-2.5-fast).\n";
    s += "2. After implement, run review (prefer Claude/Sonnet via CLI if available; else Grok reviewer). Loop until 0 open issues.\n";
    s += "3. Use unique /tmp/grok-impl-summary-<id>.md and /tmp/grok-review-<id>.md paths for this slice.\n";
    s += "4. Effort default 1 unless the slice is security-sensitive.\n";
    s += "5. When the loop is clean, run npm run check (or typecheck + vitest). Fix via implementer if red.\n";
    s += "6. Commit on the feature branch with a clear STE100 message for this slice only. Do not push unless asked.\n";
    s += "7. Write a short slice report to scratch via your final message: status, files, commit sha if any, remaining risks.\n";
    s += "8. Stay inside the slice scope. Do not start the next milestone.\n\n";
    s
}

fn run_slice(milestone, slice_id, title, plan_paths, acceptance) {
    let prompt = "";
    prompt += implement_skill_preamble();
    prompt += repo_rules();
    prompt += "\n## Slice\n";
    prompt += "Milestone: " + milestone + "\n";
    prompt += "Slice id: " + slice_id + "\n";
    prompt += "Title: " + title + "\n";
    prompt += "Plan files (read in full):\n" + plan_paths + "\n";
    prompt += "Acceptance focus:\n" + acceptance + "\n";
    prompt += "\nWork on branch agent/" + milestone + "-roadmap (create from main if needed). Keep one long-lived branch for the milestone.\n";
    prompt += "If prior slices already exist on that branch, continue from them.\n";

    log("Implement " + slice_id + ": " + title);
    let r = agent(prompt, #{
        label: slice_id,
        capability_mode: "all",
    });
    if r == () || !r.success {
        let msg = "Slice failed: " + slice_id + " — " + title;
        log(msg);
        await_user("verification", msg + ". Inspect the tree, then resume to continue or stop.");
        return #{ ok: false, id: slice_id, title: title };
    }
    log("Slice complete: " + slice_id);
    #{ ok: true, id: slice_id, title: title, output: r.output }
}

fn should_run_milestone(name, from) {
    if from == "m7" { true }
    else if from == "m8" { name != "m7" }
    else if from == "m8.1" { name == "m8.1" || name == "m9" }
    else if from == "m9" { name == "m9" }
    else { true }
}

fn limit_slices(items, lim) {
    if lim == 0 { return items; }
    if lim >= items.len() { return items; }
    let out = [];
    let i = 0;
    while i < lim {
        out.push(items[i]);
        i += 1;
    }
    out
}

// --- Setup ---
phase("Setup");
let setup_prompt = "";
setup_prompt += repo_rules();
setup_prompt += "Verify git status is clean enough to start (or stash only if you created junk). ";
setup_prompt += "Ensure you are in /Users/matthew/Development/hypabolic/Hypagraph. ";
setup_prompt += "Fetch origin. Note HEAD sha and package version. ";
setup_prompt += "Do not implement features. Report ready: true if work can start.";
let setup = agent(setup_prompt, #{ label: "setup", capability_mode: "execute" });
if setup == () || !setup.success {
    await_user("infra", "Setup agent failed. Resume when the repo is ready.");
}

let completed = [];
let failed = [];

// --- M7 ---
if should_run_milestone("m7", start_from) {
    phase("M7");
    log("M7 goal families and isolated Pi execution (v0.11)");
    let m7_plans = "";
    m7_plans += "- docs/execution-roadmap.md section 12\n";
    m7_plans += "- docs/goal-family-and-concurrent-execution-plan.md\n";
    m7_plans += "- docs/delegation-and-visualisation.md\n";
    m7_plans += "- docs/session-handoff.md\n";

    let m7 = [
        #{ id: "m7-s1", title: "Family persistence above workflow aggregates",
           acc: "Family records persist above workflows; restore rebuilds membership; schema reject unsupported versions." },
        #{ id: "m7-s2", title: "One-member family projection migration",
           acc: "Existing root projects as one-member family without rewriting workflow event history." },
        #{ id: "m7-s3", title: "Family scheduler sequential dispatch",
           acc: "One family controller owns scheduling and canonical writes; sequential dispatch only." },
        #{ id: "m7-s4", title: "Bounded child-goal creation from parent task",
           acc: "Child waits only invoking parent; depth/count/scope/budget bounds enforced." },
        #{ id: "m7-s5", title: "Child return and parent failure policy",
           acc: "Child returns through declared facts/evidence; failure policies have deterministic parent effects." },
        #{ id: "m7-s6", title: "Executor context and result contracts",
           acc: "Executor gets explicit reproducible context; returns structured untrusted result only." },
        #{ id: "m7-s7", title: "Route current-session execution through executor abstraction",
           acc: "Current Pi session uses the same result contract path as isolated executors." },
        #{ id: "m7-s8", title: "Isolated Pi RPC executor",
           acc: "Isolated process lifecycle; cancellation; loss of session does not lose canonical context." },
        #{ id: "m7-s9", title: "Nested graph and executor UI",
           acc: "UI shows nested family graph and executor status without weakening redaction rules." },
    ];
    m7 = limit_slices(m7, slice_limit);
    for s in m7 {
        let res = run_slice("m7", s.id, s.title, m7_plans, s.acc);
        if res.ok { completed.push(s.id); } else { failed.push(s.id); }
    }
    await_user("user", "M7 slice batch finished. Review the branch, then resume for M8 (or stop).");
    if stop_after == "m7" {
        complete(#{ summary: "Stopped after M7", completed: completed, failed: failed });
    }
}

// --- M8 ---
if should_run_milestone("m8", start_from) {
    phase("M8");
    log("M8 worktrees and bounded concurrency (v0.12)");
    let m8_plans = "";
    m8_plans += "- docs/execution-roadmap.md section 13\n";
    m8_plans += "- docs/goal-family-and-concurrent-execution-plan.md (workspace sections)\n";

    let m8 = [
        #{ id: "m8-s1", title: "Workspace lease contracts",
           acc: "Leases are explicit; incompatible leases block unsafe concurrency." },
        #{ id: "m8-s2", title: "Worktree per mutating attempt",
           acc: "Each mutating attempt gets an isolated worktree." },
        #{ id: "m8-s3", title: "Structured worker commit results",
           acc: "Worker returns structured commit identity and changed paths." },
        #{ id: "m8-s4", title: "Validate changed scope and evidence",
           acc: "Scope and evidence validated before integration." },
        #{ id: "m8-s5", title: "Integration lifecycle and conflict state",
           acc: "Conflicts are explicit and recoverable; not silent overwrite." },
        #{ id: "m8-s6", title: "Post-integration base workspace checks",
           acc: "Base-workspace checks run before node completion." },
        #{ id: "m8-s7", title: "Global and per-executor concurrency limits",
           acc: "Default concurrency two; limits enforced." },
        #{ id: "m8-s8", title: "Concurrency groups and fairness",
           acc: "Groups and fairness prevent starvation." },
        #{ id: "m8-s9", title: "Concurrent loops and child workflows",
           acc: "Independent loops and child workflows can overlap safely." },
        #{ id: "m8-s10", title: "Cancellation crash recovery stale integration",
           acc: "Crash recovery reconciles children and leases; stale results rejected." },
    ];
    m8 = limit_slices(m8, slice_limit);
    for s in m8 {
        let res = run_slice("m8", s.id, s.title, m8_plans, s.acc);
        if res.ok { completed.push(s.id); } else { failed.push(s.id); }
    }
    await_user("user", "M8 slice batch finished. Review, then resume for M8.1 (or stop).");
    if stop_after == "m8" {
        complete(#{ summary: "Stopped after M8", completed: completed, failed: failed });
    }
}

// --- M8.1 ---
if should_run_milestone("m8.1", start_from) {
    phase("M8.1");
    log("M8.1 dynamic fan-out regions (v0.13)");
    let m81_plans = "";
    m81_plans += "- docs/execution-roadmap.md section 14\n";
    m81_plans += "- docs/deterministic-orchestration-plan.md derived fan-out section\n";

    let m81 = [
        #{ id: "m8.1-s1", title: "Derived fan-out from typed collection fact",
           acc: "Region expands from typed fact with max bound; each branch has attempt/evidence/status; fan-in policy; replay same branch set. Not Promise.all inside code nodes." },
    ];
    m81 = limit_slices(m81, slice_limit);
    for s in m81 {
        let res = run_slice("m8.1", s.id, s.title, m81_plans, s.acc);
        if res.ok { completed.push(s.id); } else { failed.push(s.id); }
    }
    await_user("user", "M8.1 finished. Review, then resume for M9 (or stop).");
    if stop_after == "m8.1" {
        complete(#{ summary: "Stopped after M8.1", completed: completed, failed: failed });
    }
}

// --- M9 ---
if should_run_milestone("m9", start_from) {
    phase("M9");
    log("M9 external executor adapters (v0.14)");
    let m9_plans = "";
    m9_plans += "- docs/execution-roadmap.md section 15\n";
    m9_plans += "- docs/delegation-and-visualisation.md\n";

    let m9 = [
        #{ id: "m9-s1", title: "ACP executor adapter",
           acc: "Hypagraph as ACP client; per-attempt session; stream/cancel/normalize; same result contract as Pi." },
        #{ id: "m9-s2", title: "Named direct CLI adapters",
           acc: "Named tested adapters with invoke, formats, cancel, timeout, security limits; not arbitrary shell." },
    ];
    m9 = limit_slices(m9, slice_limit);
    for s in m9 {
        let res = run_slice("m9", s.id, s.title, m9_plans, s.acc);
        if res.ok { completed.push(s.id); } else { failed.push(s.id); }
    }
}

// --- Report ---
phase("Report");
let report_prompt = "";
report_prompt += repo_rules();
report_prompt += "Write a final roadmap run report in markdown.\n";
report_prompt += "Completed slice ids (from orchestrator journal): list them carefully from git log and docs if needed.\n";
report_prompt += "Completed count hint: " + completed.len().to_string() + "\n";
report_prompt += "Failed count hint: " + failed.len().to_string() + "\n";
report_prompt += "For each milestone M7-M9 state: not started / partial / complete.\n";
report_prompt += "List open risks and whether a release cut is appropriate (default: no).\n";
report_prompt += "Use write tools if you create docs/m7-m9-roadmap-run-report.md under the repo.\n";
let report = agent(report_prompt, #{ label: "final-report", capability_mode: "all" });

let summary = "M7-M9 roadmap workflow finished. completed=" + completed.len().to_string()
    + " failed=" + failed.len().to_string();
log(summary);
complete(#{
    summary: summary,
    completed: completed,
    failed: failed,
    report_ok: report != () && report.success,
});
