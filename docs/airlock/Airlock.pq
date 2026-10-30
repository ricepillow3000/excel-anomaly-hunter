// Airlock: import any CSV with every cell kept exactly as typed, read each column's own pattern at run time,
// and write what looks wrong into an Audit column. The source columns come out unchanged, as text.
// Why: opening a CSV in Excel turns "02134" into 2134 and "03/04/2024" into a date in the PC's own order before
// any check can see them (chaos audit, 2026-10-30). Nothing here names a column or an industry: every rule is a
// share of the column's own values, so a 40-column sensor log is read the same way as an 8-column ledger.
// Paste into Data > Get Data > Blank Query > Advanced Editor. Change Path only.
let
    Path = "C:\Data\input.csv",
    K = 6,                  // a value is far when it is K robust spreads (1.4826 x MAD) from its column's median
    Share = 0.9,            // a column "is" numeric / fixed-width / a code when 90% of its filled cells are
    MaxRuleColumns = 15,    // A + B = C and A x B = C are looked for among the first 15 number columns, in sheet order
    RuleRows = 500,         // and found on the first 500 rows; every row is then checked against the rules found

    // 1. Lock: Csv.Document types nothing, and every column is then declared text, so no step can coerce a cell
    Raw = Csv.Document(File.Contents(Path), [Delimiter = ",", Encoding = 65001, QuoteStyle = QuoteStyle.Csv]),
    Promoted = Table.PromoteHeaders(Raw, [PromoteAllScalars = true]),
    Names = Table.ColumnNames(Promoted),
    Locked = Table.Buffer(Table.TransformColumnTypes(Promoted, List.Transform(Names, each {_, type text}))),
    Columns = List.Buffer(Table.ToColumns(Locked)),
    N = Table.RowCount(Locked),
    Positions = List.Positions(Names),

    // 2. Shapes of one cell, read from its characters only
    Digits = {"0".."9"},
    Blank = (t) => t = null or Text.Trim(t) = "",
    AllDigits = (t) => t <> null and Text.Length(t) > 0 and Text.Length(Text.Select(t, Digits)) = Text.Length(t),
    ToNum = (t) => if Blank(t) then null else try Number.FromText(Text.Trim(t), "en-US") otherwise null,
    IsIso = (t) => t <> null and Text.Length(t) = 10 and Text.Range(t, 4, 1) = "-" and Text.Range(t, 7, 1) = "-"
        and Text.Length(Text.Select(t, Digits)) = 8,
    SlashParts = (t) =>
        let p = if t = null then {} else Text.Split(Text.Trim(t), "/")
        in if List.Count(p) = 3 and List.AllTrue(List.Transform(p, AllDigits)) then List.Transform(p, Number.From) else null,
    ExcelErrors = {"#REF!", "#N/A", "#DIV/0!", "#VALUE!", "#NAME?", "#NUM!", "#NULL!"},

    // 3. Profile: what each column usually looks like, measured on its own filled cells
    Profile = (values as list) as record =>
        let
            Filled = List.Buffer(List.Select(values, each not Blank(_) and not List.Contains(ExcelErrors, Text.Trim(_)))),
            F = List.Count(Filled),
            ShareOf = (pred) => if F = 0 then 0 else List.Count(List.Select(Filled, pred)) / F,
            W = if F = 0 then 0 else List.Mode(List.Transform(Filled, Text.Length)),
            // a code: digits, and some written with a leading zero, so the zeros are part of the value
            IsCode = F > 0 and ShareOf(AllDigits) >= Share
                and List.AnyTrue(List.Transform(Filled, each Text.Length(_) > 1 and Text.StartsWith(_, "0"))),
            Nums = List.Buffer(List.RemoveNulls(List.Transform(Filled, ToNum))),
            IsNum = not IsCode and F > 0 and List.Count(Nums) / F >= Share,
            Med = if IsNum then List.Median(Nums) else null,
            Spread = if IsNum then List.Median(List.Transform(Nums, each Number.Abs(_ - Med))) else null,
            Slashes = List.RemoveNulls(List.Transform(Filled, SlashParts)),
            DF = List.Count(List.Select(Slashes, each _{0} > 12)),     // 31/12/2023 can only be day-first
            MF = List.Count(List.Select(Slashes, each _{1} > 12))    // 12/31/2023 can only be month-first
        in
            // (each field gets a different local name: in M, [Width = Width] would read the field itself, a cycle)
            [Filled = F, FillShare = if N = 0 then 0 else F / N, Width = W,
             FixedWidth = F > 0 and ShareOf(each Text.Length(_) = W) >= Share, Code = IsCode, Numeric = IsNum,
             Median = Med, Mad = Spread, IsoDates = F > 0 and ShareOf(IsIso) >= 0.5,
             SlashDates = F > 0 and List.Count(Slashes) / F >= 0.5, DayFirst = DF, MonthFirst = MF],
    Profiles = List.Buffer(List.Transform(Columns, Profile)),
    AsNum = List.Buffer(List.Transform(Positions, (j) =>
        if Profiles{j}[Numeric] then List.Buffer(List.Transform(Columns{j}, ToNum)) else null)),

    // 4. Row rules: C = A + B or C = A x B holding on 90% of the rows where no term is blank or 0
    NumIdx = List.FirstN(List.Select(Positions, each Profiles{_}[Numeric]), MaxRuleColumns),
    Candidates = List.Combine(List.Transform(NumIdx, (cc) => List.Combine(List.Transform(NumIdx, (aa) =>
        List.Combine(List.Transform(List.Select(NumIdx, (bb) => bb > aa and aa <> cc and bb <> cc), (bb) =>
            {[a = aa, b = bb, c = cc, op = "+"], [a = aa, b = bb, c = cc, op = "x"]})))))),
    Value = (r, x, y) => if r[op] = "+" then x + y else x * y,
    Close = (got, want) => Number.Abs(got - want) <= 0.005 + 1e-9 * Number.Abs(want),
    Check = (r, i) =>     // true = the row satisfies the rule, false = it breaks it, null = a term is missing
        let x = AsNum{r[a]}{i}, y = AsNum{r[b]}{i}, z = AsNum{r[c]}{i}
        in if x = null or y = null or z = null then null else Close(Value(r, x, y), z),
    Fit = (r) =>
        let
            Seen = List.RemoveNulls(List.Transform({0 .. List.Min({N, RuleRows}) - 1}, (i) =>
                let x = AsNum{r[a]}{i}, y = AsNum{r[b]}{i}
                in if x = null or y = null or x = 0 or y = 0 then null else Check(r, i))),
            Held = List.Count(List.Select(Seen, each _ = true))
        in List.Count(Seen) >= 10 and Held / List.Count(Seen) >= Share,
    Rules = List.Buffer(List.Select(Candidates, Fit)),
    Say = (r) => Names{r[c]} & " = " & Names{r[a]} & (if r[op] = "+" then " + " else " x ") & Names{r[b]},
    Num = (x) => Number.ToText(x, "G", "en-US"),

    // 5. Labels: the same word typed with other capitals or spaces ("finance" beside "Finance"); the commoner
    //    spelling is the column's own, a tie says nothing
    Norm = (t) => Text.Lower(Text.Combine(List.Select(Text.Split(Text.Trim(t), " "), each _ <> ""), " ")),
    Variants = (values as list) as record =>
        let
            f = List.Select(values, each not Blank(_) and not List.Contains(ExcelErrors, Text.Trim(_))),
            g = Table.Group(Table.FromColumns({f, List.Transform(f, Norm)}, {"t", "n"}), {"n", "t"},
                {{"k", Table.RowCount, Int64.Type}}),
            byN = Table.Group(g, {"n"}, {{"rows", each Table.Sort(_, {{"k", Order.Descending}}), type table}}),
            keep = Table.SelectRows(byN, each Table.RowCount([rows]) > 1 and [rows]{0}[k] > [rows]{1}[k])
        in Record.FromList(List.Transform(keep[rows], each [usual = _{0}[t], count = _{0}[k]]), keep[n]),
    Labels = List.Buffer(List.Transform(Positions, (j) =>
        let p = Profiles{j} in
        if p[Numeric] or p[Code] or p[IsoDates] or p[SlashDates] then [] else Variants(Columns{j}))),

    // 6. Rows typed twice: an exact copy of an earlier row (left alone when half the sheet repeats, as in a short survey)
    Sep = Character.FromNumber(31),
    Keys = List.Buffer(List.Transform({0 .. N - 1}, (i) =>
        Text.Combine(List.Transform(Columns, (col) => if col{i} = null then "" else col{i}), Sep))),
    Firsts = Table.Group(Table.FromColumns({Keys, {0 .. N - 1}}, {"key", "i"}), {"key"},
        {{"first", each List.Min([i]), Int64.Type}}),
    FirstOf = Record.FromList(Firsts[first], Firsts[key]),
    Repeats = N - Table.RowCount(Firsts),
    DuplicateOf = (i) => let f = Record.Field(FirstOf, Keys{i}) in
        if f < i and Repeats < 0.5 * N then {"Duplicate of row " & Num(f + 2) & " (an exact copy)"} else {},

    // 7. What one cell says, judged against its own column's profile
    CellIssues = (j, i) =>
        let
            p = Profiles{j}, t = Columns{j}{i}, name = Names{j}, typed = """" & (if t = null then "" else t) & """",
            s = if t = null then null else SlashParts(t),
            x = if AsNum{j} = null then null else AsNum{j}{i},
            Far = x <> null and p[Mad] <> null and p[Mad] > 0 and Number.Abs(x - p[Median]) / (1.4826 * p[Mad]) > K,
            Mine = List.Select(Rules, (r) => r[a] = j or r[b] = j or r[c] = j),
            Confirmed = List.Select(Mine, (r) => Check(r, i) = true),
            Usual = if t = null then null else Record.FieldOrDefault(Labels{j}, Norm(t), null)
        in
            if Blank(t) then
                (if p[FillShare] >= 0.95 then {"Blank in " & name & ", a column that is otherwise filled"} else {})
            else if List.Contains(ExcelErrors, Text.Trim(t)) then {"Excel error " & Text.Trim(t) & " in " & name}
            else List.RemoveNulls({
                if Usual <> null and t <> Usual[usual] then name & " " & typed & " is written """ & Usual[usual]
                    & """ " & Num(Usual[count]) & " times (same word, different capitals or spaces)" else null,
                if p[Code] and p[FixedWidth] and AllDigits(t) and Text.Length(t) < p[Width]
                    then name & " " & typed & " is " & Num(Text.Length(t)) & " characters where the column writes "
                        & Num(p[Width]) & ": lost its leading zeros?" else null,
                if p[Numeric] and x = null then "Text " & typed & " in number column " & name else null,
                if p[IsoDates] and not IsIso(t) then
                    (if AllDigits(t) then name & " " & typed & " is a number in a column of YYYY-MM-DD dates (an Excel date serial?)"
                     else if s <> null and s{0} <= 12 and s{1} <= 12 then name & " " & typed
                        & " is not YYYY-MM-DD, and its day and month could be either way round"
                     else name & " " & typed & " is not written YYYY-MM-DD like the rest of the column") else null,
                if p[SlashDates] and s = null and not IsIso(t) then name & " " & typed & " is not written like the column's other dates" else null,
                if p[SlashDates] and s <> null and p[DayFirst] > 0 and p[MonthFirst] > 0 and (s{0} > 12 or s{1} > 12)
                    and ((s{0} > 12 and p[DayFirst] < p[MonthFirst]) or (s{1} > 12 and p[MonthFirst] < p[DayFirst]))
                    then name & " " & typed & " is written " & (if s{0} > 12 then "day-first" else "month-first")
                        & " where the column mostly writes the other order" else null,
                if p[SlashDates] and s <> null and p[DayFirst] > 0 and p[MonthFirst] > 0 and s{0} <= 12 and s{1} <= 12
                    then name & " " & typed & " could be read either way: the column mixes day-first and month-first dates" else null,
                if Far then
                    (if List.Count(Confirmed) > 0
                     then "Worth a check: " & name & " " & typed & " is far from the column's usual " & Num(p[Median])
                        & ", but the row's own arithmetic (" & Say(Confirmed{0}) & ") confirms it"
                     else name & " " & typed & " is far outside the column's usual range (median " & Num(p[Median]) & ")")
                    else null}),

    RuleIssues = (i) => List.RemoveNulls(List.Transform(Rules, (r) =>
        if Check(r, i) = false then Names{r[c]} & " " & Num(AsNum{r[c]}{i}) & " does not match " & Say(r)
            & " (" & Num(Value(r, AsNum{r[a]}{i}, AsNum{r[b]}{i})) & ")" else null)),

    // 8. Audit: one sentence per issue, beside the untouched source; "Check" = worth a look, "Error" = something broke
    Audit = List.Buffer(List.Transform({0 .. N - 1}, (i) =>
        List.Combine(List.Transform(Positions, (j) => CellIssues(j, i))) & RuleIssues(i) & DuplicateOf(i))),
    Level = List.Transform(Audit, (said) =>
        if List.IsEmpty(said) then null
        else if List.AllTrue(List.Transform(said, each Text.StartsWith(_, "Worth a check"))) then "Check" else "Error"),
    Result = Table.FromColumns(Columns & {List.Transform(Audit, each if List.IsEmpty(_) then null else Text.Combine(_, "; ")), Level},
        Names & {"Airlock Audit", "Airlock Level"}),
    Typed = Table.TransformColumnTypes(Result, List.Transform(Table.ColumnNames(Result), each {_, type text}))
in
    Typed
