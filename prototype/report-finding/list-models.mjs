import { ModelRuntime } from "@earendil-works/pi-coding-agent";
const rt = await ModelRuntime.create();
const available = await rt.getAvailable();
const byProvider = {};
for (const m of available) {
  const p = m.provider ?? m.providerId ?? "?";
  (byProvider[p] ??= []).push(m.id);
}
for (const [p, ids] of Object.entries(byProvider)) {
  console.log(`${p}: ${ids.length} models`);
  console.log("  " + ids.slice(0, 12).join(", "));
}
