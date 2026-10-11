import json
import math
import random
from pathlib import Path

random.seed(42)

measurements = []

for k in range(40):

    # Simulated curved trajectory
    x = k * 0.5
    y = 4 * math.sin(k * 0.18)

    # Changes in sunlight along the path
    sunlight = (
        0.5 + 0.45 * math.sin(k * 0.25)
    )
    sunlight = max(0.05, min(1.0, sunlight))

    voltage = []
    current = []

    for i in range(10):
        voltage_row = []
        current_row = []

        for j in range(10):

            v = 4.5 + 0.7 * sunlight
            v += random.uniform(-0.08, 0.08)

            c = 90 * sunlight
            c += random.uniform(-3, 3)
            c = max(0, c)

            voltage_row.append(round(v, 3))
            current_row.append(round(c, 3))

        voltage.append(voltage_row)
        current.append(current_row)

    measurements.append({
        "x": round(x, 3),
        "y": round(y, 3),
        "voltage": voltage,
        "current": current
    })

path = Path(__file__).with_name("test_data.json")

with open(path, "w") as f:
    json.dump(
        {"measurements": measurements},
        f,
        indent=2
    )

print(f"Generated {len(measurements)} positions")
print("100 voltage + 100 current readings per position")
print(f"Saved to {path}")