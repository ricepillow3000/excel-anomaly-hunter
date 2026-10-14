"""AnomalyHunter.exe starts here (see anomaly_hunter/app.py)."""
import multiprocessing
import sys

from anomaly_hunter.app import main

if __name__ == "__main__":
    multiprocessing.freeze_support()  # a frozen app that starts helper processes (joblib) must call this first
    sys.exit(main())
