"""Stand-in for the Claude API on :5099, and for John's relay's POST /fix (AH-151: the free AI with no key, in Google's
OpenAI-style answer). Records each request; answers a fixed fix for the flagged cell it finds."""
import json, re, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
LOG = sys.argv[1]
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        prompt = body["messages"][0]["content"]
        with open(LOG, "a") as f:
            f.write(json.dumps({"path": self.path, "model": body["model"], "prompt": prompt, "format": "output_config" in body,
                                "tools": [t["type"] for t in body.get("tools", [])], "turns": len(body["messages"]),
                                "auth": "Authorization" in self.headers}) + "\n")
        if "distinct values of some text columns" in prompt:  # /odd-text: a hostile answer the engine and pane must tame
            values = json.loads(prompt.splitlines()[1])
            col = next(iter(values))
            ans = {"odd": [{"column": col, "value": values[col][0], "why": "<img src=x onerror=window.__pwned=1> a city"},
                           {"column": col, "value": "Atlantis", "why": "not in the sheet at all"}]}
            return self.reply(body, ans)
        flagged = re.search(r"Flagged row (\d+):", prompt).group(1)
        rng = re.search(r"Data range: (\S+)", prompt).group(1)
        last = rng.split(":")[1][1:]
        req = re.search(r"^User's request: (.*)$", prompt, re.M).group(1).lower()  # its own line: sheet text can't forge one
        if "slow" in req:
            import time; time.sleep(3)  # an AI answer that arrives late
        if "delete" in req:
            ans = {"explanation": "Deleting rows can't be done by writing cells: right-click the row number > Delete.", "changes": []}
        else:
            n = int(flagged)
            if "circular" in req:  # a careless answer: the guard must drop it
                ans = {"explanation": "Median.", "changes": [{"cell": f"C{n}", "new": f"=MEDIAN(C2:C{last})"}]}
            else:
                ans = {"explanation": f"Average Units for East, leaving row {n} out.",
                       "changes": [{"cell": f"c{n}", "new": f'=AVERAGEIFS(C2:C{n-1},B2:B{n-1},"East")'}]}
        self.reply(body, ans)
    def reply(self, body, ans):
        if self.path == "/fix":  # the relay passes Google's OpenAI-style answer on as it is
            out = json.dumps({"choices": [{"message": {"content": json.dumps(ans)}}]}).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(out))); self.end_headers(); self.wfile.write(out)
            return
        out = json.dumps({"id": "msg_1", "type": "message", "role": "assistant", "model": body["model"],
                          "content": [{"type": "text", "text": json.dumps(ans)}], "stop_reason": "end_turn",
                          "stop_sequence": None, "usage": {"input_tokens": 1, "output_tokens": 1}}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out))); self.end_headers(); self.wfile.write(out)
    def log_message(self, *a): pass
HTTPServer(("127.0.0.1", 5099), H).serve_forever()
