// PROTOTYPE — throwaway. Answers one question:
// can several vendors' models be made to emit structured Findings through a
// custom `report_finding` tool, while the tool allowlist keeps them read-only?
import { mkdtempSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const FIXTURE = resolve("fixture");
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

const CANDIDATES = [
  ["anthropic", "claude-haiku-4-5"],
  ["deepseek", "deepseek-v4-flash"],
  ["openrouter", "google/gemini-3-flash-preview"],
  ["openrouter", "z-ai/glm-4.6"],
  ["kimi-coding", "k3"], // known-broken credential: proves silent-failure detection
];

const SYSTEM_PROMPT = `You are a code reviewer. Explore the repository with your read tools, then report every problem you find.

Report each problem by calling the report_finding tool exactly once per problem. Do not describe problems in prose — a problem that is not reported through the tool does not exist. When you have reported everything, stop.`;

const REVIEW_PROMPT = `Review every file under src/ in this repository. Report all problems you find.`;

const findingSchema = Type.Object({
  file: Type.String({ description: "Repository-relative path of the file" }),
  line: Type.Integer({ description: "1-indexed line the problem starts on" }),
  severity: Type.Union(
    [Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")],
    { description: "How serious the problem is" },
  ),
  category: Type.Union(
    [
      Type.Literal("security"),
      Type.Literal("bug"),
      Type.Literal("maintainability"),
      Type.Literal("design"),
    ],
    { description: "What kind of problem this is" },
  ),
  description: Type.String({ description: "What is wrong and why it matters" }),
});

const REQUIRED_FIELDS = ["file", "line", "severity", "category", "description"];

function snapshotMtimes(dir) {
  const out = {};
  for (const name of readdirSync(dir, { recursive: true })) {
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (st.isFile()) out[name] = st.mtimeMs;
    } catch {}
  }
  return out;
}

async function runOne(modelRuntime, providerId, modelId) {
  const findings = [];
  const toolNamesSeen = new Set();

  const reportFinding = defineTool({
    name: "report_finding",
    label: "Report Finding",
    description: "Report one problem found in the code under review.",
    parameters: findingSchema,
    execute: async (_id, params) => {
      findings.push(params);
      return { content: [{ type: "text", text: "recorded" }], details: {} };
    },
  });

  const model = modelRuntime.getModel(providerId, modelId);
  if (!model) return { providerId, modelId, error: "model not found" };

  // Empty agentDir so no global extensions/skills/settings leak into the run.
  const emptyAgentDir = mkdtempSync(join(tmpdir(), "pi-spike-"));
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 1 },
  });
  const loader = new DefaultResourceLoader({
    cwd: FIXTURE,
    agentDir: emptyAgentDir,
    settingsManager,
    systemPromptOverride: () => SYSTEM_PROMPT,
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: FIXTURE,
    agentDir: emptyAgentDir,
    model,
    thinkingLevel: "off",
    modelRuntime,
    tools: [...READ_ONLY_TOOLS, "report_finding"],
    customTools: [reportFinding],
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(FIXTURE),
    settingsManager,
  });

  session.subscribe((event) => {
    if (event.type === "tool_execution_start") toolNamesSeen.add(event.toolName);
  });

  const exposedTools = session.agent.state.tools.map((t) => t.name).sort();
  const started = Date.now();
  let thrown;
  try {
    await session.prompt(REVIEW_PROMPT);
  } catch (e) {
    thrown = String(e?.message ?? e);
  }

  // prompt() resolves normally even when the model call failed. The failure is
  // only visible here — an orchestrator that skips this check silently loses a
  // whole Reviewer and still reports the run as complete.
  const last = session.messages.at(-1);
  const silentFailure = last?.stopReason === "error" ? last.errorMessage : undefined;
  const error = thrown ?? session.agent.state.errorMessage ?? silentFailure;
  session.dispose();

  return {
    providerId,
    modelId,
    error,
    threw: Boolean(thrown),
    seconds: Math.round((Date.now() - started) / 1000),
    exposedTools,
    toolsCalled: [...toolNamesSeen].sort(),
    findings,
  };
}

const modelRuntime = await ModelRuntime.create();
const before = snapshotMtimes(FIXTURE);

const results = [];
for (const [providerId, modelId] of CANDIDATES) {
  process.stdout.write(`running ${providerId}/${modelId} ... `);
  const r = await runOne(modelRuntime, providerId, modelId);
  process.stdout.write(r.error ? `ERROR\n` : `${r.findings.length} findings in ${r.seconds}s\n`);
  results.push(r);
}

const after = snapshotMtimes(FIXTURE);
const mutated = Object.keys(after).filter((k) => before[k] !== after[k]);

console.log("\n================ RESULT ================\n");

for (const r of results) {
  console.log(`### ${r.providerId}/${r.modelId}`);
  if (r.error) {
    console.log(`  FAILED (threw: ${r.threw}) — ${String(r.error).slice(0, 160)}`);
    console.log(`  findings contributed   : ${r.findings.length}\n`);
    continue;
  }
  console.log(`  tools exposed to model : ${r.exposedTools.join(", ")}`);
  console.log(`  tools actually called  : ${r.toolsCalled.join(", ") || "(none)"}`);
  console.log(`  findings               : ${r.findings.length}`);
  const malformed = r.findings.filter((f) =>
    REQUIRED_FIELDS.some((k) => f[k] === undefined || f[k] === null || f[k] === ""),
  );
  console.log(`  malformed              : ${malformed.length}`);
  for (const f of r.findings) {
    console.log(`    [${f.severity}/${f.category}] ${f.file}:${f.line} — ${String(f.description).slice(0, 90)}`);
  }
  console.log();
}

console.log("--- read-only check ---");
const writeTools = ["write", "edit", "bash"];
for (const r of results) {
  if (r.error) continue;
  const leaked = r.exposedTools.filter((t) => writeTools.includes(t));
  console.log(`  ${r.providerId}/${r.modelId}: write-capable tools exposed = ${leaked.length ? leaked.join(",") : "none"}`);
}
console.log(`  fixture files modified during run: ${mutated.length ? mutated.join(", ") : "none"}`);
