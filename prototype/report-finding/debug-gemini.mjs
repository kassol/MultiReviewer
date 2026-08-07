// PROTOTYPE — throwaway. Gemini called report_finding but nothing was recorded.
// Capture every tool_execution_end (including errors) and the raw params.
import { mkdtempSync } from "node:fs";
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
const recorded = [];
const attempts = [];

const reportFinding = defineTool({
  name: "report_finding",
  label: "Report Finding",
  description: "Report one problem found in the code under review.",
  parameters: Type.Object({
    file: Type.String({ description: "Repository-relative path of the file" }),
    line: Type.Integer({ description: "1-indexed line the problem starts on" }),
    severity: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
    category: Type.Union([
      Type.Literal("security"),
      Type.Literal("bug"),
      Type.Literal("maintainability"),
      Type.Literal("design"),
    ]),
    description: Type.String({ description: "What is wrong and why it matters" }),
  }),
  execute: async (_id, params) => {
    recorded.push(params);
    return { content: [{ type: "text", text: "recorded" }], details: {} };
  },
});

const modelRuntime = await ModelRuntime.create();
const model = modelRuntime.getModel("openrouter", "google/gemini-3-flash-preview");
const emptyAgentDir = mkdtempSync(join(tmpdir(), "pi-gem-"));
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
const loader = new DefaultResourceLoader({
  cwd: FIXTURE,
  agentDir: emptyAgentDir,
  settingsManager,
  systemPromptOverride: () =>
    "You are a code reviewer. Report each problem by calling the report_finding tool exactly once per problem. Do not describe problems in prose.",
});
await loader.reload();

const { session } = await createAgentSession({
  cwd: FIXTURE,
  agentDir: emptyAgentDir,
  model,
  thinkingLevel: "off",
  modelRuntime,
  tools: ["read", "grep", "find", "ls", "report_finding"],
  customTools: [reportFinding],
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(FIXTURE),
  settingsManager,
});

session.subscribe((event) => {
  if (event.type === "tool_execution_start") {
    attempts.push({ phase: "start", tool: event.toolName, args: event.args ?? event.params ?? event.input });
  }
  if (event.type === "tool_execution_end") {
    attempts.push({ phase: "end", tool: event.toolName, isError: event.isError, result: JSON.stringify(event.result ?? event.output ?? "").slice(0, 300) });
  }
});

await session.prompt("Review every file under src/ in this repository. Report all problems you find.");

console.log("\n--- tool attempts ---");
for (const a of attempts) console.log(JSON.stringify(a).slice(0, 400));
console.log("\nrecorded findings:", recorded.length);
console.log("errorMessage:", session.agent.state.errorMessage ?? "(none)");

console.log("\n--- raw report_finding tool calls in message history ---");
for (const m of session.messages) {
  for (const c of m.content ?? []) {
    if (c.type === "toolCall" || c.type === "tool_use" || c.type === "toolUse") {
      console.log(JSON.stringify(c).slice(0, 500));
    }
  }
}
session.dispose();
