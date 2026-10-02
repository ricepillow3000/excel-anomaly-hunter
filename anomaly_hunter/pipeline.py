"""Shared scoring pipeline: run the four detectors + hygiene + combine on an
already-loaded DataFrame. Used by both the CLI (file in, report out) and the
server (records in, JSON out) so the detector-wiring isn't duplicated."""
from anomaly_hunter.combine import combine
from anomaly_hunter.detectors import clustering_detector, isolation_detector, limits_detector, sequence_detector
from anomaly_hunter.hygiene import blanks, duplicates, type_errors


def score(df, column_types, errors_log, limits, order_by):
    n = len(df)
    limits_result = limits_detector(df, column_types, limits)
    sequence_result = sequence_detector(df, column_types, order_by)
    isolation_result = isolation_detector(df, column_types)
    clustering_result = clustering_detector(df, column_types)

    hygiene_results = {
        "duplicates": duplicates(df),
        "type_errors": type_errors(n, errors_log),
        "blanks": blanks(df, column_types),
    }

    combined = combine(n, limits_result, sequence_result, isolation_result, clustering_result, hygiene_results)

    detector_status = {
        "limits": {"ran": True},
        "sequence": {"ran": sequence_result["ran"], "sit_out_reason": sequence_result["sit_out_reason"]},
        "isolation": {"ran": isolation_result["ran"], "sit_out_reason": isolation_result["sit_out_reason"]},
        "clustering": {"ran": clustering_result["ran"], "sit_out_reason": clustering_result["sit_out_reason"]},
    }
    return combined, detector_status
