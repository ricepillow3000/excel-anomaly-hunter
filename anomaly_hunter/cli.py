"""anomaly-hunter scan FILE... [--limits limits.csv] [--order-by COL] [--out report.xlsx]"""
import argparse
import sys
from pathlib import Path

from anomaly_hunter.limits import read_limits, suggest_limits
from anomaly_hunter.load import LoadError, load_inputs, numbers
from anomaly_hunter.pipeline import score
from anomaly_hunter.report import write_report


def run_scan(files, limits_path, order_by, out_path):
    """0 = report written. 2 = no limits file, suggestions written. 1 = error."""
    if any(Path(f).resolve() == Path(out_path).resolve() for f in files):
        print(f"--out ({out_path}) is one of the input files", file=sys.stderr)
        return 1
    try:
        df, types, errors, warnings = load_inputs(files)
    except LoadError as e:
        print(e, file=sys.stderr)
        return 1
    if not Path(limits_path).exists():
        suggest_limits(df, numbers(types), limits_path)
        print(f"No limits file found. Suggested limits written to {limits_path}. Review it and run again.")
        return 2
    limits, more = read_limits(limits_path, types)
    write_report(df, *score(df, types, errors, limits, order_by), out_path, limits_path, warnings + more)
    print(f"Report written to {out_path}")
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(prog="anomaly-hunter")
    s = p.add_subparsers(dest="command", required=True).add_parser("scan")
    s.add_argument("files", nargs="+")
    s.add_argument("--limits", default="limits.csv")
    s.add_argument("--order-by")
    s.add_argument("--out", default="report.xlsx")
    a = p.parse_args(argv)
    return run_scan(a.files, a.limits, a.order_by, a.out)


if __name__ == "__main__":
    sys.exit(main())
