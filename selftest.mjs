import { Worker } from "node:worker_threads";
import path from "node:path"; import { fileURLToPath } from "node:url";
const w = new Worker(path.join(path.dirname(fileURLToPath(import.meta.url)), "lib/build-worker.mjs"));
const c = (n, h) => ({ name: n, hex: h });
w.on("message", m => {
  if (m.ready) return w.postMessage({ id: 1, spec: { design: "round", name: "ทดสอบ", font: "Mitr", icon: "none", scale: 1 },
    colors: { body: c("a", "#ffffff"), body2: c("a", "#ffffff"), base: c("b", "#000000"), text: c("c", "#000000"), tpu: c("t", "#222222") },
    order: { title: "t", fileBase: "t", lines: [], json: {} }, bed: [220, 220] });
  console.log(m.ok ? `self-test ok (${m.ms} ms)` : `self-test FAILED: ${m.error}`); process.exit(m.ok ? 0 : 1);
});
