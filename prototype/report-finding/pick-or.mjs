import { ModelRuntime } from "@earendil-works/pi-coding-agent";
const rt = await ModelRuntime.create();
const all = await rt.getAvailable();
const or = all.filter(m => (m.provider ?? m.providerId) === "openrouter").map(m => m.id);
for (const pat of ["google/gemini-3", "google/gemini-2.5-flash", "qwen/qwen3", "z-ai/glm", "mistralai/mistral-medium", "x-ai/grok-4"]) {
  console.log(pat, "->", or.filter(i => i.startsWith(pat)).slice(0,4).join(" | ") || "(none)");
}
