"""AH-125 (John, 2026-11-04): what someone types to Ask AI may be a person in crisis, not a spreadsheet request. The
engine answers that itself with helpline numbers: a fixed message, decided here before any AI call, so the prompt, its
context and the model stay exactly as measured by bench/ai_eval.py, and the words never leave this PC.

Only the typed request is read, never the sheet: a column headed "Suicides" or a cell that quotes a song is data.
The phrases are first person ("myself", "my life", "I want to die"), because spreadsheet talk borrows the same verbs
("kill the duplicates", "dead rows", "die roll results", "suicide rate by state") and a care message over a real
request would be its own harm. Each one is a test in backend/tests/test_care.py, both ways."""
import re
import unicodedata

MESSAGE = ("It sounds like you may be going through something really hard. You don't have to face it alone. "
           "In the US you can call or text 988 to reach the Suicide and Crisis Lifeline, free and any time. "
           "Anywhere else, findahelpline.com lists free, private helplines in your country. "
           "If you are in danger right now, call your local emergency number. "
           "What you typed was not sent to the AI.")

# a self-harm column, rate or count is a sheet's subject, not the person typing
_DATA = r"(?!\s+(?:column|col|field|rows?|rates?|data|counts?|cases|figures|numbers|values|cells?|category|flag)\b)"
_PHRASES = [
    r"\bkill(?:ing)? myself\b",
    r"\bend(?:ing)? (?:my (?:own )?life|it all)\b",
    r"\btak(?:e|ing) my (?:own )?life\b",
    r"\b(?:want|wanna|wanted|going|plan|planning|ready|wish) (?:to )?die\b",
    r"\bwish i (?:was|were) dead\b",
    r"\bbetter off dead\b",
    r"\bbetter off without me\b",
    r"\bsuicidal\b",
    r"\b(?:commit(?:ting)?|attempt(?:ed|ing)?) suicide\b",
    r"\b(?:thinking|thought|thoughts) (?:about|of) suicide\b",
    r"\b(?:hurt|harm|cut)(?:ing|ting)? myself\b",
    r"\bself ?-?harm(?:ing)?\b" + _DATA,
    r"\b(?:don't|do not|dont) want to (?:live|be alive|be here anymore)\b",
    r"\bno reason to live\b",
    r"\bnothing to live for\b",
]
_CRISIS = re.compile("|".join(_PHRASES))
_APOSTROPHES = str.maketrans({c: "'" for c in "‘’ʼ′`´"})


def _plain(text, invisible=""):
    """NFKC (full-width letters), every invisible format character (Unicode Cf) made `invisible`, casefold, curly
    apostrophes made straight, every run of spaces or breaks one space."""
    text = "".join(invisible if unicodedata.category(c) == "Cf" else c for c in unicodedata.normalize("NFKC", text))
    return " ".join(text.casefold().translate(_APOSTROPHES).split())


def distress(text):
    """True when the typed request reads as someone thinking of suicide or self-harm."""
    # AH-150: a zero-width space, joiner or soft hyphen hid "kill<U+200B>myself" and "sui<U+00AD>cidal" from every phrase.
    # Read both ways: dropped inside a word, a space between two (a zero-width space is where a line may break)
    return isinstance(text, str) and any(_CRISIS.search(_plain(text, gap)) for gap in ("", " "))
