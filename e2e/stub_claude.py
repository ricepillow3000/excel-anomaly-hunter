"""Stand-in for the Claude API on :5099. Records each request; answers a fixed fix for the flagged cell it finds."""
import json, re, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
LOG = sys.argv[1]
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        prompt = body["messages"][0]["content"]
        with open(LOG, "a") as f:
            f.write(json.dumps({"path": self.path, "model": body["model"], "prompt": prompt, "format": "output_config" in body}) + "\n")
        if "Flagged row" not in prompt:  # /triage
            ans = {"results": [{"row_index": int(i), "verdict": "broken-weird", "reason": "Looks like a typo.",
                                "safe_action": "add_note", "suggested_action_detail": "Check the source."}
                               for i in re.findall(r"row_index (\d+)", prompt)]}
            return self.reply(body, ans)
        flagged = re.search(r"Flagged row (\d+):", prompt).group(1)
        rng = re.search(r"Data range: (\S+)", prompt).group(1)
        last = rng.split(":")[1][1:]
        if "slow" in prompt.split("User's request:")[1].split("\n")[0].lower():
            import time; time.sleep(3)  # an AI answer that arrives late
        if "delete" in prompt.split("User's request:")[1].split("\n")[0].lower():
            ans = {"explanation": "Deleting rows can't be done by writing cells: right-click the row number > Delete.", "changes": []}
        else:
            req = prompt.split("User's request:")[1].split("\n")[0].lower()
            n = int(flagged)
            if "circular" in req:  # a careless answer: the guard must drop it
                ans = {"explanation": "Median.", "changes": [{"cell": f"C{n}", "new": f"=MEDIAN(C2:C{last})"}]}
            else:
                ans = {"explanation": f"Average Units for East, leaving row {n} out.",
                       "changes": [{"cell": f"c{n}", "new": f'=AVERAGEIFS(C2:C{n-1},B2:B{n-1},"East")'}]}
        self.reply(body, ans)
    def reply(self, body, ans):
        out = json.dumps({"id": "msg_1", "type": "message", "role": "assistant", "model": body["model"],
                          "content": [{"type": "text", "text": json.dumps(ans)}], "stop_reason": "end_turn",
                          "stop_sequence": None, "usage": {"input_tokens": 1, "output_tokens": 1}}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out))); self.end_headers(); self.wfile.write(out)
    def log_message(self, *a): pass
HTTPServer(("127.0.0.1", 5099), H).serve_forever()
