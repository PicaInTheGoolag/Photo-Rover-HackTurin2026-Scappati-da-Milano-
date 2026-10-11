# photoRover: web dashboard (`assets/`)

The photoRover dashboard is a **plain HTML/CSS/JavaScript** interface served by Arduino App Lab's WebUI. The visible page title is still **SolarScout**. It shows live or saved solar surveys, colored rover trajectories, per-scan 7×5 power maps and controls for managing SQLite-backed survey runs.

There is no React/Vite/Node frontend build step in this folder. The page uses `fetch()` against the Python backend's **same-origin** API endpoints.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Entire dashboard markup/styles: survey selector, create/rename/delete buttons, origin controls, statistics, trajectory canvas, heatmap and legends. |
| `map.js` | REST polling, survey/scan switching, drawing canvases, Google Static Maps overlay and GPS/map-origin handling. |
| `maps-config.js` | **Optional local file; ignored by git and not bundled.** Sets `window.SOLARSCOUT_GOOGLE_MAPS_KEY`. |

The page loads `maps-config.js` **before** `map.js`. A missing optional configuration file may cause a browser 404 in the Network panel, but `map.js` can still show a non-satellite trajectory and measurements.

## Dashboard tour

### Survey Runs

- **Current or saved run:** choose the live run or any historical run in SQLite. The live run is marked `● LIVE`; each entry shows a name and number of steps.
- **Run name:** type a name, then click **Rename** to update the selected run. Names must be nonempty and 100 characters or fewer.
- **New run:** creates a new *active* run. Subsequent Arduino Bridge scans are recorded under this run. Older runs are retained.
- **Delete:** prompts for confirmation, then **permanently deletes** the selected run and all its scans. Deleting the active run automatically creates a new active run.
- **Starting GPS latitude/longitude:** enter the rover's starting coordinates and click **Save GPS**. You can also click **Use browser GPS**, but *verify the coordinates correspond to the rover*, then click **Save GPS**. Browser GPS may identify a laptop or phone far away from the MCU.
- The selected run shows its creation timestamp, number of steps and starting-GPS metadata. The browser formats stored UTC timestamps in the viewer's local timezone.

### Statistics and trajectory

Four cards show **Current Power**, **Maximum Power**, **Current Position**, and **Measurements** for the selected survey:

- **Current Power:** mean power of all 35 angular readings from the selected scan (or latest when `Latest step` is chosen).
- **Maximum Power:** largest *per-step mean power* across the entire selected run, not the maximum cell in one scan.
- **Current Position:** X/Y for the selected scan, as supplied by the MCU's relative dead reckoning.
- **Measurements:** number of stored completed scans in the selected run.

The **Solar Trajectory** canvas plots all the run's points, using the measured **mean** power to color route segments. Its first point is blue; its most recent point is dark. Markers are numbered when there are at most 50 visible points. Without satellite imagery, the canvas draws a relative-position route on the background grid.

### Power Matrix 7×5

**Reading / step** lets you choose **Latest step** or any saved step by number, timestamp and X/Y. Switching to an older scan shows that step's complete power matrix, while the trajectory still represents the **whole run**.

The heatmap presents:

| Axis | Displayed values | Physical servo values in `sketch.ino` |
| --- | --- | --- |
| **PAN**: 7 **columns** | `−90, −60, −30, 0, 30, 60, 90°` | `0, 30, 60, 90, 120, 150, 180°` |
| **TILT**: 5 **rows** | `−60, −30, 0, 30, 60°` | `30, 60, 90, 120, 150°` |

Each displayed angle is the **physical servo command minus 90°**. This shift is a display convention and does not change the stored matrix or physical servo commands. Stored values are indexed `matrix[pan][tilt]`; `drawHeatmap()` transposes **only their visual arrangement**.

- The heatmap uses the same **red → orange → yellow → green** interpolation as the route: **0 mW = red**; **20 mW and higher = green**. The configured endpoints are `RED_POWER_MW = 0` and `GREEN_POWER_MW = 20` in `map.js`.
- Its highest-power **single cell** is outlined in thick dark/white strokes and marked `MAX`; its **original fill color is preserved**.
- Before the first scan, cells have neutral placeholder backgrounds.
- The 840×600 canvas reserves margins inside its drawing area for readable dark PAN/TILT headers, avoiding clipped/white-on-white labels.

## Fetching data

The dashboard polls roughly every **1,000 ms** (`REFRESH_INTERVAL_MS` in `map.js`). Scans appear as soon as Python has saved them, which happens only after a *full* Arduino sweep. For the active run, it calls `/api/solar`; for an older selected run, it calls `/api/runs/{run_id}`. Run summaries are refreshed periodically (about every eight polls). An explicitly selected historical scan fetches its full matrix from `/api/runs/{run_id}/scans/{scan_id}` and caches it in the current browser tab.

| Endpoint | Dashboard use |
| --- | --- |
| `GET /api/solar` | Live run data, all trajectory points and latest matrix. |
| `GET /api/runs` | Survey selector and active run identity. |
| `POST /api/runs` | New live survey. |
| `GET /api/runs/{id}` | Saved run and its route. |
| `PATCH /api/runs/{id}` | Rename selected run. |
| `PATCH /api/runs/{id}/origin` | Save selected run's starting GPS. |
| `DELETE /api/runs/{id}` | Delete selected run and all steps. |
| `GET /api/runs/{id}/scans/{scan_id}` | Retrieve the chosen scan's full 7×5 matrix. |

Names and API feedback are displayed with `textContent` rather than inserted as HTML. Browser controls are *not authentication*: the server routes can currently be called by other clients on the same accessible network.

## Optional Google Maps satellite layer

### Enable it

Create `assets/maps-config.js` with your own restricted key:

```javascript
window.SOLARSCOUT_GOOGLE_MAPS_KEY = "YOUR_RESTRICTED_GOOGLE_MAPS_STATIC_API_KEY";
```

The code uses **Google Maps Static API** via an `<img>` element (`size=600x400`, `scale=2`, `maptype=satellite`). Google Cloud billing, the API itself and suitable key restrictions must be enabled. API keys embedded in browser code are visible to browser users: never use an unrestricted production key. `maps-config.js` is excluded by `.gitignore`.

### Location and alignment

For a survey with saved starting coordinates, `applyRunOrigin()` uses **that survey's latitude/longitude** to place the route. If a saved origin is missing, the script attempts to use a temporary display origin: browser geolocation in a secure context, then approximate `ipapi.co` location, then a demonstration fallback (`45.4782, 9.2273`). **These unsaved fallback coordinates are not genuine rover GPS and are never automatically persisted.**

The code assumes local **X = east** and **Y = north**, with X/Y expressed in meters, then projects them to Web Mercator. It automatically estimates a map center and zoom from the route extent, fetching a new satellite image when the frame changes. Because `sketch.ino` does not send compass heading, actual geographical alignment may be rotated and drifted. Browser GPS additionally may describe the computer rather than the rover. Treat the backdrop as illustrative unless the origin, heading and relative positions have been calibrated.

When a satellite request fails, the existing map/relative route remain visible, and a message describes possible API-key problems. Satellite imagery is **not required** for database management or heatmap rendering.

## Running and troubleshooting

1. Open photoRover in **Arduino App Lab** on the UNO Q and start the sketch and Python application.
2. Open the **WebUI URL shown by App Lab**, using the same host as the Python backend. A local `file://` copy of `index.html` will not reach relative `/api/...` endpoints.
3. Wait for a complete Arduino scan to appear in SQLite. Use **Survey Runs** and **Reading / step** to inspect older measurements.
4. After editing `map.js` or `index.html`, restart/reload the WebUI and hard-refresh (`Ctrl + Shift + R`) if the browser displays stale code.

**If the page says “Backend disconnected”:** open `/api/solar` and `/api/runs` on the WebUI origin and confirm Python `start_app()` ran and `PhotoRoverDB()` could access the database path. Check the browser developer console for JavaScript errors and Network requests.

**If the matrix is empty but the backend is connected:** scans are added only after **all 35 power samples** arrive in a valid 7×5 `power` array; check the Python/Arduino logs and the API's `count` / `power_matrix` fields. The included 10×10 `test_data.json` fixture is incompatible with the active collector.

**If satellite imagery is missing:** check that `maps-config.js` loads before `map.js`; verify Google Cloud billing, Maps Static API, key restrictions and the `staticmap` Network request. No key is needed for offline/relative route drawing.

**If map points do not match GPS:** remember the Arduino transmits estimated X/Y without GPS or heading. Creating a new dashboard run does **not** zero the MCU's X/Y counters, and saving an origin does not translate earlier X/Y samples.

See [project overview](../README.md), [Python database/API](../python/readme.md), and [Arduino firmware](../sketch/readme.md).
