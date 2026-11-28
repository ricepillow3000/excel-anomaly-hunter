"""Stand-in for John's relay on :5099 (AH-151: the free AI with no key): every AI call is its POST /fix, answered in
Google's OpenAI-style shape. Records each request; answers a fixed fix for the flagged cell it finds."""
import json, re, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
LOG = sys.argv[1]
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        prompt = body["messages"][0]["content"]
        with open(LOG, "a") as f:
            f.write(json.dumps({"path": self.path, "prompt": prompt, "auth": "Authorization" in self.headers}) + "\n")
        if "distinct values of some text columns" in prompt:  # /odd-text: a hostile answer the engine and pane must tame
            values = json.loads(prompt.splitlines()[1])
            col = next(iter(values))
            ans = {"odd": [{"column": col, "value": values[col][0], "why": "<img src=x onerror=window.__pwned=1> a city"},
                           {"column": col, "value": "Atlantis", "why": "not in the sheet at all"}]}
            return self.reply(ans)
        if "column headers of a spreadsheet" in prompt:  # /rules (AH-202): a rule of the sheet's last three headers with
            names = [h for h, _ in json.loads(prompt.splitlines()[1])]  # markup in "why", and one of a header never sent
            rule = dict.fromkeys(("target", "first", "then", "value", "when", "after", "id", "parent")) | {"plus": [], "minus": [], "factors": []}
            if "Paid" in names:  # AH-217's ledger: two rules no check of the scan's own finds (an order, a product of three)
                return self.reply({"rules": [{**rule, "kind": "order", "why": "never paid more than billed", "first": "Paid", "then": "Amount"},
                                                   {**rule, "kind": "product", "why": "quantity times price times rate", "target": "Amount",
                                                    "factors": ["Qty", "Price", "FX rate"]}]})
            ans = {"rules": [{**rule, "kind": "product", "why": "<img src=x onerror=window.__pwned=2> qty times price",
                              "target": names[-1], "factors": names[-3:-1]},
                             {**rule, "kind": "order", "why": "not in the sheet", "first": "Ship date", "then": names[0]}]}
            return self.reply(ans)
        flagged =re.search(r"Flagged row (\d+):", prompt).group(1)
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
        self.reply(ans)
    def reply(self, ans):
        out = json.dumps({"choices": [{"message": {"content": json.dumps(ans)}}]}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out))); self.end_headers(); self.wfile.write(out)
    def log_message(self, *a): pass
HTTPServer(("127.0.0.1", 5099), H).serve_forever()
