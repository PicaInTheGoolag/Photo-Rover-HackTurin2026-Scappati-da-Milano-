import csv
import json
import math

from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock

from processing import process_power_matrix


class SolarCollector:

    def __init__(self):
        self.points = deque(maxlen=1500)
        self.power_matrix = []
        self.lock = Lock()

        self.csv_file = Path("/tmp/solar_data.csv")

    def receive(self, message):
        """
        Called by sketch.ino through Bridge.

        Expected JSON:
        {
            "x": 1.5,
            "y": 2.0,
            "voltage": [[...10x10...]],
            "current": [[...10x10...]]
        }
        """

        try:
            if isinstance(message, (str, bytes)):
                data = json.loads(message)
            else:
                data = message

            x = float(data["x"])
            y = float(data["y"])

            if not math.isfinite(x) or not math.isfinite(y):
                raise ValueError("Invalid coordinates")

            power_matrix, average_power = process_power_matrix(
            data["power"]
            )

            point = {
                "timestamp": datetime.now(
                    timezone.utc
                ).isoformat(),
                "x": x,
                "y": y,
                "power_mw": round(average_power, 3)
            }

            with self.lock:
                self.points.append(point)
                self.power_matrix = power_matrix

            self.save_csv(point, power_matrix)

            print(
                f"X={x:.2f}, Y={y:.2f}, "
                f"P={average_power:.2f} mW",
                flush=True
            )

        except (
            ValueError,
            TypeError,
            KeyError,
            json.JSONDecodeError
        ) as error:
            print("Invalid sensor data:", error, flush=True)

    def save_csv(self, point, power_matrix):
        """Save measurements for later analysis."""

        try:
            new_file = (
                not self.csv_file.exists()
                or self.csv_file.stat().st_size == 0
            )

            with open(self.csv_file, "a", newline="") as f:
                writer = csv.writer(f)

                if new_file:
                    writer.writerow([
                        "timestamp",
                        "x",
                        "y",
                        "average_power_mw",
                        "power"
                    ])

                writer.writerow([
                    point["timestamp"],
                    point["x"],
                    point["y"],
                    point["power_mw"],
                    json.dumps(power_matrix)
                ])

        except OSError as error:
            print("CSV save failed:", error, flush=True)

    def get_data(self):
        """Return data for the WebUI dashboard."""

        with self.lock:
            points = list(self.points)
            matrix = [
                row.copy()
                for row in self.power_matrix
            ]

        return {
            "points": points,
            "power_matrix": matrix,
            "latest": points[-1] if points else None,
            "count": len(points)
        }