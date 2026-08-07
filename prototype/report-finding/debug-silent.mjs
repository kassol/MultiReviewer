// PROTOTYPE — throwaway. Why did kimi-coding and openai-codex return nothing?
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const FIXTURE = resolve("fixture");
const TARGETS = [
  ["kimi-coding", "k3"],
  ["openai-codex", "gpt-5.4-mini"],
];

const modelRuntime = await ModelRuntime.create();

for (const [providerId, modelId] of TARGETS) {
  console.log(`\n=== ${providerId}/${modelId} ===`);
  const model = modelRuntime.getModel(providerId, modelId);
  console.log("model resolved:", !!model, model ? JSON.stringify({ id: model.id, provider: model.provider, api: model.api }) : "");
  console.log("auth status:", JSON.stringify(await modelRuntime.checkAuth(providerId)));

  const emptyAgentDir = mkdtempSync(join(tmpdir(), "pi-dbg-"));
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: FIXTURE,
    agentDir: emptyAgentDir,
    settingsManager,
    systemPromptOverride: () => "You are a helpful assistant.",
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: FIXTURE,
    agentDir: emptyAgentDir,
    model,
    thinkingLevel: "off",
    modelRuntime,
    tools: ["read", "ls"],
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(FIXTURE),
    settingsManager,
  });

  let text = "";
  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      text += event.assistantMessageEvent.delta;
    }
    if (event.type === "tool_execution_start") console.log("  tool call:", event.toolName);
  });

  try {
    await session.prompt("List the files under src/ using your ls tool, then say DONE.");
  } catch (e) {
    console.log("  prompt threw:", String(e?.message ?? e));
  }

  console.log("  errorMessage:", session.agent.state.errorMessage ?? "(none)");
  console.log("  assistant text:", JSON.stringify(text.slice(0, 400)));
  console.log("  message count:", session.messages.length);
  const last = session.messages.at(-1);
  console.log("  last message:", JSON.stringify(last).slice(0, 600));
  session.dispose();
}
