/* SAMDEENIYOM bowl order server — serves the design page, receives orders, builds print files, notifies the shop.
   Config: .env next to this file (see .env.example). No npm install needed: libraries are vendored.
   Run behind a trusted proxy / tunnel on 127.0.0.1 (see README.md); set TRUST_PROXY=1 and IP_HEADER there. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.dirname(fileURLToPath(import.meta.url));

/* ---------- config ---------- */
const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const flag = (v, d) => (v === undefined || v === "" ? d : !/^(0|false|no|off)$/i.test(v));
const PORT = process.env.PORT === "0" ? 0 : (+process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const legacyOrders = path.join(os.homedir(), "modi-orders");   // folder used before the rebrand: keep reading it if nothing new exists
const defaultOrders = path.join(os.homedir(), "samdeeniyom-orders");
const ORDERS = path.resolve((process.env.ORDERS_DIR || (!fs.existsSync(defaultOrders) && fs.existsSync(legacyOrders) ? legacyOrders : defaultOrders)).replace(/^~/, os.homedir()));
const ADMIN_PASS = process.env.ADMIN_PASS || "";
const SHOP = process.env.SHOP_NAME || "SAMDEENIYOM";
const HOME_URL = /^https?:\/\//.test(process.env.HOME_URL || "") ? process.env.HOME_URL : "";   // link back to the main site (optional)
const TRUST_PROXY = flag(process.env.TRUST_PROXY, false);
const IP_HEADER = (process.env.IP_HEADER || "").toLowerCase();
fs.mkdirSync(ORDERS, { recursive: true });

const C = require("./lib/catalog.js");
const { buildOrder, phoneDigits } = require("./lib/order.js");
const JSZip = require("./vendor/jszip/jszip.min.js");
const BED = C.BED;

/* ---------- build worker (one job at a time) ---------- */
let worker, ready, jobs = new Map(), seq = 0, chain = Promise.resolve(), pending = 0;
function startWorker() {
  worker = new Worker(path.join(ROOT, "lib/build-worker.mjs"));
  ready = new Promise(res => worker.once("message", m => m.ready && res()));
  worker.on("message", m => { if (m.id && jobs.has(m.id)) { jobs.get(m.id)(m); jobs.delete(m.id); } });
  worker.on("error", e => console.error("[worker]", e));
  worker.on("exit", code => { console.error("[worker] exited", code); for (const [, cb] of jobs) cb({ ok: false, error: "worker exited" }); jobs.clear(); setTimeout(startWorker, 1000); });
}
startWorker();
const runJob = job => { pending++; return (chain = chain.then(async () => { await ready; return new Promise(res => { const id = ++seq; jobs.set(id, res); worker.postMessage({ ...job, id }); }); }).finally(() => { pending--; })); };

/* ---------- helpers ---------- */
const SEC = { "X-Content-Type-Options": "nosniff", "X-Frame-Options": "SAMEORIGIN", "Referrer-Policy": "same-origin" };
const CSP_PAGE = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'";
/* the geometry worker is our own file; its WASM glue needs eval, the page itself does not (a worker has its own CSP) */
const CSP_WORKER = "default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self'; object-src 'none'";
const CSP_ADMIN = "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const send = (res, code, body, type = "application/json; charset=utf-8", extra = {}) => { res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", ...SEC, ...extra }); res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
/* on an oversized body the rest is drained (not cut off) so the client still receives its 400 */
const readBody = (req, max = 32 * 1024) => new Promise((ok, bad) => { let n = 0; const ch = []; req.on("data", d => { n += d.length; if (n > max) { bad(new Error("too large")); req.removeAllListeners("data"); req.resume(); } else ch.push(d); }); req.on("end", () => ok(Buffer.concat(ch).toString("utf8"))); req.on("error", bad); });
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
/* The client address. Headers are only believed behind a trusted proxy (TRUST_PROXY=1): IP_HEADER (e.g. cf-connecting-ip), else the
   LAST X-Forwarded-For entry (the one our proxy appended; the first is whatever the client sent). Otherwise the socket address. */
const clientIp = req => {
  if (TRUST_PROXY) {
    const h = IP_HEADER && String(req.headers[IP_HEADER] || "").trim();
    if (h) return h;
    const last = String(req.headers["x-forwarded-for"] || "").split(",").pop().trim();
    if (last) return last;
  }
  return req.socket.remoteAddress || "";
};
/* sliding-window limiter with bounded memory */
function limiter(max, windowMs) {
  const hits = new Map();
  const live = k => { const t = Date.now(), a = (hits.get(k) || []).filter(x => t - x < windowMs); if (a.length) hits.set(k, a); else hits.delete(k); return a; };
  return {
    blocked: k => live(k).length >= max,
    hit: k => { const a = live(k); a.push(Date.now()); hits.set(k, a); if (hits.size > 5000) for (const x of [...hits.keys()]) live(x); return a.length > max; },
  };
}
const orderLim = limiter(10, 3600e3), statusLim = limiter(20, 900e3), authLim = limiter(10, 900e3);
const sameOrigin = req => { const o = req.headers.origin; if (!o) return true; try { return new URL(o).host === req.headers.host; } catch { return false; } };
const timingEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const authed = req => { if (!ADMIN_PASS) return false; const h = req.headers.authorization || ""; const m = h.match(/^Basic (.+)$/); if (!m) return false; const raw = Buffer.from(m[1], "base64").toString(); const i = raw.indexOf(":"); return i > 0 && timingEq(raw.slice(0, i), "admin") && timingEq(raw.slice(i + 1), ADMIN_PASS); };
const askAuth = res => send(res, 401, "ต้องเข้าสู่ระบบ", "text/plain; charset=utf-8", { "WWW-Authenticate": 'Basic realm="SAMDEENIYOM admin", charset="UTF-8"' });
const newId = () => { const d = new Date(Date.now() + 7 * 3600e3), p = n => String(n).padStart(2, "0"); return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}-${crypto.randomBytes(2).toString("hex")}`; };
const ID_RE = /^\d{8}-\d{4}-[0-9a-f]{4}$/;
const STATUSES = ["ใหม่", "ยืนยันแล้ว", "กำลังพิมพ์", "ส่งแล้ว", "ยกเลิก"];

async function notify(text) {
  const tasks = [];
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID)
    tasks.push(fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text }) }));
  if (process.env.DISCORD_WEBHOOK_URL)
    tasks.push(fetch(process.env.DISCORD_WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: text.slice(0, 1900) }) }));
  if (process.env.LINE_CHANNEL_TOKEN && process.env.LINE_TO)
    tasks.push(fetch("https://api.line.me/v2/bot/message/push", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.LINE_CHANNEL_TOKEN}` }, body: JSON.stringify({ to: process.env.LINE_TO, messages: [{ type: "text", text: text.slice(0, 4900) }] }) }));
  const r = await Promise.allSettled(tasks); r.forEach(x => x.status === "rejected" && console.error("[notify]", x.reason));
}

/* ---------- order handling ---------- */
async function handleOrder(req, res) {
  const ip = clientIp(req);
  if (!sameOrigin(req)) return send(res, 403, { error: "คำขอไม่ถูกต้อง" });
  if (orderLim.hit(ip)) return send(res, 429, { error: "ส่งคำสั่งทำบ่อยเกินไป ลองใหม่ภายหลัง" });
  if (pending >= 20) return send(res, 503, { error: "ร้านกำลังประมวลผลหลายออเดอร์ ลองใหม่ในอีกสักครู่" });
  let body; try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: "ข้อมูลไม่ถูกต้อง" }); }
  let o; try { o = buildOrder(body || {}); } catch (e) { return send(res, 400, { error: e.message }); }
  const id = newId(), dir = path.join(ORDERS, id);
  const base = `samdeeniyom-${id}`;
  const r = await runJob({ spec: o.spec, colors: o.roleColors, order: { title: `${SHOP} #${id} · ${o.summary.name || "-"}`, fileBase: base, lines: o.lines, json: { id, ...o.summary } }, printer: `พื้นพิมพ์ ${BED.x}×${BED.y} มม.`, bed: [BED.x, BED.y] });
  if (!r.ok) { console.error("[build]", r.error); return send(res, 500, { error: "สร้างไฟล์ไม่สำเร็จ ร้านจะติดต่อกลับ" }); }
  fs.mkdirSync(dir, { recursive: true });
  const zipBytes = Buffer.from(r.bytes);
  fs.writeFileSync(path.join(dir, base + ".zip"), zipBytes);
  const z = await JSZip.loadAsync(zipBytes);
  for (const [name, f] of Object.entries(z.files)) {
    if (f.dir) continue;
    const out = path.resolve(dir, name);
    if (!out.startsWith(dir + path.sep)) continue;                 // never write outside the order folder
    fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, await f.async("nodebuffer"));
  }
  const meta = { id, created: new Date().toISOString(), status: "ใหม่", ip, ...o.summary, pieces: r.pieces, buildMs: r.ms };
  fs.writeFileSync(path.join(dir, "order.json"), JSON.stringify(meta, null, 2));
  console.log(`[order] ${id} ${o.summary.designLabel} "${o.summary.name}" ${o.summary.size} ฿${o.summary.total} (${r.ms} ms)`);
  notify(`🛒 ออเดอร์ใหม่ #${id}\n${o.lines.join("\n")}\nไฟล์: ${dir}`).catch(() => {});
  send(res, 200, { id, total: o.summary.total });
}

/* the customer checks an order with its number + the phone number used (the number alone is guessable and must not leak anything) */
async function handleStatus(req, res) {
  if (!sameOrigin(req)) return send(res, 403, { error: "คำขอไม่ถูกต้อง" });
  if (statusLim.hit(clientIp(req))) return send(res, 429, { error: "ตรวจสอบบ่อยเกินไป ลองใหม่ภายหลัง" });
  let b; try { b = JSON.parse(await readBody(req, 2048)); } catch { return send(res, 400, { error: "ข้อมูลไม่ถูกต้อง" }); }
  const id = String((b && b.id) || "").trim().replace(/^#/, ""), phone = phoneDigits(b && b.phone);
  const notFound = () => send(res, 404, { error: "ไม่พบออเดอร์ ตรวจเลขที่และเบอร์โทรที่ใช้สั่งอีกครั้ง" });
  if (!ID_RE.test(id) || phone.length < 8) return notFound();
  let o; try { o = JSON.parse(fs.readFileSync(path.join(ORDERS, id, "order.json"), "utf8")); } catch { return notFound(); }
  if (!timingEq(phoneDigits(o.contact && o.contact.phone), phone)) return notFound();
  send(res, 200, { id: o.id, status: o.status, name: o.name, designLabel: o.designLabel, size: o.size, qty: o.qty, total: o.total, created: o.created });
}

/* ---------- admin pages ---------- */
function listOrders() {
  return fs.readdirSync(ORDERS).filter(d => ID_RE.test(d) && fs.existsSync(path.join(ORDERS, d, "order.json")))
    .map(d => { try { return JSON.parse(fs.readFileSync(path.join(ORDERS, d, "order.json"), "utf8")); } catch { return null; } })
    .filter(Boolean).sort((a, b) => b.created.localeCompare(a.created));
}
function adminPage() {
  const rows = listOrders().map(o => `<tr><td><b>${esc(o.id)}</b><br><small>${esc(new Date(o.created).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" }))}</small></td>
    <td>${esc(o.name || "-")}<br><small>${esc(o.designLabel)} · ${esc(o.size)} × ${o.qty}</small></td>
    <td>${esc(o.contact.name)}<br><small>${esc(o.contact.phone)}${o.contact.line ? " · LINE " + esc(o.contact.line) : ""}</small>${o.note ? `<br><small>📝 ${esc(o.note)}</small>` : ""}</td>
    <td class="num">฿${o.total.toLocaleString("th-TH")}</td>
    <td><form method="post" action="/admin/orders/${esc(o.id)}/status"><select name="s" data-auto>${STATUSES.map(s => `<option${s === o.status ? " selected" : ""}>${s}</option>`).join("")}</select><noscript><button>บันทึก</button></noscript></form></td>
    <td><a href="/admin/orders/${esc(o.id)}/samdeeniyom-${esc(o.id)}.zip">ไฟล์พิมพ์ .zip</a><br><a href="/admin/orders/${esc(o.id)}/README.txt">ใบสรุป</a></td></tr>`).join("");
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(SHOP)} · ออเดอร์ชาม</title>
<style>body{font-family:"Anuphan",system-ui,sans-serif;background:#322D27;color:#E2E1EB;margin:0;padding:16px}h1{font-size:1.3rem}table{width:100%;border-collapse:collapse;background:#3b352e;border:1px solid #484038}td,th{padding:10px;border-bottom:1px solid #484038;text-align:left;vertical-align:top;font-size:.92rem}small{color:#AAAAAE}.num{font-variant-numeric:tabular-nums;white-space:nowrap}a{color:#BF8440}select{background:#322D27;color:inherit;border:1px solid #554c43;border-radius:8px;padding:5px}.wrap{overflow-x:auto}</style></head>
<body><h1>${esc(SHOP)} · ออเดอร์ชามสลักชื่อ</h1><p><small>ไฟล์ทั้งหมดอยู่ที่ ${esc(ORDERS)} · พื้นพิมพ์ ${BED.x}×${BED.y} มม.</small></p>
<div class="wrap"><table><tr><th>ออเดอร์</th><th>ชื่อบนชาม</th><th>ลูกค้า</th><th>ราคา</th><th>สถานะ</th><th>ไฟล์</th></tr>${rows || '<tr><td colspan="6">ยังไม่มีออเดอร์</td></tr>'}</table></div><script src="/admin/admin.js"></script></body></html>`;
}
const ADMIN_JS = `for (const s of document.querySelectorAll("select[data-auto]")) s.addEventListener("change", () => s.form.submit());`;

/* ---------- static files (explicit allow-list: nothing else on disk is reachable) ---------- */
const MIME = { ".txt": "text/plain; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".ttf": "font/ttf", ".woff2": "font/woff2", ".wasm": "application/wasm", ".svg": "image/svg+xml" };
const ROUTES = new Map([
  ["/", "public/index.html"], ["/index.html", "public/index.html"], ["/style.css", "public/style.css"], ["/app.js", "public/app.js"], ["/lib-worker.js", "public/lib-worker.js"],
  ["/logo.png", "public/logo.png"], ["/theme.js", "public/theme.js"], ["/licenses.html", "public/licenses.html"], ["/catalog-data.js", "lib/catalog-data.js"],
  ["/vendor/three.min.js", "public/vendor/three.min.js"], ["/vendor/OrbitControls.js", "public/vendor/OrbitControls.js"],
  ["/vendor/manifold.wasm", "vendor/manifold-3d/manifold.wasm"], ["/vendor/hb.wasm", "vendor/harfbuzzjs/hb.wasm"],
]);
function staticFile(p) {
  let rel = ROUTES.get(p), m;
  if (!rel && (m = p.match(/^\/fonts\/([A-Za-z0-9][A-Za-z0-9_.-]*\.(?:ttf|woff2))$/)))
    rel = fs.existsSync(path.join(ROOT, "public/fonts", m[1])) ? `public/fonts/${m[1]}` : `fonts/${m[1]}`;
  if (!rel && (m = p.match(/^\/licenses\/([A-Za-z0-9][A-Za-z0-9_.-]*\.txt)$/))) rel = `public/licenses/${m[1]}`;
  if (!rel) return null;
  const f = path.join(ROOT, rel);
  return fs.existsSync(f) && fs.statSync(f).isFile() ? f : null;
}
function serveStatic(req, res, p) {
  const f = staticFile(p);
  if (!f) return false;
  const ext = path.extname(f), live = [".html", ".js", ".css"].includes(ext);
  const headers = { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": live ? "no-cache" : "public, max-age=86400", ...SEC };
  if (ext === ".html") headers["Content-Security-Policy"] = CSP_PAGE;
  else if (p === "/lib-worker.js") headers["Content-Security-Policy"] = CSP_WORKER;
  const buf = fs.readFileSync(f);
  res.writeHead(200, { ...headers, "Content-Length": buf.length });
  res.end(req.method === "HEAD" ? undefined : buf);
  return true;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x"); let p;
    try { p = decodeURIComponent(url.pathname); } catch { return send(res, 400, "bad request", "text/plain; charset=utf-8"); }
    if ((req.method === "GET" || req.method === "HEAD") && serveStatic(req, res, p)) return;
    if (req.method === "GET" && p === "/api/health") return send(res, 200, { ok: true, shop: SHOP });
    if (req.method === "GET" && p === "/api/config") return send(res, 200, { ...C.publicConfig(SHOP), homeUrl: HOME_URL });
    if (req.method === "POST" && p === "/api/order") return handleOrder(req, res);
    if (req.method === "POST" && p === "/api/order/status") return handleStatus(req, res);
    if (p.startsWith("/admin")) {
      const ip = clientIp(req);
      if (authLim.blocked(ip)) return send(res, 429, "ลองผิดหลายครั้ง รอสักครู่แล้วลองใหม่", "text/plain; charset=utf-8", { "Retry-After": "900" });
      if (!authed(req)) { if (req.headers.authorization) authLim.hit(ip); return askAuth(res); }
      const adminHeaders = { "Content-Security-Policy": CSP_ADMIN };
      if (req.method === "GET" && p === "/admin/admin.js") return send(res, 200, ADMIN_JS, "text/javascript; charset=utf-8", adminHeaders);
      if (req.method === "GET" && (p === "/admin" || p === "/admin/")) return send(res, 200, adminPage(), "text/html; charset=utf-8", adminHeaders);
      let m = p.match(/^\/admin\/orders\/(\d{8}-\d{4}-[0-9a-f]{4})\/status$/);
      if (m && req.method === "POST") {
        if (!sameOrigin(req)) return send(res, 403, "คำขอไม่ถูกต้อง", "text/plain; charset=utf-8");
        const f = path.join(ORDERS, m[1], "order.json"); const s = new URLSearchParams(await readBody(req)).get("s");
        if (fs.existsSync(f) && STATUSES.includes(s)) { const o = JSON.parse(fs.readFileSync(f, "utf8")); o.status = s; fs.writeFileSync(f, JSON.stringify(o, null, 2)); }
        res.writeHead(303, { Location: "/admin", ...SEC }); return res.end();
      }
      m = p.match(/^\/admin\/orders\/(\d{8}-\d{4}-[0-9a-f]{4})\/([A-Za-z0-9][A-Za-z0-9._-]*)$/);
      if (m && req.method === "GET") {
        const dir = path.join(ORDERS, m[1]), f = path.resolve(dir, m[2]);
        if (!f.startsWith(dir + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return send(res, 404, "ไม่พบไฟล์", "text/plain; charset=utf-8");
        const type = f.endsWith(".zip") ? "application/zip" : f.endsWith(".txt") ? "text/plain; charset=utf-8" : "application/octet-stream";
        return send(res, 200, fs.readFileSync(f), type, f.endsWith(".zip") ? { "Content-Disposition": `attachment; filename="${m[2]}"` } : {});
      }
    }
    send(res, 404, "ไม่พบหน้า", "text/plain; charset=utf-8");
  } catch (e) { console.error(e); try { send(res, 500, { error: "server error" }); } catch {} }
});
server.listen(PORT, HOST, () => console.log(`[samdeeniyom] http://${HOST}:${server.address().port}  orders → ${ORDERS}  plate ${BED.x}x${BED.y}${ADMIN_PASS ? "" : "  (ตั้ง ADMIN_PASS ใน .env เพื่อเปิดหน้า /admin)"}`));
if (TRUST_PROXY && HOST !== "127.0.0.1" && HOST !== "::1") console.warn("[samdeeniyom] TRUST_PROXY is on but HOST is not loopback: anyone who can reach this port can forge their IP. Bind to 127.0.0.1 behind the proxy.");
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { console.log(`[samdeeniyom] ${sig}, shutting down`); server.close(); process.exit(0); });
