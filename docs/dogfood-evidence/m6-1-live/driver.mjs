#!/usr/bin/env node
/**
 * Real Pi RPC dogfood driver for Hypagraph M6.1.
 * Proves plan approval interaction coexists with an independent loop.
 */
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { join } from "node:path";

const REPO = "/Users/matthew/Development/hypabolic/Hypagraph";
const ROOT = "/tmp/hypagraph-m6-1-live-dogfood";
const WORKSPACE = join(ROOT, "workspace");
const SESSION_DIR = join(ROOT, "session");
const LOG_DIR = join(ROOT, "logs");
const EXTENSION = join(REPO, "extensions/hypagraph.ts");
const OBJECTIVE =
  "Create a Hypagoal with exactly two independent components and no edge between them. " +
  "Component A: interaction node approve-plan with closed responses approve and reject that publish boolean fact plan.approved. " +
  "After approve, task write-plan writes plan-approved.txt with exact text m6-1-approved, then command check verify-plan checks the file. " +
  "Component B: independent loop marker-loop with nodes loop-work and loop-check. " +
  "loop-work requires loop-check only through a feedback edge that is ALSO listed in loop-work.requires, and loop-check requires loop-work. " +
  "The feedback edge must be from loop-check to loop-work and must match a requires edge. " +
  "loop-check is a command check that publishes boolean loop.passed. " +
  "Loop successWhen is loop.passed equals true, maxIterations 3, entry loop-work, evaluateAfter loop-check. " +
  "The loop and the interaction must not depend on each other so the loop can run while approval waits. " +
  "Use hypagraph_ask for the interaction. Use dotted fact names plan.approved and loop.passed.";

const logPath = join(LOG_DIR, `rpc-${Date.now()}.jsonl`);
const summaryPath = join(LOG_DIR, "summary.json");
const logStream = createWriteStream(logPath, { flags: "a" });

const state = {
  idle: true,
  agentStartedSincePrompt: false,
  pending: new Map(),
  notifications: [],
  widgets: {},
  statuses: {},
  texts: [],
  toolCalls: [],
  assistantSnippets: [],
  errors: [],
  lastAgentEndAt: 0,
  selects: [],
  uiMethods: [],
};

const record = (kind, payload) => {
  logStream.write(JSON.stringify({ ts: new Date().toISOString(), kind, ...payload }) + "\n");
};

const child = spawn(
  "pi",
  [
    "--mode", "rpc",
    "--model", "xai-auth/grok-4.5",
    "--thinking", "off",
    "--session-dir", SESSION_DIR,
    "--name", "m6-1-live-dogfood",
    "--approve",
    "-e", EXTENSION,
  ],
  {
    cwd: WORKSPACE,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PI_PROVIDER: "xai-auth",
      PI_MODEL: "grok-4.5",
    },
  },
);

let stdoutBuf = "";
child.stderr.on("data", (chunk) => {
  const text = chunk.toString();
  record("stderr", { text });
  process.stderr.write(text);
});
child.stdout.on("data", (chunk) => {
  stdoutBuf += chunk.toString();
  let idx;
  while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
    const raw = stdoutBuf.slice(0, idx).replace(/\r$/, "");
    stdoutBuf = stdoutBuf.slice(idx + 1);
    if (!raw.trim()) continue;
    let msg;
    try { msg = JSON.parse(raw); }
    catch (error) { record("parse-error", { raw, error: String(error) }); continue; }
    handleMessage(msg);
  }
});

function resolvePending(msg) {
  if (msg.id && state.pending.has(msg.id)) {
    const { resolve } = state.pending.get(msg.id);
    state.pending.delete(msg.id);
    resolve(msg);
  }
}

function handleMessage(msg) {
  record("event", { msg });
  if (msg.type === "response") { resolvePending(msg); return; }
  if (msg.type === "agent_start") { state.idle = false; state.agentStartedSincePrompt = true; return; }
  if (msg.type === "agent_end" || msg.type === "agent_settled") {
    state.idle = true;
    state.lastAgentEndAt = Date.now();
    return;
  }
  if (msg.type === "message_update") {
    const event = msg.assistantMessageEvent;
    if (event?.type === "text_delta" && event.delta) {
      const last = state.assistantSnippets.at(-1) ?? "";
      if (last.length < 4000) state.assistantSnippets[state.assistantSnippets.length - 1] = last + event.delta;
    }
    if (event?.type === "text_start") state.assistantSnippets.push("");
    if (event?.type === "toolcall_start") {
      state.toolCalls.push({ name: event.toolCall?.name ?? event.name ?? "unknown", at: Date.now() });
    }
    return;
  }
  if (msg.type === "extension_ui_request") { handleExtensionUi(msg); return; }
  if (msg.type === "error" || msg.type === "extension_error") state.errors.push(msg);
}

function pickSelectValue(options) {
  const list = Array.isArray(options) ? options.map(String) : [];
  state.selects.push({ options: list, at: new Date().toISOString() });
  const approve = list.find((o) => /approve/i.test(o) && !/reject|deny|no\b/i.test(o));
  if (approve) return approve;
  // Prefer first non-chat style option that looks like an id-label pair
  const idLabel = list.find((o) => o.includes(" - "));
  return idLabel ?? list[0] ?? "";
}

function handleExtensionUi(req) {
  state.uiMethods.push(req.method);
  const respond = (payload) => {
    const body = { type: "extension_ui_response", id: req.id, ...payload };
    child.stdin.write(JSON.stringify(body) + "\n");
    record("ui-response", body);
  };
  switch (req.method) {
    case "notify":
      state.notifications.push({ message: req.message, notifyType: req.notifyType, at: new Date().toISOString() });
      return;
    case "setStatus":
    case "set_status":
      state.statuses[req.statusKey ?? req.key ?? "default"] = req.statusText ?? req.text ?? "";
      return;
    case "setWidget":
    case "set_widget":
      state.widgets[req.widgetKey ?? req.key ?? "default"] = req.widgetLines ?? req.lines ?? [];
      return;
    case "setTitle":
    case "set_title":
    case "setEditorText":
    case "set_editor_text":
      return;
    case "confirm":
      respond({ confirmed: true });
      return;
    case "select":
      respond({ value: pickSelectValue(req.options) });
      return;
    case "input":
    case "editor":
      respond({ value: req.prefill ?? "m6-1 dogfood notes" });
      return;
    case "custom":
      // Prefer cancel so TUI custom overlays do not hang; RPC uses select for interactions.
      respond({ cancelled: true });
      return;
    default:
      record("ui-unknown", { req });
      respond({ cancelled: true });
  }
}

let nextId = 1;
function request(command) {
  const id = `req-${nextId++}`;
  const body = { id, ...command };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(id);
      reject(new Error(`Timeout waiting for response to ${command.type}`));
    }, 180_000);
    state.pending.set(id, {
      resolve: (msg) => { clearTimeout(timer); resolve(msg); },
    });
    child.stdin.write(JSON.stringify(body) + "\n");
    record("request", body);
  });
}

async function sleep(ms) { await new Promise((r) => setTimeout(r, ms)); }

async function waitForIdle({ quietMs = 2500, maxWaitMs = 240_000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (state.idle && state.lastAgentEndAt > 0 && Date.now() - state.lastAgentEndAt >= quietMs && state.pending.size === 0) {
      return;
    }
    await sleep(250);
  }
  throw new Error(`waitForIdle timed out after ${maxWaitMs}ms`);
}

async function prompt(message, { maxWaitMs = 480_000, quietMs = 3000 } = {}) {
  state.agentStartedSincePrompt = false;
  state.idle = true;
  const response = await request({ type: "prompt", message });
  if (!response.success) throw new Error(`prompt failed: ${JSON.stringify(response)}`);
  const startDeadline = Date.now() + 1500;
  while (Date.now() < startDeadline && !state.agentStartedSincePrompt) await sleep(50);
  if (!state.agentStartedSincePrompt) {
    record("prompt-extension-only", { message });
    return response;
  }
  await waitForIdle({ quietMs, maxWaitMs });
  return response;
}

function extractCanonical(entriesResp) {
  const entries = entriesResp?.entries ?? entriesResp?.result?.entries ?? [];
  const batches = [];
  for (const entry of entries) {
    if (entry?.type === "custom" && entry.customType === "hypagraph.event-batch") batches.push(entry);
    if (entry?.customType === "hypagraph.event-batch") batches.push(entry);
  }
  // Walk reverse for latest snapshot in data
  let snapshot = null;
  let events = [];
  for (const entry of [...entries].reverse()) {
    const data = entry?.data ?? entry?.customData ?? entry;
    if (data?.snapshot) { snapshot = data.snapshot; events = data.events ?? events; break; }
  }
  return { snapshot, events, entryCount: entries.length };
}

async function main() {
  await mkdir(LOG_DIR, { recursive: true });
  await sleep(1500);
  const models = await request({ type: "get_state" });
  record("state", { models });

  console.error("==> /hypagoal authoring");
  await prompt(`/hypagoal ${OBJECTIVE}`, { quietMs: 5000, maxWaitMs: 540_000 });

  console.error("==> /hypagoal status (post-authoring)");
  await prompt("/hypagoal status");

  const notifyText = state.notifications.map((n) => String(n.message)).join("\n");
  if (notifyText.includes("no active Hypagoal") || notifyText.includes("rejected")) {
    console.error("==> re-author with stricter authoring guidance");
    await prompt(
      `/hypagoal ${OBJECTIVE} ` +
      "Declare one interaction node with closed responses approve and reject that publish plan.approved boolean. " +
      "Declare an independent loop of two nodes with no edge to the interaction. " +
      "Do not put the loop behind the approval dependency.",
      { quietMs: 5000, maxWaitMs: 540_000 },
    );
  }

  console.error("==> wait for automatic continuation (loop + wait for user)");
  await sleep(3000);
  for (let i = 0; i < 60; i += 1) {
    if (!state.idle) {
      await waitForIdle({ quietMs: 8000, maxWaitMs: 540_000 });
      break;
    }
    await sleep(1000);
  }
  // Extra settle for dialog + loop turns
  await sleep(2000);
  if (!state.idle) await waitForIdle({ quietMs: 8000, maxWaitMs: 420_000 });

  console.error("==> /hypagoal status");
  await prompt("/hypagoal status");

  console.error("==> /hypagraph history");
  await prompt("/hypagraph history");

  console.error("==> /hypagraph history interaction");
  await prompt("/hypagraph history interaction");

  console.error("==> /hypagraph explain");
  await prompt("/hypagraph explain");

  // If still waiting, force ask command
  const statusBlob = JSON.stringify(state.statuses) + state.notifications.map((n) => n.message).join("\n");
  if (/wait|awaiting|Waiting for/i.test(statusBlob) && state.selects.length === 0) {
    console.error("==> /hypagraph ask (force present)");
    await prompt("/hypagraph ask", { quietMs: 4000, maxWaitMs: 180_000 });
    await sleep(2000);
    if (!state.idle) await waitForIdle({ quietMs: 6000, maxWaitMs: 300_000 });
  }

  // More continuation after answer
  console.error("==> post-answer settle");
  await sleep(3000);
  if (!state.idle) await waitForIdle({ quietMs: 8000, maxWaitMs: 420_000 });

  console.error("==> final /hypagoal status");
  await prompt("/hypagoal status");

  const entriesResp = await request({ type: "get_entries" });
  await writeFile(join(LOG_DIR, "session-entries.json"), JSON.stringify(entriesResp, null, 2));

  const { snapshot, events, entryCount } = extractCanonical(entriesResp);
  const nodes = {};
  if (snapshot?.runtime?.nodes) {
    for (const [id, rt] of Object.entries(snapshot.runtime.nodes)) nodes[id] = rt.status;
  }
  const facts = snapshot?.runtime?.facts ? Object.keys(snapshot.runtime.facts) : [];
  const eventTypes = Array.isArray(events) ? events.map((e) => e.type) : [];

  let planFile = null;
  let loopMarker = null;
  try { planFile = await readFile(join(WORKSPACE, "plan-approved.txt"), "utf8"); } catch {}
  try { await access(join(WORKSPACE, "loop-marker")); loopMarker = true; } catch { loopMarker = false; }

  const waitingSeen = state.notifications.some((n) => /Waiting for a user response|wait /i.test(String(n.message)))
    || Object.values(state.statuses).some((s) => /wait/i.test(String(s)))
    || Object.values(state.widgets).flat().some((line) => /Waiting:|wait /i.test(String(line)));

  const interactionEvents = eventTypes.filter((t) => String(t).startsWith("hypagraph.interaction."));
  const summary = {
    objective: OBJECTIVE,
    workspace: WORKSPACE,
    sessionDir: SESSION_DIR,
    logPath,
    notifications: state.notifications,
    statuses: state.statuses,
    widgets: state.widgets,
    toolCalls: state.toolCalls,
    errors: state.errors,
    selects: state.selects,
    uiMethods: state.uiMethods,
    assistantTail: state.assistantSnippets.slice(-8),
    entryCount,
    phase: snapshot?.phase ?? null,
    goalStatus: snapshot?.goal?.status ?? null,
    sequence: snapshot?.sequence ?? null,
    revision: snapshot?.revision ?? null,
    consumedTurns: snapshot?.goal?.budget?.consumedTurns ?? null,
    schedulerOrdinal: snapshot?.goal?.schedulerOrdinal ?? snapshot?.goal?.continuationOrdinal ?? null,
    nodes,
    facts,
    eventTypes,
    interactionEvents,
    planApprovedContent: planFile,
    loopMarkerExists: loopMarker,
    waitingSurfaceSeen: waitingSeen,
    selectCount: state.selects.length,
  };

  const canonical = {
    phase: summary.phase,
    sequence: summary.sequence,
    revision: summary.revision,
    goalStatus: summary.goalStatus,
    consumedTurns: summary.consumedTurns,
    schedulerOrdinal: summary.schedulerOrdinal,
    nodes: summary.nodes,
    facts: summary.facts,
    eventTypes: summary.eventTypes,
    interactionEvents: summary.interactionEvents,
    planApprovedContent: summary.planApprovedContent,
    loopMarkerExists: summary.loopMarkerExists,
    waitingSurfaceSeen: summary.waitingSurfaceSeen,
    selectCount: summary.selectCount,
  };

  await writeFile(summaryPath, JSON.stringify(summary, null, 2));
  await writeFile(join(LOG_DIR, "canonical.json"), JSON.stringify(canonical, null, 2));
  console.error("==> wrote", summaryPath);
  console.error("phase:", summary.phase, "goal:", summary.goalStatus, "seq:", summary.sequence);
  console.error("nodes:", summary.nodes);
  console.error("facts:", summary.facts);
  console.error("interaction events:", summary.interactionEvents);
  console.error("selects:", summary.selectCount, "waitingSurface:", summary.waitingSurfaceSeen);
  console.error("plan-approved.txt:", summary.planApprovedContent);
  console.error("loop-marker:", summary.loopMarkerExists);

  try { child.stdin.end(); } catch {}
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 2000);

  // Soft success criteria for dogfood evidence collection
  const ok = summary.errors.length === 0 || summary.goalStatus === "completed";
  if (!ok) process.exitCode = 2;
}

main().catch(async (error) => {
  console.error("DOGFOOD FAILED", error);
  await writeFile(summaryPath, JSON.stringify({ error: String(error), notifications: state.notifications, errors: state.errors, selects: state.selects }, null, 2));
  try { child.kill("SIGKILL"); } catch {}
  process.exit(1);
});

process.on("exit", () => { try { logStream.end(); } catch {} });
