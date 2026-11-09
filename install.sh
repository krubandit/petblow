#!/usr/bin/env bash
# SAMDEENIYOM bowl server installer — no sudo needed.
#   ./install.sh            install / update and start the server (http://127.0.0.1:8787)
#   ./install.sh --tunnel   also open a free public link via Cloudflare quick tunnel
set -euo pipefail
APP_DIR="${SDN_DIR:-$HOME/samdeeniyom-bowl}"
SRC="$(cd "$(dirname "$0")" && pwd)"
say(){ printf '\033[1;35m[samdeeniyom]\033[0m %s\n' "$*"; }

# 1) copy files (keeps an existing .env)
mkdir -p "$APP_DIR"
if [ "$SRC" != "$APP_DIR" ]; then
  tar -C "$SRC" --exclude=.env --exclude=node --exclude=bin -cf - . | tar -C "$APP_DIR" -xf -
fi
cd "$APP_DIR"

# 2) Node.js >= 18 (uses system node if new enough, otherwise a private copy in $APP_DIR/node)
NODE="$(command -v node || true)"
if [ -n "$NODE" ] && [ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -ge 18 ]; then :
elif [ -x "$APP_DIR/node/bin/node" ]; then NODE="$APP_DIR/node/bin/node"
else
  case "$(uname -m)" in x86_64) A=x64;; aarch64|arm64) A=arm64;; *) echo "unsupported CPU $(uname -m)"; exit 1;; esac
  V=v20.18.1; say "downloading Node.js $V ($A)…"
  curl -fsSL "https://nodejs.org/dist/$V/node-$V-linux-$A.tar.xz" -o /tmp/samdeeniyom-node.tar.xz
  mkdir -p "$APP_DIR/node" && tar -xJf /tmp/samdeeniyom-node.tar.xz -C "$APP_DIR/node" --strip-components=1 && rm -f /tmp/samdeeniyom-node.tar.xz
  NODE="$APP_DIR/node/bin/node"
fi
say "node: $NODE ($("$NODE" -v))"

# 3) settings
if [ ! -f .env ]; then
  cp .env.example .env
  PASS="$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 14)"
  sed -i "s/^ADMIN_PASS=.*/ADMIN_PASS=$PASS/" .env
  say "created .env (admin password generated)"
fi
PORT="$(grep -E '^PORT=' .env | cut -d= -f2)"; PORT="${PORT:-8787}"

if [ "${1:-}" = "--tunnel" ]; then   # behind the quick tunnel the visitor's address arrives in CF-Connecting-IP (else everyone looks like 127.0.0.1)
  for kv in TRUST_PROXY=1 IP_HEADER=cf-connecting-ip; do k="${kv%%=*}"; if grep -qE "^$k=" .env; then sed -i "s|^$k=.*|$kv|" .env; else echo "$kv" >> .env; fi; done
fi

# 4) quick self-test: build one bowl
say "self-test…"
"$NODE" "$APP_DIR/selftest.mjs"

# 5) run as a background service (systemd user service, or @reboot fallback)
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
start_fallback(){
  pkill -f "$APP_DIR/server.mjs" 2>/dev/null || true
  nohup "$NODE" "$APP_DIR/server.mjs" >> "$APP_DIR/server.log" 2>&1 &
  ( crontab -l 2>/dev/null | grep -v 'samdeeniyom-bowl' ; echo "@reboot cd $APP_DIR && $NODE $APP_DIR/server.mjs >> $APP_DIR/server.log 2>&1 # samdeeniyom-bowl" ) | crontab - 2>/dev/null || true
  say "started with nohup (+ crontab @reboot)"
}
if systemctl --user show-environment >/dev/null 2>&1; then
  mkdir -p ~/.config/systemd/user
  cat > ~/.config/systemd/user/samdeeniyom-bowl.service <<EOF
[Unit]
Description=SAMDEENIYOM bowl order server
After=network-online.target
[Service]
WorkingDirectory=$APP_DIR
ExecStart=$NODE $APP_DIR/server.mjs
Restart=always
RestartSec=3
[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable samdeeniyom-bowl.service >/dev/null 2>&1
  systemctl --user restart samdeeniyom-bowl.service
  loginctl enable-linger "$USER" >/dev/null 2>&1 || say "ถ้าอยากให้เปิดเองตอนบูตโดยไม่ต้องล็อกอิน: sudo loginctl enable-linger $USER"
  say "systemd service samdeeniyom-bowl is running"
else
  start_fallback
fi

# 6) optional public link via Cloudflare quick tunnel (free, URL changes when the tunnel restarts)
if [ "${1:-}" = "--tunnel" ]; then
  mkdir -p "$APP_DIR/bin"
  if [ ! -x "$APP_DIR/bin/cloudflared" ]; then
    case "$(uname -m)" in x86_64) CA=amd64;; aarch64|arm64) CA=arm64;; esac
    say "downloading cloudflared…"
    curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$CA" -o "$APP_DIR/bin/cloudflared"
    chmod +x "$APP_DIR/bin/cloudflared"
  fi
  : > "$APP_DIR/tunnel.log"
  if systemctl --user show-environment >/dev/null 2>&1; then
    cat > ~/.config/systemd/user/samdeeniyom-tunnel.service <<EOF
[Unit]
Description=samdeeniyom public link (Cloudflare quick tunnel)
After=samdeeniyom-bowl.service
[Service]
ExecStart=$APP_DIR/bin/cloudflared tunnel --no-autoupdate --url http://127.0.0.1:$PORT --logfile $APP_DIR/tunnel.log
Restart=always
RestartSec=5
[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload; systemctl --user enable samdeeniyom-tunnel.service >/dev/null 2>&1; systemctl --user restart samdeeniyom-tunnel.service
  else
    pkill -f "cloudflared tunnel --no-autoupdate --url http://127.0.0.1:$PORT" 2>/dev/null || true
    nohup "$APP_DIR/bin/cloudflared" tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" --logfile "$APP_DIR/tunnel.log" >/dev/null 2>&1 &
    ( crontab -l 2>/dev/null | grep -v 'samdeeniyom-tunnel' ; echo "@reboot $APP_DIR/bin/cloudflared tunnel --no-autoupdate --url http://127.0.0.1:$PORT --logfile $APP_DIR/tunnel.log # samdeeniyom-tunnel" ) | crontab - 2>/dev/null || true
  fi
  for i in $(seq 1 30); do URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$APP_DIR/tunnel.log" | head -1 || true)"; [ -n "$URL" ] && break; sleep 1; done
fi

# 7) summary
sleep 2
if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then say "server OK → http://127.0.0.1:$PORT"; else say "server not answering yet — check: $APP_DIR/server.log or journalctl --user -u samdeeniyom-bowl"; fi
say "หน้าร้าน (ลูกค้า):  ${URL:-http://127.0.0.1:$PORT}/"
say "หลังบ้าน (ร้าน):    ${URL:-http://127.0.0.1:$PORT}/admin   user: admin   pass: $(grep -E '^ADMIN_PASS=' .env | cut -d= -f2)"
say "ไฟล์ออเดอร์:        $(grep -E '^ORDERS_DIR=' .env | cut -d= -f2)"
