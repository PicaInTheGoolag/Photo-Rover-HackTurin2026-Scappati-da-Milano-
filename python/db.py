"""Persistent SQLite storage for photoRover surveys.

One run groups the readings acquired between an app startup (or a user-created
new run) and the next run. Each scan stores its position in the rover's relative
X/Y frame and the full 7x5 power matrix (pan-major) as JSON.

Set PHOTOROVER_DB_PATH to move the SQLite file to a known persistent mount.
By default it lives at ~/.photorover/photorover.sqlite3, outside App Lab's
project build/cache tree. Back it up before re-imaging the device.
"""

import json
import math
import os
import sqlite3
from contextlib import closing, contextmanager
from datetime import datetime, timezone
from pathlib import Path


DEFAULT_DB_PATH = Path.home() / ".photorover" / "photorover.sqlite3"


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class PhotoRoverDB:
    def __init__(self, path=None):
        target = path or os.environ.get("PHOTOROVER_DB_PATH") or DEFAULT_DB_PATH
        self.path = Path(target).expanduser().resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.initialize()

    def connect(self):
        connection = sqlite3.connect(str(self.path), timeout=10.0)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 10000")
        return connection

    @contextmanager
    def session(self):
        # sqlite3.Connection.__exit__ commits, but does NOT close the file.
        # Open one short-lived connection per request and close it explicitly.
        with closing(self.connect()) as connection:
            with connection:
                yield connection

    def initialize(self):
        with self.session() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.executescript("""
                CREATE TABLE IF NOT EXISTS runs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    started_at TEXT NOT NULL,
                    start_latitude REAL,
                    start_longitude REAL,
                    location_source TEXT
                );

                CREATE TABLE IF NOT EXISTS scans (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
                    measured_at TEXT NOT NULL,
                    x REAL NOT NULL,
                    y REAL NOT NULL,
                    average_power_mw REAL NOT NULL,
                    max_power_mw REAL NOT NULL,
                    power_matrix_json TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_scans_run_id
                    ON scans(run_id, id);
            """)

    @staticmethod
    def clean_name(name):
        if not isinstance(name, str) or not name.strip():
            raise ValueError("Run name must not be empty")
        name = name.strip()
        if len(name) > 100:
            raise ValueError("Run name must be 100 characters or fewer")
        return name

    @staticmethod
    def clean_origin(latitude, longitude):
        try:
            lat = float(latitude)
            lon = float(longitude)
        except (ValueError, TypeError) as error:
            raise ValueError("Latitude and longitude must be numbers") from error
        if not math.isfinite(lat) or not math.isfinite(lon):
            raise ValueError("Latitude and longitude must be finite")
        if not -85 <= lat <= 85 or not -180 <= lon <= 180:
            raise ValueError("Latitude must be within -85..85 and longitude within -180..180")
        return lat, lon

    def create_run(self, name=None):
        started = utc_now()
        with self.session() as connection:
            cursor = connection.execute(
                "INSERT INTO runs (name, started_at) VALUES (?, ?)",
                ((self.clean_name(name) if name is not None else f"Survey {started}"), started)
            )
            run_id = cursor.lastrowid
        return self.get_run(run_id)

    def get_run(self, run_id):
        with self.session() as connection:
            row = connection.execute(
                "SELECT * FROM runs WHERE id = ?", (int(run_id),)
            ).fetchone()
        return dict(row) if row else None

    def list_runs(self):
        with self.session() as connection:
            rows = connection.execute("""
                SELECT r.*, COUNT(s.id) AS scan_count,
                       MAX(s.measured_at) AS last_scan_at
                FROM runs AS r
                LEFT JOIN scans AS s ON s.run_id = r.id
                GROUP BY r.id
                ORDER BY r.id DESC
            """).fetchall()
        return [dict(row) for row in rows]

    def rename_run(self, run_id, name):
        name = self.clean_name(name)
        with self.session() as connection:
            cursor = connection.execute(
                "UPDATE runs SET name = ? WHERE id = ?", (name, int(run_id))
            )
            if cursor.rowcount == 0:
                return None
        return self.get_run(run_id)

    def set_origin(self, run_id, latitude, longitude, source="manual"):
        lat, lon = self.clean_origin(latitude, longitude)
        source = str(source).strip()[:100] or "manual"
        with self.session() as connection:
            cursor = connection.execute("""
                UPDATE runs
                SET start_latitude = ?, start_longitude = ?, location_source = ?
                WHERE id = ?
            """, (lat, lon, source, int(run_id)))
            if cursor.rowcount == 0:
                return None
        return self.get_run(run_id)

    def delete_run(self, run_id):
        with self.session() as connection:
            cursor = connection.execute(
                "DELETE FROM runs WHERE id = ?", (int(run_id),)
            )
        return cursor.rowcount > 0

    def add_scan(self, run_id, point, power_matrix):
        flat = [float(v) for row in power_matrix for v in row]
        if len(power_matrix) != 7 or any(len(row) != 5 for row in power_matrix):
            raise ValueError("Expected a 7x5 power matrix")
        if len(flat) != 35 or any(not math.isfinite(v) for v in flat):
            raise ValueError("Power matrix must contain 35 finite numbers")

        x = float(point["x"])
        y = float(point["y"])
        avg = float(point["power_mw"])
        if not all(math.isfinite(v) for v in (x, y, avg)):
            raise ValueError("Coordinates and power must be finite")

        with self.session() as connection:
            cursor = connection.execute("""
                INSERT INTO scans (
                    run_id, measured_at, x, y,
                    average_power_mw, max_power_mw, power_matrix_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (
                int(run_id), point["timestamp"], x, y,
                avg, max(flat), json.dumps(power_matrix, separators=(",", ":"))
            ))
        return cursor.lastrowid

    def run_data(self, run_id):
        run = self.get_run(run_id)
        if run is None:
            return None

        with self.session() as connection:
            rows = connection.execute("""
                SELECT id, run_id, measured_at, x, y,
                       average_power_mw, max_power_mw
                FROM scans
                WHERE run_id = ?
                ORDER BY id ASC
            """, (int(run_id),)).fetchall()
            last_row = connection.execute("""
                SELECT power_matrix_json FROM scans
                WHERE run_id = ? ORDER BY id DESC LIMIT 1
            """, (int(run_id),)).fetchone()

        scans = [dict(row) for row in rows]
        points = [{
            "id": item["id"],
            "timestamp": item["measured_at"],
            "x": item["x"],
            "y": item["y"],
            "power_mw": item["average_power_mw"],
            "max_power_mw": item["max_power_mw"]
        } for item in scans]
        return {
            "run": run,
            "run_id": run["id"],
            "points": points,
            "scans": scans,
            "power_matrix": json.loads(last_row["power_matrix_json"]) if last_row else [],
            "latest": points[-1] if points else None,
            "count": len(scans)
        }

    def get_scan(self, run_id, scan_id):
        with self.session() as connection:
            row = connection.execute("""
                SELECT * FROM scans WHERE run_id = ? AND id = ?
            """, (int(run_id), int(scan_id))).fetchone()
        if row is None:
            return None
        scan = dict(row)
        scan["timestamp"] = scan.pop("measured_at")
        scan["power_mw"] = scan.pop("average_power_mw")
        scan["power_matrix"] = json.loads(scan.pop("power_matrix_json"))
        return scan
