"""Command-line entry point: anomaly-hunter scan FILE [FILE ...] ..."""
import argparse
import sys
from pathlib import Path

from anomaly_hunter.detectors import K
from anomaly_hunter.limits import read_limits, suggest_limits
from anomaly_hunter.load import LoadError, load_inputs
from anomaly_hunter.pipeline import score
from anomaly_hunter.report import write_report


def build_parser():
    parser = argparse.ArgumentParser(prog="anomaly-hunter")
    sub = parser.add_subparsers(dest="command", required=True)
    scan = sub.add_parser("scan")
    scan.add_argument("files", nargs="+")
    scan.add_argument("--limits", default="limits.csv")
    scan.add_argument("--order-by", default=None)
    scan.add_argument("--out", default="report.xlsx")
    return parser


def run_scan(files, limits_path, order_by, out_path):
    for f in files:
        if Path(f).resolve() == Path(out_path).resolve():
            print(f"--out ({out_path}) is one of the input files", file=sys.stderr)
            return 1

    try:
        df, column_types, errors_log, load_warnings = load_inputs(files)
    except LoadError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    number_columns = [c for c, t in column_types.items() if t == "number"]

    if not Path(limits_path).exists():
        suggest_limits(df, number_columns, limits_path)
        print(f"No limits file found. Suggested limits written to {limits_path}. Review it and run again.")
        return 2

    limits, limits_warnings = read_limits(limits_path, number_columns)
    combined, detector_status = score(df, column_types, errors_log, limits, order_by)
    write_report(df, combined, out_path, detector_status, limits_path, K, load_warnings + limits_warnings)
    print(f"Report written to {out_path}")
    return 0


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command == "scan":
        return run_scan(args.files, args.limits, args.order_by, args.out)
    return 1


if __name__ == "__main__":
    sys.exit(main())
