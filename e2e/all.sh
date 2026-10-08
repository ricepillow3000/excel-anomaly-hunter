#!/bin/bash
# Browser test, all modes, fresh servers (engine on :5055, Claude API stand-in on :5099). Usage: e2e/all.sh
# Linux/macOS or Git Bash on Windows. Port 5055 must be free: stop the installed engine first.
D=$(cd "$(dirname "$0")" && pwd); R=$(cd "$D/.." && pwd)
export NODE_PATH=${NODE_PATH:-$(npm root -g)}
PY=$R/.venv/bin/python; [ -x "$PY" ] || PY=$R/.venv/Scripts/python.exe
if curl -sk -m 2 https://127.0.0.1:5055/health >/dev/null; then echo "Port 5055 is in use (the installed engine?). Stop it, then run this again."; exit 2; fi
ENGINE= STUB=
# Windows: venv python.exe is a launcher with a child process - kill the whole tree, not just the launcher
end() { [ -n "$1" ] || return 0; if [ -r "/proc/$1/winpid" ]; then taskkill //F //T //PID "$(cat /proc/$1/winpid)" >/dev/null 2>&1; else kill "$1" 2>/dev/null; fi; }
stop() { end "$ENGINE"; end "$STUB"; ENGINE= STUB=
  for i in $(seq 40); do curl -sk -m 1 https://127.0.0.1:5055/health >/dev/null || curl -s -m 1 http://127.0.0.1:5099 >/dev/null || break; sleep 0.25; done; sleep 0.5; }
engine() { (cd "$R" && exec env "$@" "$PY" "$D/engine.py" "$D/cert" &> "$D/engine.out") & ENGINE=$!
  for i in $(seq 40); do curl -sk https://127.0.0.1:5055/health >/dev/null && return; sleep 0.25; done; echo "engine did not start"; }
rm -f "$D/claude.log"; (exec "$PY" "$D/stub_claude.py" "$D/claude.log" &> "$D/stub.out") & STUB=$!
fail=0
engine ANTHROPIC_API_KEY=test ANTHROPIC_BASE_URL=http://127.0.0.1:5099 GEMINI_API_KEY=
for m in ${MODES:-flow ai}; do echo "== $m"; (cd "$D" && timeout 150 node run.mjs $m) || fail=1; done
end "$ENGINE"; sleep 1; engine -u ANTHROPIC_API_KEY GEMINI_API_KEY=
echo "== nokey"; (cd "$D" && timeout 150 node run.mjs nokey) || fail=1
stop
exit $fail
