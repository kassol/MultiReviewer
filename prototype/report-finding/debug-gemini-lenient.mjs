// PROTOTYPE — throwaway. Does a lenient enum + server-side normalisation
// recover the findings Gemini lost to schema validation?
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import { createAgentSession, DefaultResourceLoader, defineTool, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const FIXTURE = resolve("fixture");
const recorded = [];
const rejected = [];

const SEVERITY = { critical: "high", high: "high", major: "high", medium: "medium", moderate: "medium", minor: "low", low: "low", info: "low" };
const CATEGORY = { security: "security", bug: "bug", logic_error: "bug", reliability: "bug", correctness: "bug", performance: "bug", maintainability: "maintainability", style: "maintainability", design: "design", architecture: "design" };

const reportFinding = defineTool({
  name: "report_finding",
  label: "Report Finding",
  description: "Report one problem found in the code under review.",
  parameters: Type.Object({
    file: Type.String({ description: "Repository-relative path of the file" }),
    line: Type.Integer({ description: "1-indexed line the problem starts on" }),
    severity: Type.String({ description: "One of exactly: high, medium, low" }),
    category: Type.String({ description: "One of exactly: security, bug, maintainability, design" }),
    description: Type.String({ description: "What is wrong and why it matters" }),
  }),
  execute: async (_id, p) => {
    const severity = SEVERITY[String(p.severity).toLowerCase()];
    const category = CATEGORY[String(p.category).toLowerCase()];
    if (!severity || !category) { rejected.push(p); return { content: [{ type: "text", text: "rejected" }], details: {} }; }
    recorded.push({ ...p, severity, category, rawSeverity: p.severity, rawCategory: p.category });
    return { content: [{ type: "text", text: "recorded" }], details: {} };
  },
});

const modelRuntime = await ModelRuntime.create();
const model = modelRuntime.getModel("openrouter", "google/gemini-3-flash-preview");
const dir = mkdtempSync(join(tmpdir(), "pi-gem2-"));
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
const loader = new DefaultResourceLoader({ cwd: FIXTURE, agentDir: dir, settingsManager, systemPromptOverride: () => "You are a code reviewer. Report each problem by calling the report_finding tool exactly once per problem. Do not describe problems in prose." });
await loader.reload();

const { session } = await createAgentSession({ cwd: FIXTURE, agentDir: dir, model, thinkingLevel: "off", modelRuntime, tools: ["read","grep","find","ls","report_finding"], customTools: [reportFinding], resourceLoader: loader, sessionManager: SessionManager.inMemory(FIXTURE), settingsManager });

let validationErrors = 0;
session.subscribe((e) => { if (e.type === "tool_execution_end" && e.isError) validationErrors++; });

await session.prompt("Review every file under src/ in this repository. Report all problems you find.");

console.log("recorded:", recorded.length, "| unmappable:", rejected.length, "| tool errors:", validationErrors);
for (const f of recorded) console.log(`  [${f.severity}/${f.category}] (raw: ${f.rawSeverity}/${f.rawCategory}) ${f.file}:${f.line} — ${f.description.slice(0,70)}`);
for (const f of rejected) console.log(`  UNMAPPABLE raw: ${f.severity}/${f.category}`);
session.dispose();
