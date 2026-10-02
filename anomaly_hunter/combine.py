"""Combine detector votes and hygiene findings into severity, bucket, reason per row."""


def combine(n, limits_result, sequence_result, isolation_result, clustering_result, hygiene_results):
    """hygiene_results: {"duplicates": (flags, reasons), "type_errors": (...), "blanks": (...)}."""
    detectors = [limits_result, sequence_result, isolation_result, clustering_result]
    ran_count = sum(1 for d in detectors if d.get("ran", True))

    vote_count = [0] * n
    magnitude = [0.0] * n
    detector_reasons = [[] for _ in range(n)]

    for d in detectors:
        if not d.get("ran", True):
            continue
        for i in range(n):
            if d["votes"][i]:
                vote_count[i] += 1
                magnitude[i] = max(magnitude[i], d["magnitude"][i])
                detector_reasons[i].extend(d["reasons"][i])

    weird_breach = limits_result["votes"]
    dup_flags, dup_reasons = hygiene_results["duplicates"]
    type_flags, type_reasons = hygiene_results["type_errors"]
    blank_flags, blank_reasons = hygiene_results["blanks"]

    results = []
    for i in range(n):
        hygiene_hit = dup_flags[i] or type_flags[i] or blank_flags[i]
        is_noted = limits_result["noted"][i] and vote_count[i] == 0 and not hygiene_hit

        if vote_count[i] == 0 and not hygiene_hit and not limits_result["noted"][i]:
            results.append({"severity": None, "bucket": None, "reason": "", "magnitude": 0.0})
            continue

        if is_noted:
            reason = "; ".join(limits_result["noted_reasons"][i])
            results.append({"severity": "Noted", "bucket": None, "reason": reason, "magnitude": 0.0})
            continue

        if vote_count[i] >= 3:
            severity = "High"
        elif vote_count[i] == 2:
            severity = "Medium"
        elif vote_count[i] == 1:
            severity = "Medium" if (weird_breach[i] or hygiene_hit) else "Low"
        else:  # vote_count == 0, reached here only because hygiene_hit is True
            severity = "Medium"

        if dup_flags[i]:
            bucket = "Duplicates"
        elif weird_breach[i] or type_flags[i] or blank_flags[i]:
            bucket = "Irregularities"
        else:
            bucket = "Behavioral"

        reasons = list(dup_reasons[i]) + list(type_reasons[i]) + list(blank_reasons[i]) + detector_reasons[i]
        reason_text = f"Flagged by {vote_count[i]} of {ran_count}: " + "; ".join(reasons)
        results.append({"severity": severity, "bucket": bucket, "reason": reason_text, "magnitude": magnitude[i]})

    return results
