"""Everything a person reads stays plain (AH-97). John listed the tells that make writing sound machine-made: dashes
between clauses, filler like "just" and "simply", stock words (moreover, delve, tapestry, pivotal...), chat leftovers
("Great question", "I hope this helps"), Title Case headings, emoji, placeholders and lines in capitals. This reads
what the website, the Excel pane, README.md and PRIVACY.md show: the visible text of every page (with alt, aria-label,
title and placeholder), the strings and template literals of their scripts, and the prose of the two Markdown files.
The engine's and the relay's error sentences are read too (AH-124): the pane shows them word for word, so "Engine error
- details in server.log" reached a user who has no idea where server.log is.
"""
import ast
import html
import re
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}
HEADS = {"h1", "h2", "h3", "h4", "summary", "button", "label", "dt", "th"}
SHOWN_ATTRS = ("alt", "aria-label", "title", "placeholder")

DASHES = re.compile(r"[–—]")
# a hyphen standing for a dash: a space on both sides, a word (or a quoted value, or a ${} slot) on both sides
SPACED = re.compile(r"""[\w"')\]?.!…] - [\w"'(\[]""")
SPACED_OK = ("Open File - Security Warning",)  # the title of the Windows dialog, as Windows writes it (README)
EMOJI = re.compile("[\U0001F000-\U0001FAFF☀-➿⬀-⯿️]")
LINKS = re.compile(r"chatgpt\.com|utm_source", re.I)
PLACEHOLDERS = re.compile(r"\[Your Name\]|\blorem\b|\bTODO\b", re.I)
PHRASES = (
    "moreover", "furthermore", "delve", "delves", "delving", "tapestry", "testament to", "pivotal", "seamless",
    "seamlessly", "game-changer", "cutting-edge", "in this digital world", "let's dive in", "great question",
    "absolutely right", "i hope this helps", "in conclusion", "it is important to note", "here's the thing",
    "let that sink in", "as an ai language model", "experts say", "serves as", "certainly, here",
    "would you like me to", "despite these changes", "a rich", "elevate", "unlock", "effortless", "revolutionary",
    "just", "simply",
)
BANNED = re.compile(r"(?<![\w-])(" + "|".join(re.escape(p) for p in PHRASES) + r")(?![\w-])", re.I)
# "just" is filler in everything the pane and the site say today; a real use ("a just cause") would be listed here
BANNED_OK = ()
CAPS_OK = ("SHARED FOLDER",)  # Excel's own label for the shared folder's path, written as Excel writes it
# proper nouns and UI names that keep their capitals inside a sentence-case heading
PROPER = {
    "Arcas", "Excel", "Windows", "Microsoft", "Power", "BI", "Google", "Gemini", "Cloudflare", "Anthropic",
    "GitHub", "Ask", "AI", "SHA-256", "PowerShell", "John", "OK", "Yes", "No", "Office", "Home", "Add-ins", "Find",
    "SmartScreen", "Defender", "Studio", "Mac", "Insert", "My", "Trust", "Center", "Options", "Run", "Properties",
    "Unblock", "Python", "API", "I", "Claude", "Worker", "Workers", "Edge", "WebView2", "Chrome", "Safari", "Firefox",
}


class Page(HTMLParser):
    """The text a reader sees, line by line, and the text of each heading-like element as written."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.texts, self.heads, self.stack, self.hidden = [], [], [], 0

    def handle_starttag(self, tag, attrs):
        line = self.getpos()[0]
        for name, value in attrs:
            if name in SHOWN_ATTRS and value:
                self.texts.append((line, value))
        if tag in ("script", "style"):
            self.hidden += 1
        if tag in VOID:
            return
        self.stack.append([tag, line, ""])

    def handle_startendtag(self, tag, attrs):
        line = self.getpos()[0]
        for name, value in attrs:
            if name in SHOWN_ATTRS and value:
                self.texts.append((line, value))

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self.hidden = max(0, self.hidden - 1)
        while self.stack:
            name, line, text = self.stack.pop()
            if name in HEADS:
                self.heads.append((line, name, " ".join(text.split())))
            if self.stack:
                self.stack[-1][2] += text
            if name == tag:
                break

    def handle_data(self, data):
        if self.hidden:
            return
        self.texts.append((self.getpos()[0], data))
        if self.stack:
            self.stack[-1][2] += data


def page_text(src):
    page = Page()
    page.feed(src)
    page.close()
    return page.texts, page.heads


REGEX_BEFORE = set("(,=:[!&|?{};+-*%<>~^") | {""}
REGEX_WORDS = {"return", "typeof", "case", "in", "of", "delete", "void", "throw", "new", "else", "do", "yield", "await"}


def js_strings(src):
    """Every string and template literal in a script, as (line, text, is_template). Comments, regex literals and
    import specifiers are skipped; a template's ${...} slots become "x" and the strings inside them are read too."""
    out, i, n = [], 0, len(src)
    last = ""  # the last significant token, to tell a regex from a division
    imports = False

    def line_at(k):
        return src.count("\n", 0, k) + 1

    def template(k):
        """Read a template literal from its opening backtick; return (text, end) and collect nested strings."""
        start, text, k = k, [], k + 1
        while k < n:
            c = src[k]
            if c == "\\":
                text.append(src[k:k + 2])
                k += 2
            elif c == "`":
                return "".join(text), k + 1
            elif src.startswith("${", k):
                depth, j = 1, k + 2
                while j < n and depth:
                    if src[j] in "'\"`":
                        j = skip_string(j)
                        continue
                    depth += {"{": 1, "}": -1}.get(src[j], 0)
                    j += 1
                text.append("x")
                k = j
            else:
                text.append(c)
                k += 1
        raise AssertionError(f"unclosed template at line {line_at(start)}")

    def skip_string(k):
        q = src[k]
        if q == "`":
            text, end = template(k)
            out.append((line_at(k), text, True))
            return end
        j = k + 1
        while j < n and src[j] != q:
            j += 2 if src[j] == "\\" else 1
        if not imports:
            out.append((line_at(k), src[k + 1:j], False))
        return j + 1

    while i < n:
        c = src[i]
        if src.startswith("//", i):
            i = src.find("\n", i)
            i = n if i < 0 else i
        elif src.startswith("/*", i):
            i = src.index("*/", i) + 2
        elif c in "'\"`":
            i = skip_string(i)
            last = "str"
            imports = False
        elif c == "/" and (last in REGEX_BEFORE or last in REGEX_WORDS):
            j, cls = i + 1, False
            while j < n and (src[j] != "/" or cls):
                if src[j] == "\\":
                    j += 1
                elif src[j] == "[":
                    cls = True
                elif src[j] == "]":
                    cls = False
                j += 1
            i = j + 1
            while i < n and src[i].isalpha():
                i += 1
            last = "regex"
        elif c.isspace():
            i += 1
        elif c.isalnum() or c in "_$":
            j = i
            while j < n and (src[j].isalnum() or src[j] in "_$"):
                j += 1
            last = src[i:j]
            imports = last in ("import", "from") or (imports and last not in (";",))
            i = j
        else:
            last = c
            if c in ";\n":
                imports = False
            i += 1
    return out


def md_prose(src):
    """README and PRIVACY prose: code blocks, inline code and link targets left out."""
    out, fenced = [], False
    for k, line in enumerate(src.splitlines(), 1):
        if line.lstrip().startswith("```"):
            fenced = not fenced
            continue
        if fenced:
            continue
        line = re.sub(r"`[^`]*`", "x", line)
        line = re.sub(r"\]\([^)]*\)", "]", line)
        line = re.sub(r"<[^>]+>", "", line)
        out.append((k, html.unescape(line)))
    return out


def sources():
    """(file, [(line, text)], [(line, tag, heading text)]) for everything a person reads."""
    for path in sorted([*ROOT.glob("site/*.html"), *ROOT.glob("frontend/*.html")]):
        texts, heads = page_text(path.read_text(encoding="utf-8"))
        yield path, texts, heads
    scripts = [*ROOT.glob("site/*.js"), *ROOT.glob("frontend/**/*.js")]
    for path in sorted(p for p in scripts if "node_modules" not in p.parts and p.name != "selfcheck.js"):
        texts, heads = [], []
        for line, text, _ in js_strings(path.read_text(encoding="utf-8")):
            if text.lstrip().startswith("#version"):
                continue  # a WebGL shader's source (field.js): code the GPU reads, never shown
            texts.append((line, html.unescape(text)))
            for m in re.finditer(r"<(h[1-4]|summary|button|label|dt|th)\b[^>]*>(.*?)</\1>", text, re.S):
                heads.append((line, m[1], " ".join(re.sub(r"<[^>]+>", "", m[2]).split())))
        yield path, texts, heads
    for name in ("README.md", "PRIVACY.md"):
        lines = md_prose((ROOT / name).read_text(encoding="utf-8"))
        heads = [(k, "h", re.sub(r"^#+\s*|\*\*", "", t).strip()) for k, t in lines if t.startswith("#")]
        yield ROOT / name, lines, heads


def capitals(text):
    """Runs of 3+ words in capitals, two of them longer than a letter ("SCAN COMPLETE: 0 PROBABLY WRONG, 4 WORTH A
    CHECK"). A name joined by _ or / is one word: GEMINI_API_KEY, VLOOKUP/XLOOKUP/MATCH, #N/A."""
    runs, run = [], []
    for word in [*re.findall(r"[A-Za-z][\w'&/-]*", text), "x"]:
        if word.isupper():
            run.append(word)
            continue
        if len(run) >= 3 and sum(len(w) > 1 for w in run) >= 2 and " ".join(run) not in CAPS_OK:
            runs.append(" ".join(run))
        run = []
    return runs


def title_case(text):
    words = re.findall(r"[A-Za-z][\w'&.-]*", re.sub(r"\(.*?\)|\".*?\"|“.*?”", "", text))
    capitalised = [w for w in words[1:] if w[0].isupper() and not w.isupper() and w.strip(".") not in PROPER]
    return len(capitalised) >= 2


def tells_in(flat):
    """[(kind, hits)] for one line of text a person reads."""
    checks = (
        ("dash", DASHES.findall(flat)),
        ("spaced hyphen", [m[0] for m in SPACED.finditer(flat) if not any(ok in flat for ok in SPACED_OK)]),
        ("emoji", EMOJI.findall(flat)),
        ("chatbot link", LINKS.findall(flat)),
        ("placeholder", PLACEHOLDERS.findall(flat)),
        ("stock phrase", [m[0] for m in BANNED.finditer(flat) if m[0].lower() not in BANNED_OK]),
        ("capitals", capitals(flat)),
    )
    return [(kind, hits) for kind, hits in checks if hits]


def tells():
    found = []
    for path, texts, heads in sources():
        where = path.relative_to(ROOT).as_posix()
        for line, text in texts:
            flat = " ".join(text.split())
            if not flat:
                continue
            for kind, hits in tells_in(flat):
                found.append((kind, f"{where}:{line}: {kind} {hits!r} in {flat[:160]!r}"))
        for line, tag, text in heads:
            if title_case(text):
                found.append(("title case", f"{where}:{line}: title case <{tag}> {text!r}"))
    return found


def test_the_js_reader_skips_comments_regexes_and_imports_and_reads_template_slots():
    src = (
        'import { a } from "./a.js";\n// "comment - here"\nconst r = /x - y/g, d = 4 / 2;\n'
        '/* "block - comment" */ const s = `left ${f("inner - text")} right`; const t = "plain";\n'
    )
    texts = [t for _, t, _ in js_strings(src)]
    assert texts == ["inner - text", "left x right", "plain"]


def test_the_tells_are_caught_where_they_are_written():
    texts, heads = page_text('<h2>Find The Errors Fast</h2><p title="Great question">One - two</p><script>"a - b"</script>')
    assert heads == [(1, "h2", "Find The Errors Fast")] and title_case(heads[0][2])
    flat = " ".join(t for _, t in texts)
    assert SPACED.search(flat) and BANNED.search(flat) and "a - b" not in flat
    assert not title_case("Find problems in Excel with Ask AI") and capitals("SCAN ENGINE ACTIVE now")
    assert capitals("SCAN COMPLETE: 0 PROBABLY WRONG, 4 WORTH A CHECK") and not capitals("#N/A / #DIV/0! cells, GEMINI_API_KEY or ANTHROPIC_API_KEY")


def test_nothing_a_person_reads_carries_the_tells_of_machine_writing():
    found = tells()
    assert found == [], f"{len(found)} tells:\n" + "\n".join(msg for _, msg in found)


def periods():
    """Every h1-h4 that ends with a period: a heading is a title, not a sentence (AH-117, John: "Find the error before
    it reaches the board." read as generated). A question mark stays: "How do I update?" asks something."""
    return [f"{path.relative_to(ROOT).as_posix()}:{line}: <{tag}> {text!r}" for path, _, heads in sources()
            for line, tag, text in heads if tag in ("h1", "h2", "h3", "h4") and text.rstrip().endswith(".")]


def test_a_heading_never_ends_with_a_period():
    _, heads = page_text("<h1>Find the error.</h1><h2>How do I update?</h2><h3>Install on your PC</h3><p>A sentence.</p>")
    assert [t for _, tag, t in heads if tag.startswith("h") and t.endswith(".")] == ["Find the error."]
    found = periods()
    assert found == [], f"{len(found)} headings end with a period:\n" + "\n".join(found)


# ---- What the engine and the relay say when something fails (AH-124) ----
# The pane shows these word for word (frontend/services/api.js), so they are held to the pane's rules, plus three of
# their own: no cold word a user can't act on, and a sentence that sends them to server.log says where it lives.
ENGINE = ("backend/anomaly_hunter/server.py", "backend/anomaly_hunter/ai/client.py")
RELAY = "relay/worker.js"
SAID = {"error", "message"}  # the JSON keys the pane shows
COLD = re.compile(r"\b(invalid|misconfigured|bad request|forbidden|not found|engine error|AI error|API error)\b", re.I)
LOG_AT = "%LOCALAPPDATA%\\AnomalyHunter\\server.log"


def _texts(node, names, funcs):
    """Every sentence an expression can give: an if/else gives each branch, a + each pairing, a {} slot is "x" (or the
    text of the constant it names), a name every text assigned to it, a call to a function of ours what it returns."""
    if isinstance(node, ast.Constant):
        return [node.value] if isinstance(node.value, str) else []
    if isinstance(node, ast.JoinedStr):
        parts = [[v.value] if isinstance(v, ast.Constant) else
                 (names.get(v.value.id) or ["x"]) if isinstance(v.value, ast.Name) else ["x"] for v in node.values]
        out = [""]
        for p in parts:
            out = [a + b for a in out for b in p]
        return out
    if isinstance(node, ast.IfExp):
        return _texts(node.body, names, funcs) + _texts(node.orelse, names, funcs)
    if isinstance(node, ast.BoolOp):
        return [t for v in node.values for t in _texts(v, names, funcs)]
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left, right = _texts(node.left, names, funcs), _texts(node.right, names, funcs)
        return [a + b for a in left or ["x"] for b in right or ["x"]] if left or right else []
    if isinstance(node, ast.Name):
        return names.get(node.id, [])
    if isinstance(node, ast.Call):
        name = node.func.attr if isinstance(node.func, ast.Attribute) else getattr(node.func, "id", None)
        return funcs.get(name, [])
    return []


def engine_sentences():
    """(file:line, sentence) for each error a user can read from the engine: the "error" and "message" values of its
    JSON answers, and the words of every ValueError ai/client.py raises (the /fix route answers with str(e)). Names are
    followed to what is assigned to them, and calls to what the function returns (server's _bad, client's check_key)."""
    trees = {f: ast.parse((ROOT / f).read_text(encoding="utf-8")) for f in ENGINE}
    names, funcs, defs = {}, {}, {}
    for tree in trees.values():
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                defs[node.name] = node
    for _ in range(3):  # a name may be assigned from another name: three rounds reach every chain in these files
        for name, fn in defs.items():
            funcs[name] = [t for r in ast.walk(fn) if isinstance(r, ast.Return) and r.value is not None
                           for v in (r.value.elts if isinstance(r.value, ast.Tuple) else [r.value])
                           for t in _texts(v, names, funcs)]
        for tree in trees.values():
            for node in ast.walk(tree):
                pairs = [(node.target, node.value)] if isinstance(node, ast.NamedExpr) else \
                    [(t, node.value) for t in node.targets] if isinstance(node, ast.Assign) else []
                for target, value in pairs:
                    for leaf in ast.walk(target):
                        if isinstance(leaf, ast.Name):
                            names[leaf.id] = sorted(set(names.get(leaf.id, [])) | set(_texts(value, names, funcs)))
    out = []
    for f, tree in trees.items():
        raised = {"ValueError"} | {c.name for c in ast.walk(tree) if isinstance(c, ast.ClassDef)
                                   and any(getattr(b, "id", "") == "ValueError" for b in c.bases)}
        for node in ast.walk(tree):
            if isinstance(node, ast.Dict):
                for k, v in zip(node.keys, node.values):
                    if isinstance(k, ast.Constant) and k.value in SAID:
                        out += [(f"{f}:{v.lineno}", t) for t in _texts(v, names, funcs)]
            elif f.endswith("client.py") and isinstance(node, ast.Raise) and isinstance(node.exc, ast.Call) \
                    and getattr(node.exc.func, "id", None) in raised and node.exc.args:
                out += [(f"{f}:{node.lineno}", t) for t in _texts(node.exc.args[0], names, funcs)]
    return out


def relay_sentences():
    """(file:line, sentence) for each error the relay answers with: the strings of every `error:` and `why:` value (the
    cap counter's why is passed on as the error)."""
    src = (ROOT / RELAY).read_text(encoding="utf-8")
    out = []
    for m in re.finditer(r"\b(?:error|why):\s*", src):
        depth, j = 0, m.end()
        while j < len(src) and not (depth == 0 and src[j] in ",}"):
            if src[j] in "'\"`":
                q, j = src[j], j + 1
                while src[j] != q:
                    j += 2 if src[j] == "\\" else 1
            depth += {"(": 1, "[": 1, "{": 1, ")": -1, "]": -1, "}": -1}.get(src[j], 0)
            j += 1
        line = src.count("\n", 0, m.start()) + 1
        out += [(f"{RELAY}:{line}", text) for _, text, _ in js_strings(src[m.end():j])]
    return out


def error_tells(sentences):
    found = []
    for where, text in sentences:
        flat = " ".join(text.split())
        hits = tells_in(flat)
        if COLD.search(flat):
            hits.append(("cold word", COLD.findall(flat)))
        if "server.log" in flat and LOG_AT not in flat:
            hits.append(("server.log without its folder", [flat]))
        found += [f"{where}: {kind} {h!r} in {flat[:160]!r}" for kind, h in hits]
    return found


def test_the_error_reader_finds_what_the_engine_and_the_relay_say():
    engine = [t for _, t in engine_sentences()]
    relay = [t for _, t in relay_sentences()]
    # a sentence from each way in: a 500, the AI's, a validation from _bad, a check_key result, a raise in client.py
    assert any("server.log" in t for t in engine), engine
    assert any("No AI key yet" in t for t in engine)
    assert any("must be a non-empty list" in t for t in engine)
    assert any(t.startswith("Key works") for t in engine)
    assert any("still working on your other request" in t for t in engine)
    assert any("too long to come back whole" in t for t in engine)  # TOO_LONG, raised by name
    assert len(relay) >= 10 and any("midnight US Pacific" in t for t in relay) and any("Google AI answered with error x" in t for t in relay)
    assert error_tells([("x", "Engine error - details in server.log")]) and error_tells([("x", "Bad request.")])
    assert not error_tells([("x", f"The details are in {LOG_AT}. Try again in a minute.")])


def test_every_error_the_engine_or_the_relay_can_show_a_user_is_plain_and_kind():
    found = error_tells(engine_sentences() + relay_sentences())
    assert found == [], f"{len(found)} unkind or unplain errors:\n" + "\n".join(found)


# ---- What the pane shows someone in crisis (AH-125) ----
def test_the_helpline_message_is_plain_and_kind():
    from anomaly_hunter.ai import care
    assert error_tells([("ai/care.py:MESSAGE", care.MESSAGE)]) == []
    assert "**" not in care.MESSAGE and "<" not in care.MESSAGE  # no bold label, and the pane sets it as text


# ---- No made-up praise (AH-125, John: "no fake testimonials, so we don't get sued") ----
# Arcas has no customers to quote and counts no users: a quote, a star rating or "10,000+ users" on a page would be
# invented. Read in the text a person sees on every page, README.md and PRIVACY.md included.
PRAISE = re.compile(r"testimonial|trusted by|customers love|★|\brated \d|\d[\d,]*\+? (users|customers|companies|downloads)\b", re.I)


def praise():
    pages = [*ROOT.glob("site/*.html"), *ROOT.glob("frontend/*.html"), ROOT / "README.md"]
    return [f"{p.relative_to(ROOT).as_posix()}:{k}: {m[0]!r}" for p in sorted(pages)
            for k, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1) for m in PRAISE.finditer(line)]


def test_the_praise_reader_catches_what_a_fake_testimonial_looks_like():
    for fake in ("Trusted by analysts", "★★★★★", "Rated 4.9 by users", "10,000+ users", "500 companies",
                 "What our customers love", "Testimonials"):
        assert PRAISE.search(fake), fake
    for honest in ("Users of Excel 2016", "Rated limits", "3 columns", "the user's sheet"):
        assert not PRAISE.search(honest), honest


def test_no_page_carries_a_testimonial_a_rating_or_a_user_count():
    found = praise()
    assert found == [], "made-up praise:\n" + "\n".join(found)
