"""Bridge receiver: validate each complete 7x5 scan and persist it to SQLite."""

import json
import math
import sqlite3
from datetime import datetime, timezone
from threading import Lock

from processing import process_power_matrix


class SolarCollector:
    def __init__(self, database):
        self.db = database
        self.lock = Lock()
        # Each application startup creates its own run, even after a restart.
        self.active_run_id = self.db.create_run()["id"]
        print(f"photoRover active run: {self.active_run_id}", flush=True)

    def receive(self, message):
        """Called by Bridge.notify('solar_data', JSON), once per 35-reading scan."""
        try:
            data = json.loads(message) if isinstance(message, (str, bytes)) else message
            x = float(data["x"])
            y = float(data["y"])
            if not math.isfinite(x) or not math.isfinite(y):
                raise ValueError("Invalid x or y")
            matrix, average_power = process_power_matrix(data["power"])
            point = {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "x": x,
                "y": y,
                "power_mw": round(average_power, 3)
            }
            with self.lock:
                run_id = self.active_run_id
                scan_id = self.db.add_scan(run_id, point, matrix)
            print(
                f"Run={run_id} Scan={scan_id} X={x:.2f} Y={y:.2f} "
                f"Average={average_power:.2f} mW", flush=True
            )
        except (ValueError, TypeError, KeyError, json.JSONDecodeError, sqlite3.Error) as error:
            print("Invalid sensor data or DB write failed:", error, flush=True)

    def get_data(self):
        with self.lock:
            run_id = self.active_run_id
        return self.db.run_data(run_id)

    def get_active_id(self):
        with self.lock:
            return self.active_run_id

    def start_new_run(self, name=None):
        # Prevent an incoming Arduino scan being split between two runs.
        with self.lock:
            run = self.db.create_run(name)
            self.active_run_id = run["id"]
        return run

    def remove_run(self, run_id):
        with self.lock:
            if not self.db.get_run(run_id):
                return False, None
            self.db.delete_run(run_id)
            replacement = None
            if self.active_run_id == run_id:
                replacement = self.db.create_run()
                self.active_run_id = replacement["id"]
        return True, replacement
