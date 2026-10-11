# photoRover · Python backend

This folder hosts the Python side of **photoRover** on Arduino UNO Q, using **Arduino App Lab**, `arduino.app_utils.Bridge`, and the `arduino:web_ui` brick. It collects power matrices emitted by the Arduino sketch, validates and summarizes the measurements, and exposes the latest state to the browser dashboard.

> **Current configuration:** `TEST_MODE = False` in `app.py`, so the intended data source is the real Arduino sketch, not the legacy simulated fixture.

## Data path

```mermaid
sequenceDiagram
    participant MCU as sketch/sketch.ino
    participant Bridge as RouterBridge
    participant App as app.py
    participant Collector as collector.py
    participant Browser as assets/map.js
    MCU->>Bridge: notify("solar_data", JSON)
    Bridge->>Collector: receive(message)
    Collector->>Collector: validate 7x5, average 35 powers
    Collector->>Collector: append route point; update latest matrix; append CSV
    Browser->>App: GET /api/solar (every 1 s)
    App->>Collector: get_data()
    Collector-->>Browser: points, power_matrix, latest, count
```

## Modules

| File | Responsibility |
| --- | --- |
| `main.py` | Calls `start_app()` and serves as the Python entry point |
| `app.py` | Instantiates `SolarCollector`, registers Bridge callback and WebUI endpoint, starts `App.run()` |
| `collector.py` | Receives JSON/dicts, validates coordinates and power, stores up to 1,500 points, retains latest 7×5 matrix, appends CSV |
| `processing.py` | `process_power_matrix()` validates exactly **7 rows × 5 columns**, converts values to finite floats, and computes their arithmetic mean |
| `requirements.txt` | Declares additional Python packages (including NumPy, pandas, Plotly, Streamlit, Folium); the current four active Python modules do not import these packages directly |
| `generate_test_data.py`, `test_data.json` | **Legacy** 10×10 voltage/current simulation, incompatible with the active 7×5 power-only receiver without adaptation |
| `solar_data.csv` | A historical CSV snapshot included in the repository, **not** the live collector output file |

## Incoming message from Arduino

The firmware calls:

```cpp
Bridge.notify("solar_data", json);
```

`collector.receive()` accepts either a JSON string/bytes or an already-decoded mapping with this shape:

```json
{
  "x": 1.25,
  "y": -0.40,
  "power": [
    [2, 4, 6, 8, 10],
    [3, 5, 7, 9, 11],
    [4, 6, 8, 10, 12],
    [5, 7, 9, 11, 13],
    [6, 8, 10, 12, 14],
    [7, 9, 11, 13, 15],
    [8, 10, 12, 14, 16]
  ]
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `x` | Finite number | Relative rover X coordinate, estimated by the sketch |
| `y` | Finite number | Relative rover Y coordinate, estimated by the sketch |
| `power` | 7×5 array of finite numbers | Measured electrical power in **milliwatts**; `[pan_index][tilt_index]` |

**Naming matters:** the incoming key is **`power`**, not `power_matrix`. Inside `collector.py`:

```python
power_matrix, average_power = process_power_matrix(data["power"])
```

`processing.py` performs these validations:

- Outer value must be a list of **7** rows.
- Every row must be a list of **5** elements.
- Every entry must convert to a finite float (rejects `NaN` and infinity).
- The mean of all **35** powers becomes the route-point `power_mw`.

In mathematical terms:

\[
P_{\mathrm{mean}} = \frac{1}{35}\sum_{i=0}^{6}\sum_{j=0}^{4}P_{ij}
\]

No voltage/current multiplication happens in Python. That calculation has already been performed by the Arduino's INA219 reading routine.

## Live API: `GET /api/solar`

Registered in `app.py` as:

```python
web_ui.expose_api("GET", "/api/solar", collector.get_data)
```

Response shape:

```json
{
  "points": [
    {"timestamp": "2026-10-11T08:00:00+00:00", "x": 1.25, "y": -0.4, "power_mw": 9.0}
  ],
  "power_matrix": [
    [2, 4, 6, 8, 10],
    [3, 5, 7, 9, 11],
    [4, 6, 8, 10, 12],
    [5, 7, 9, 11, 13],
    [6, 8, 10, 12, 14],
    [7, 9, 11, 13, 15],
    [8, 10, 12, 14, 16]
  ],
  "latest": {"timestamp": "2026-10-11T08:00:00+00:00", "x": 1.25, "y": -0.4, "power_mw": 9.0},
  "count": 1
}
```

The example values are illustrative. In the running code, each accepted point receives a UTC timestamp via `datetime.now(timezone.utc).isoformat()`, and `power_mw` is rounded to three decimal places.

- `points`: history in arrival order, up to 1,500 entries (a bounded `deque`).
- `power_matrix`: most recently accepted 7×5 scan only.
- `latest`: last point or `null` when no data exists.
- `count`: number of points currently retained in memory, **not a lifetime total**.

### Consuming the endpoint

Run photoRover through Arduino App Lab, then open its printed WebUI URL. For a local request **on the device running the WebUI server**, for example:

```bash
curl http://127.0.0.1:7000/api/solar
```

For a PC browser, use the **actual App Lab WebUI address**, not `localhost` unless the UI is explicitly forwarded to your PC. The dashboard requests the relative URL `/api/solar`, so it uses the same origin as the page.

## Storage

For each accepted message, `collector.py`:

1. Appends `{timestamp, x, y, power_mw}` to `self.points` (`deque(maxlen=1500)`).
2. Replaces `self.power_matrix` with the most recent 7×5 array.
3. Appends a CSV row to **`/tmp/solar_data.csv`**, with the complete matrix serialized as JSON in the final column.

The current runtime CSV header is:

```csv
timestamp,x,y,average_power_mw,power
```

The file is in temporary container storage, may not survive container recreation, and is **not read back into memory on restart**. If permanent storage is required, configure a persistent volume or deliberately export the file.

The repository includes a historical `python/solar_data.csv` with an older `power_matrix` header and 10×10 readings; it should not be confused with the current runtime schema.

## Running and configuring

The supported project workflow is through **Arduino App Lab** rather than running these files as a stand-alone desktop server, because they import the App Lab runtime modules.

1. Open the project in Arduino App Lab and start the application.
2. Ensure the UNO Q sketch has been uploaded and the Arduino Bridge is initialized (`Bridge.begin()`).
3. Confirm `TEST_MODE = False` in `app.py`.
4. Wait for the sketch to finish a full 35-orientation scan.
5. Look for `X=..., Y=..., P=... mW` in the Python application logs and a nonzero `count` from `/api/solar`.
6. Open the dashboard, which polls the API every 1,000 ms. Scans appear as they complete; polling does not accelerate hardware sampling.

### Known source-code issues in this snapshot

- `app.py` currently calls `Bridge.provide("solar_data", collector.receive)` **twice** when `TEST_MODE` is false. It only needs one registration.
- The test generator produces **10×10 voltage/current** matrices, while `collector.receive()` expects **7×5 `power`**. Switching `TEST_MODE` to `True` without updating the fixture will log invalid sensor data.
- The `collector.receive()` docstring still describes the old 10×10 voltage/current JSON; the actual accepted field is `power`.
- Invalid coordinates, missing keys, or malformed matrices are caught and logged as `Invalid sensor data: ...`; such messages are not added to the route or CSV.
- Collected points are held in process memory, so a Python restart resets the displayed route, even if the previous CSV is still present.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `Invalid sensor data: 'power'` | MCU JSON must include the literal key `"power"` with a 7×5 array |
| `Power matrix must have 7 rows` | Count outer arrays; the firmware must send seven pan rows |
| `Each row must contain 5 values` | Every pan row must have five tilt entries |
| API returns `count: 0` | Check successful Bridge delivery, completed scan, `TEST_MODE` and Python logs |
| API returns data but no line | The route requires at least two points with different X/Y coordinates; duplicated coordinates overlap |
| New scan doesn't appear immediately | Each complete servo sweep takes longer than the browser's one-second polling interval |
| Previously recorded points disappear | Python was restarted; there is no automatic CSV replay |
| Satellite image missing but API works | See `assets/map.js`, `assets/maps-config.js`, and Google Maps Static API billing/restrictions; imagery is independent of backend collection |

## Related documentation

- [Project overview](../README.md)
- [Arduino sketch and hardware](../sketch/README.md)
