#!/bin/bash
# Browser test, all modes, fresh servers (engine on :5055, Claude API stand-in on :5099). Usage: e2e/all.sh
D=$(cd "$(dirname "$0")" && pwd); R=$(cd "$D/.." && pwd)
export NODE_PATH=${NODE_PATH:-$(npm root -g)}
stop() { for p in $(ps -eo pid,args | awk '$2 ~ /python/ && ($3 ~ /engine.py$/ || $3 ~ /stub_claude.py$/) {print $1}'); do kill $p 2>/dev/null; done; for i in $(seq 40); do curl -sk -m 1 https://127.0.0.1:5055/health >/dev/null || curl -s -m 1 http://127.0.0.1:5099 >/dev/null || break; sleep 0.25; done; sleep 0.5; }
engine() { (cd $R && env "$@" .venv/bin/python $D/engine.py $D/cert &> $D/engine.out &); for i in $(seq 40); do curl -sk https://127.0.0.1:5055/health >/dev/null && return; sleep 0.25; done; echo "engine did not start"; }
stop; rm -f $D/claude.log; (python3 $D/stub_claude.py $D/claude.log &> $D/stub.out &)
fail=0
engine ANTHROPIC_API_KEY=test ANTHROPIC_BASE_URL=http://127.0.0.1:5099
for m in ${MODES:-ai oldengine layout layers}; do echo "== $m"; (cd $D && timeout 150 node run.mjs $m) || fail=1; done
stop; engine -u ANTHROPIC_API_KEY
echo "== nokey"; (cd $D && timeout 150 node run.mjs nokey) || fail=1
stop
exit $fail
