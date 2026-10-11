// ===============================================
// SOLARSCOUT - LIVE DATA + AUTO-FITTING SATELLITE
// ===============================================

// IMPORTANT: Replace with a NEW, restricted Google Maps Static API key.
// Do not add a prefix/suffix; paste the exact key from Google Cloud.
const GOOGLE_MAPS_KEY = window.SOLARSCOUT_GOOGLE_MAPS_KEY || "";

const API_URL = "/api/solar";
const REFRESH_INTERVAL_MS = 1000;

// Original photoRover palette: 0 mW red, 20 mW green.
// Uses the same powerColor() interpolation for the map and matrix.
const RED_POWER_MW = 0;
const GREEN_POWER_MW = 20;

// Maps Static API logical pixels. The API's scale=2 only improves
// image resolution; it does NOT change its geographic field of view.
const MAP_WIDTH = 600;
const MAP_HEIGHT = 400;
const ROUTE_FILL = 0.74;
const MIN_ZOOM = 0;
const MAX_ZOOM = 21;
const FIRST_POINT_ZOOM = 20;

// MANUAL_LOCATION: set to { lat, lon, source } if you know the rover start.
// null uses browser geolocation where permitted, then approximate IP location.
// Your rover coordinates are still relative X/Y (not GPS coordinates).
const MANUAL_LOCATION = null;

// Always define an offline fallback so location detection cannot crash startup.
// This is a demonstration location, NOT the real rover's position.
const FALLBACK_LOCATION = {
    lat: 45.4782,
    lon: 9.2273,
    source: "DEMO fallback (set the actual start location for accuracy)"
};

let mapOrigin = null;
let currentPoints = [];
let displayedMapFrame = null;
let requestedMapSignature = null;
let requestSequence = 0;
let updateInProgress = false;
let lastDataCount = -1;

// Historical runs / scan browser
let selectedRunId = null;
let activeRunId = null;
let selectedScanId = "latest";
let runs = [];
let loadedRun = null;
let lastScanListSignature = "";
let runsLoading = false;
let initializedLocation = null;
let mapOriginSignature = "";
let pollNumber = 0;
const scanMatrixCache = new Map();


function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function validPoint(point) {
    return point != null &&
        point.x != null && point.y != null && point.power_mw != null &&
        Number.isFinite(Number(point.x)) &&
        Number.isFinite(Number(point.y)) &&
        Number.isFinite(Number(point.power_mw));
}

function showMapMessage(message) {
    const element = document.getElementById("map-message");
    if (!element) return;
    element.textContent = message;
    element.hidden = !message;
}

function setLocationInfo(message) {
    const element = document.getElementById("location-info");
    if (element) element.textContent = message;
}

// ===============================================
// POWER COLOR: RED -> ORANGE -> YELLOW -> GREEN
// ===============================================

function powerColor(power) {
    const value = Number(power);
    if (!Number.isFinite(value)) return "#64748b";

    const t = clamp(
        (value - RED_POWER_MW) / (GREEN_POWER_MW - RED_POWER_MW),
        0, 1
    );
    const stops = [
        [220, 38, 38],
        [249, 115, 22],
        [234, 179, 8],
        [132, 204, 22],
        [22, 163, 74]
    ];
    const scaled = t * (stops.length - 1);
    const i = Math.min(Math.floor(scaled), stops.length - 2);
    const fraction = scaled - i;
    const rgb = stops[i].map((start, channel) => Math.round(
        start + fraction * (stops[i + 1][channel] - start)
    ));
    return `rgb(${rgb.join(",")})`;
}

// ===============================================
// GEOGRAPHY: EXACT GOOGLE WEB MERCATOR PROJECTION
// ===============================================

const DEG = Math.PI / 180;
const EARTH_RADIUS_METERS = 6378137;

function metersToLocation(x, y) {
    // Approximate local ENU position: X east, Y north, in meters.
    // This is NOT accurate if the Arduino X/Y axes aren't north-aligned.
    const lat = clamp(
        mapOrigin.lat + (Number(y) / EARTH_RADIUS_METERS) / DEG,
        -85.05112878, 85.05112878
    );
    const cosLat = Math.max(Math.cos(mapOrigin.lat * DEG), 0.01);
    const lon = mapOrigin.lon +
        (Number(x) / (EARTH_RADIUS_METERS * cosLat)) / DEG;
    return { lat, lon };
}

function projectWorld(lat, lon) {
    // Google Web Mercator coordinates at zoom 0 (256x256 world).
    const sinLat = Math.sin(clamp(lat, -85.05112878, 85.05112878) * DEG);
    return {
        x: (lon + 180) / 360 * 256,
        y: (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * 256
    };
}

function unprojectWorld(worldX, worldY) {
    const lon = worldX / 256 * 360 - 180;
    const n = Math.PI * (1 - 2 * worldY / 256);
    const lat = Math.atan(Math.sinh(n)) / DEG;
    return { lat, lon };
}

function makeMapFrame(points) {
    if (!mapOrigin) return null;

    const valid = points.filter(validPoint);
    const projected = valid.length
        ? valid.map(point => {
            const gps = metersToLocation(point.x, point.y);
            return projectWorld(gps.lat, gps.lon);
        })
        : [projectWorld(mapOrigin.lat, mapOrigin.lon)];

    const xs = projected.map(p => p.x);
    const ys = projected.map(p => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const centerWorldX = (minX + maxX) / 2;
    const centerWorldY = (minY + maxY) / 2;

    let zoom = FIRST_POINT_ZOOM;
    const worldWidth = maxX - minX;
    const worldHeight = maxY - minY;

    if (worldWidth > 0 || worldHeight > 0) {
        const zoomWidth = worldWidth > 0
            ? Math.log2((MAP_WIDTH * ROUTE_FILL) / worldWidth)
            : Infinity;
        const zoomHeight = worldHeight > 0
            ? Math.log2((MAP_HEIGHT * ROUTE_FILL) / worldHeight)
            : Infinity;
        zoom = Math.floor(Math.min(zoomWidth, zoomHeight));
    }
    zoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);

    return {
        zoom,
        centerWorldX,
        centerWorldY,
        center: unprojectWorld(centerWorldX, centerWorldY)
    };
}

function refreshSatellite(points) {
    if (!mapOrigin) return;

    if (!GOOGLE_MAPS_KEY ||
        GOOGLE_MAPS_KEY === "PASTE_YOUR_NEW_GOOGLE_MAPS_KEY_HERE") {
        showMapMessage("Satellite imagery needs a Google Maps Static API key. The trajectory still works.");
        setLocationInfo("Map origin: " + mapOrigin.source + " | Satellite key not configured");
        return;
    }

    const frame = makeMapFrame(points);
    if (!frame) return;

    const latitude = frame.center.lat.toFixed(8);
    const longitude = frame.center.lon.toFixed(8);
    const signature = `${latitude},${longitude}|${frame.zoom}`;
    if (signature === requestedMapSignature) return;
    requestedMapSignature = signature;

    const parameters = new URLSearchParams({
        center: `${latitude},${longitude}`,
        zoom: String(frame.zoom),
        size: `${MAP_WIDTH}x${MAP_HEIGHT}`,
        scale: "2",
        maptype: "satellite",
        key: GOOGLE_MAPS_KEY
    });
    const imageURL = "https://maps.googleapis.com/maps/api/staticmap?" + parameters.toString();

    const requestID = ++requestSequence;
    const preload = new Image();
    showMapMessage(displayedMapFrame ? "Updating satellite scale..." : "Loading satellite imagery...");
    setLocationInfo("Loading map: " + mapOrigin.source + " | Zoom " + frame.zoom);

    preload.onload = () => {
        if (requestID !== requestSequence) return;
        const imageElement = document.getElementById("google-background");
        if (!imageElement) return;

        // The decoded image is cached by the browser. Change the map
        // and its coordinate frame together, then redraw every point.
        imageElement.src = imageURL;
        imageElement.classList.add("is-loaded");
        displayedMapFrame = frame;
        showMapMessage("");
        setLocationInfo(
            `${mapOrigin.source} | Auto zoom ${frame.zoom} | ` +
            `${(156543.03392 * Math.cos(frame.center.lat * DEG) / (2 ** frame.zoom)).toFixed(3)} meters/pixel`
        );
        drawTrajectory(currentPoints);
        console.log("SolarScout satellite updated to zoom", frame.zoom);
    };

    preload.onerror = () => {
        if (requestID !== requestSequence) return;
        // Keep any previous satellite image and previous coordinate
        // frame on screen, so the overlay doesn't become misaligned.
        showMapMessage("Satellite image failed. Check the Static Maps API, billing, API-key restrictions, and Network > staticmap.");
        setLocationInfo("Satellite unavailable | " + mapOrigin.source);
        console.error("SolarScout: Google Static Maps image failed (see Network tab for HTTP status).");
    };

    preload.src = imageURL;
}

// ===============================================
// DRAW THE ENTIRE COLORED TRAJECTORY
// ===============================================

function drawTrajectory(points) {
    const canvas = document.getElementById("trajectory");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (!Array.isArray(points)) return;
    const valid = points.filter(validPoint);
    if (!valid.length) return;

    let xy;
    if (displayedMapFrame && mapOrigin) {
        // Exact Web Mercator pixel alignment with the Google image.
        const factor = 2 ** displayedMapFrame.zoom;
        xy = point => {
            const gps = metersToLocation(point.x, point.y);
            const world = projectWorld(gps.lat, gps.lon);
            return {
                x: W / 2 + (world.x - displayedMapFrame.centerWorldX) * factor * W / MAP_WIDTH,
                y: H / 2 + (world.y - displayedMapFrame.centerWorldY) * factor * H / MAP_HEIGHT
            };
        };
    } else {
        // Fallback route drawing if the image can't load.
        const xs = valid.map(p => Number(p.x));
        const ys = valid.map(p => Number(p.y));
        const centerX = (Math.min(...xs) + Math.max(...xs)) / 2;
        const centerY = (Math.min(...ys) + Math.max(...ys)) / 2;
        const scale = Math.min(
            (W * ROUTE_FILL) / Math.max(Math.max(...xs) - Math.min(...xs), 0.1),
            (H * ROUTE_FILL) / Math.max(Math.max(...ys) - Math.min(...ys), 0.1)
        );
        xy = point => ({
            x: W / 2 + (Number(point.x) - centerX) * scale,
            y: H / 2 - (Number(point.y) - centerY) * scale
        });
    }

    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = 10;

    for (let i = 1; i < valid.length; i++) {
        const previous = valid[i - 1];
        const current = valid[i];
        const a = xy(previous);
        const b = xy(current);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = powerColor((Number(previous.power_mw) + Number(current.power_mw)) / 2);
        ctx.stroke();
    }

    for (let i = 0; i < valid.length; i++) {
        const point = valid[i];
        const pos = xy(point);
        const isStart = i === 0;
        const isLatest = i === valid.length - 1;
        const color = isStart ? "#2563eb" : isLatest ? "#111827" : powerColor(point.power_mw);
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, (isStart || isLatest) ? 10 : 8, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = "white";
        ctx.lineWidth = 2.5;
        ctx.stroke();

        if (valid.length <= 50) {
            ctx.font = "bold 12px Arial";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = 3;
            ctx.strokeText(String(i + 1), pos.x, pos.y - 21);
            ctx.fillStyle = "#111827";
            ctx.fillText(String(i + 1), pos.x, pos.y - 21);
        }
    }
}

// ===============================================
// LATEST POWER MATRIX: 7 PAN COLUMNS x 5 TILT ROWS
// ===============================================

// Backend storage is matrix[panIndex][tiltIndex], with 7 x 5 values.
// We transpose ONLY how the values appear on screen:
// columns = pan angles; rows = tilt angles.
const PAN_ANGLES = [-90, -60, -30, 0, 30, 60, 90];
const TILT_ANGLES = [-60, -30, 0, 30, 60];

function drawHeatmap(matrix) {
    const canvas = document.getElementById("heatmap");
    if (!canvas) return;

    // Old HTML styles the canvas as a portrait 5:7 image. Correct its shape
    // here so the 7-column table fits WITHOUT editing index.html.
    const WIDTH = 840;
    const HEIGHT = 600;
    if (canvas.width !== WIDTH) canvas.width = WIDTH;
    if (canvas.height !== HEIGHT) canvas.height = HEIGHT;
    canvas.style.aspectRatio = "7 / 5";
    canvas.setAttribute(
        "aria-label",
        "Power matrix: pan angles across 7 columns, tilt angles down 5 rows; maximum power outlined"
    );

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, WIDTH, HEIGHT);

    // These margins are INSIDE the canvas, so the headings aren't clipped.
    const left = 108;
    const top = 120;
    const right = 20;
    const bottom = 24;
    const cellWidth = (WIDTH - left - right) / PAN_ANGLES.length;
    const cellHeight = (HEIGHT - top - bottom) / TILT_ANGLES.length;

    const hasMatrix = Array.isArray(matrix) &&
        matrix.length === PAN_ANGLES.length &&
        matrix.every(row =>
            Array.isArray(row) && row.length === TILT_ANGLES.length
        );

    // Draw every cell, preserving exactly the existing powerColor() palette.
    let bestPower = -Infinity;
    let bestPan = -1;
    let bestTilt = -1;

    for (let tilt = 0; tilt < TILT_ANGLES.length; tilt++) {
        for (let pan = 0; pan < PAN_ANGLES.length; pan++) {
            const x = left + pan * cellWidth;
            const y = top + tilt * cellHeight;
            const value = hasMatrix ? Number(matrix[pan][tilt]) : NaN;

            if (Number.isFinite(value)) {
                ctx.fillStyle = powerColor(value);
                if (value > bestPower) {
                    bestPower = value;
                    bestPan = pan;
                    bestTilt = tilt;
                }
            } else {
                // Neutral placeholder while the first 35 samples arrive.
                ctx.fillStyle = "#e2e8f0";
            }

            ctx.fillRect(x, y, cellWidth, cellHeight);
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = 1.5;
            ctx.strokeRect(x, y, cellWidth, cellHeight);
        }
    }

    // Highlight maximum power with an outline, NOT a different fill color.
    if (bestPan >= 0 && bestTilt >= 0) {
        const x = left + bestPan * cellWidth;
        const y = top + bestTilt * cellHeight;
        const inset = 5;

        ctx.save();
        ctx.strokeStyle = "#101827";
        ctx.lineWidth = 7;
        ctx.strokeRect(x + inset, y + inset,
                       cellWidth - 2 * inset, cellHeight - 2 * inset);
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 3;
        ctx.setLineDash([8, 5]);
        ctx.strokeRect(x + inset, y + inset,
                       cellWidth - 2 * inset, cellHeight - 2 * inset);
        ctx.setLineDash([]);

        ctx.font = "bold 20px Arial";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.lineWidth = 5;
        ctx.strokeStyle = "#101827";
        ctx.strokeText("MAX", x + cellWidth / 2, y + cellHeight / 2);
        ctx.restore();
    }

    // Use DARK text; the existing dashboard has light text on a dark body,
    // but this particular canvas has a very LIGHT background.
    ctx.fillStyle = "#1f2937";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "bold 26px Arial";
    ctx.fillText("PAN (°)", left + 3.5 * cellWidth, 30);

    ctx.font = "bold 22px Arial";
    for (let pan = 0; pan < PAN_ANGLES.length; pan++) {
        ctx.fillText(`${PAN_ANGLES[pan]}°`,
                     left + (pan + 0.5) * cellWidth, top - 28);
    }

    ctx.textAlign = "right";
    for (let tilt = 0; tilt < TILT_ANGLES.length; tilt++) {
        ctx.fillText(`${TILT_ANGLES[tilt]}°`,
                     left - 15, top + (tilt + 0.5) * cellHeight);
    }

    ctx.save();
    ctx.translate(25, top + 2.5 * cellHeight);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.font = "bold 22px Arial";
    ctx.fillText("TILT (°)", 0, 0);
    ctx.restore();
}

function updateStatistics(data, displayedPoint = null) {
    const points = Array.isArray(data.points) ? data.points : [];
    const chosen = displayedPoint || data.latest;
    document.getElementById("samples").textContent = String(data.count ?? points.length);
    document.getElementById("power").textContent = chosen
        ? Number(chosen.power_mw).toFixed(2) + " mW" : "-- mW";
    document.getElementById("position").textContent = chosen
        ? `(${Number(chosen.x).toFixed(2)}, ${Number(chosen.y).toFixed(2)})` : "--";
    const powers = points.map(p => Number(p.power_mw)).filter(Number.isFinite);
    document.getElementById("maxPower").textContent = powers.length
        ? Math.max(...powers).toFixed(2) + " mW" : "-- mW";
}

async function apiRequest(path, method = "GET", body) {
    const options = { method, cache: "no-store" };
    if (body !== undefined) {
        options.headers = { "Content-Type": "application/json" };
        options.body = JSON.stringify(body);
    }
    const response = await fetch(path, options);
    let data;
    try { data = await response.json(); }
    catch { throw new Error(`Server returned HTTP ${response.status} (not JSON)`); }
    if (!response.ok) {
        throw new Error(typeof data.detail === "string"
            ? data.detail : `HTTP ${response.status}`);
    }
    return data;
}

function surveyMessage(message) {
    const element = document.getElementById("survey-feedback");
    if (element) element.textContent = message;
}

function humanDate(iso) {
    return iso ? new Date(iso).toLocaleString() : "unknown";
}

function updateRunInfo(run) {
    const info = document.getElementById("run-details");
    if (!run || !info) return;
    const active = run.id === activeRunId;
    const coords = run.start_latitude === null || run.start_longitude === null
        ? "Not set (enter the rover starting GPS below)"
        : `${Number(run.start_latitude).toFixed(6)}°, ${Number(run.start_longitude).toFixed(6)}° (${run.location_source || "manual"})`;
    // textContent, not innerHTML, so user-chosen names cannot inject markup.
    info.textContent = `${active ? "LIVE" : "SAVED"} | Started: ${humanDate(run.started_at)} | ` +
        `Steps: ${run.scan_count ?? "--"} | Start GPS: ${coords}`;
}

function populateOriginInputs(run) {
    document.getElementById("origin-lat").value =
        run?.start_latitude == null ? "" : String(run.start_latitude);
    document.getElementById("origin-lon").value =
        run?.start_longitude == null ? "" : String(run.start_longitude);
}

function refreshRunSelector() {
    const select = document.getElementById("run-select");
    const before = select.value;
    select.replaceChildren();
    for (const run of runs) {
        const option = document.createElement("option");
        option.value = String(run.id);
        option.textContent = `${run.id === activeRunId ? "● LIVE | " : ""}${run.name} (${run.scan_count} steps)`;
        select.append(option);
    }
    if (selectedRunId !== null) select.value = String(selectedRunId);
    const selected = runs.find(r => r.id === selectedRunId);
    if (selected) updateRunInfo(selected);
    if (before !== select.value) lastScanListSignature = "";
}

async function loadRuns(preferRun = null) {
    if (runsLoading) return;
    runsLoading = true;
    try {
        const data = await apiRequest("/api/runs");
        runs = data.runs || [];
        activeRunId = data.active_run_id;
        const previousSelection = selectedRunId;
        if (preferRun !== null) selectedRunId = preferRun;
        if (!runs.some(r => r.id === selectedRunId)) {
            selectedRunId = activeRunId;
            selectedScanId = "latest";
            lastScanListSignature = "";
        }
        refreshRunSelector();
        if (previousSelection !== selectedRunId) {
            const selected = runs.find(r => r.id === selectedRunId);
            document.getElementById("run-name").value = selected?.name || "";
            populateOriginInputs(selected);
        }
        return data;
    } finally {
        runsLoading = false;
    }
}

function applyRunOrigin(run) {
    // Use the GPS saved for this run, never an unrelated cached origin.
    // If no saved coordinates exist, preserve the old demo map behavior,
    // but DO NOT write its location to the database.
    const origin = run?.start_latitude != null && run?.start_longitude != null
        ? { lat: run.start_latitude, lon: run.start_longitude,
            source: `Saved survey GPS (${run.location_source || "manual"})` }
        : initializedLocation;
    if (!origin) return;
    const signature = `${run?.id ?? ""}|${origin.lat}|${origin.lon}`;
    if (signature !== mapOriginSignature) {
        mapOriginSignature = signature;
        mapOrigin = origin;
        displayedMapFrame = null;
        requestedMapSignature = null;
        requestSequence += 1;
        lastDataCount = -1;
        document.getElementById("google-background")?.classList.remove("is-loaded");
    }
}

function updateScanSelector(data) {
    const select = document.getElementById("scan-select");
    const scans = data.scans || [];
    const last = scans.at(-1);
    const signature = `${data.run_id}|${scans.length}|${last?.id ?? ""}`;
    if (signature === lastScanListSignature) return;
    lastScanListSignature = signature;
    select.replaceChildren();
    const latest = document.createElement("option");
    latest.value = "latest";
    latest.textContent = "Latest step" + (data.run_id === activeRunId ? " (live)" : "");
    select.append(latest);
    scans.forEach((scan, index) => {
        const option = document.createElement("option");
        option.value = String(scan.id);
        option.textContent = `#${index + 1} | ${humanDate(scan.measured_at)} | X ${scan.x.toFixed(2)}, Y ${scan.y.toFixed(2)}`;
        select.append(option);
    });
    if (selectedScanId !== "latest" && !scans.some(s => s.id === selectedScanId)) {
        selectedScanId = "latest";
    }
    select.value = String(selectedScanId);
}

async function showSelectedScan(data) {
    const details = document.getElementById("scan-details");
    const selected = selectedScanId;
    if (selected === "latest") {
        drawHeatmap(data.power_matrix || []);
        updateStatistics(data);
        details.textContent = data.latest
            ? `Latest: ${humanDate(data.latest.timestamp)} | X ${data.latest.x.toFixed(2)}, Y ${data.latest.y.toFixed(2)}`
            : "No scans in this run yet.";
        return;
    }
    const scanMetadata = (data.scans || []).find(s => s.id === selected);
    if (!scanMetadata) {
        selectedScanId = "latest";
        return showSelectedScan(data);
    }
    // Keep the full trajectory while displaying a particular historic matrix.
    updateStatistics(data, {
        x: scanMetadata.x, y: scanMetadata.y,
        power_mw: scanMetadata.average_power_mw
    });
    details.textContent = `Step at ${humanDate(scanMetadata.measured_at)} | ` +
        `X ${scanMetadata.x.toFixed(2)}, Y ${scanMetadata.y.toFixed(2)} | ` +
        `Mean ${scanMetadata.average_power_mw.toFixed(2)} mW | ` +
        `Peak ${scanMetadata.max_power_mw.toFixed(2)} mW`;

    if (scanMatrixCache.has(selected)) {
        drawHeatmap(scanMatrixCache.get(selected));
        return;
    }
    const currentRunID = selectedRunId;
    drawHeatmap([]);
    const scan = await apiRequest(`/api/runs/${currentRunID}/scans/${selected}`);
    if (currentRunID === selectedRunId && selectedScanId === selected) {
        scanMatrixCache.set(selected, scan.power_matrix);
        drawHeatmap(scan.power_matrix);
    }
}

function showRun(data) {
    loadedRun = data;
    currentPoints = data.points;
    const run = data.run;
    updateRunInfo({ ...run, scan_count: data.count });
    applyRunOrigin(run);
    drawTrajectory(currentPoints);
    updateScanSelector(data);
    // Async so a slower historic scan request doesn't stall live polling.
    showSelectedScan(data).catch(error => surveyMessage(`Scan error: ${error.message}`));
    document.getElementById("status").textContent =
        data.run_id === activeRunId ? "Connected | Live run" : "Connected | Saved run";

    const count = data.count ?? currentPoints.length;
    const end = currentPoints.at(-1);
    const lastKey = `${data.run_id}|${count}|${end?.x ?? ""}|${end?.y ?? ""}`;
    if (lastKey !== lastDataCount) {
        lastDataCount = lastKey;
        refreshSatellite(currentPoints);
    }
}

async function updateDashboard() {
    if (updateInProgress) return;
    updateInProgress = true;
    try {
        if (selectedRunId === null) await loadRuns();
        if (selectedRunId === null) return;
        const runID = selectedRunId;
        const endpoint = runID === activeRunId
            ? API_URL : `/api/runs/${runID}`;
        const data = await apiRequest(endpoint);
        if (selectedRunId !== runID) return; // old in-flight request
        if (!Array.isArray(data.points)) {
            throw new Error("Unexpected survey API response");
        }
        showRun(data);
        pollNumber++;
        // Refresh names/active selection periodically to include other clients.
        if (pollNumber % 8 === 0) {
            loadRuns().catch(error => surveyMessage(error.message));
        }
    } catch (error) {
        console.error("photoRover backend:", error);
        document.getElementById("status").textContent = "Backend disconnected";
        surveyMessage(`Cannot load survey: ${error.message}`);
    } finally {
        updateInProgress = false;
    }
}

function initRunControls() {
    document.getElementById("run-select").addEventListener("change", event => {
        selectedRunId = Number(event.target.value);
        selectedScanId = "latest";
        lastScanListSignature = "";
        lastDataCount = -1;
        const run = runs.find(r => r.id === selectedRunId);
        document.getElementById("run-name").value = run?.name || "";
        populateOriginInputs(run);
        surveyMessage("");
        updateDashboard();
    });

    document.getElementById("scan-select").addEventListener("change", event => {
        selectedScanId = event.target.value === "latest"
            ? "latest" : Number(event.target.value);
        if (loadedRun && loadedRun.run_id === selectedRunId) {
            showSelectedScan(loadedRun).catch(error => surveyMessage(error.message));
        }
    });

    document.getElementById("run-new").addEventListener("click", async () => {
        const name = document.getElementById("run-name").value.trim();
        try {
            const result = await apiRequest("/api/runs", "POST", { name: name || null });
            selectedRunId = result.active_run_id;
            selectedScanId = "latest";
            lastScanListSignature = "";
            lastDataCount = -1;
            await loadRuns(selectedRunId);
            populateOriginInputs(result.run);
            document.getElementById("run-name").value = result.run.name;
            surveyMessage("New run started. Future Arduino scans will be saved here.");
            updateDashboard();
        } catch (error) { surveyMessage(`Create failed: ${error.message}`); }
    });

    document.getElementById("run-rename").addEventListener("click", async () => {
        if (selectedRunId === null) return;
        const name = document.getElementById("run-name").value.trim();
        try {
            await apiRequest(`/api/runs/${selectedRunId}`, "PATCH", { name });
            await loadRuns();
            surveyMessage("Run renamed.");
        } catch (error) { surveyMessage(`Rename failed: ${error.message}`); }
    });

    document.getElementById("run-delete").addEventListener("click", async () => {
        if (selectedRunId === null) return;
        const old = runs.find(r => r.id === selectedRunId);
        if (!window.confirm(`Permanently delete '${old?.name || "this run"}' and ALL of its scans? This cannot be undone.`)) return;
        try {
            await apiRequest(`/api/runs/${selectedRunId}`, "DELETE");
            selectedRunId = null;
            selectedScanId = "latest";
            lastScanListSignature = "";
            lastDataCount = -1;
            await loadRuns();
            const run = runs.find(r => r.id === selectedRunId);
            document.getElementById("run-name").value = run?.name || "";
            populateOriginInputs(run);
            surveyMessage("Run deleted. If it was live, a fresh live run was started.");
            updateDashboard();
        } catch (error) { surveyMessage(`Delete failed: ${error.message}`); }
    });

    document.getElementById("origin-save").addEventListener("click", async () => {
        if (selectedRunId === null) return;
        const latitude = document.getElementById("origin-lat").value;
        const longitude = document.getElementById("origin-lon").value;
        if (!latitude.trim() || !longitude.trim()) {
            surveyMessage("Enter both latitude and longitude before saving.");
            return;
        }
        try {
            await apiRequest(`/api/runs/${selectedRunId}/origin`, "PATCH", {
                latitude: Number(latitude), longitude: Number(longitude), source: "manual"
            });
            await loadRuns();
            surveyMessage("Starting GPS saved to this run.");
            updateDashboard();
        } catch (error) { surveyMessage(`GPS save failed: ${error.message}`); }
    });

    document.getElementById("origin-browser").addEventListener("click", () => {
        if (!navigator.geolocation || !window.isSecureContext) {
            surveyMessage("Browser GPS requires HTTPS or localhost. Enter GPS manually instead.");
            return;
        }
        navigator.geolocation.getCurrentPosition(
            pos => {
                document.getElementById("origin-lat").value = pos.coords.latitude;
                document.getElementById("origin-lon").value = pos.coords.longitude;
                surveyMessage("Browser GPS filled in. Check it matches the ROVER start, then click Save GPS.");
            },
            error => surveyMessage(`Browser GPS unavailable: ${error.message}`),
            { enableHighAccuracy: true, timeout: 10000 }
        );
    });
}

// ===============================================
// RESOLVE A STARTING LOCATION
// ===============================================

async function getMapLocation() {
    if (MANUAL_LOCATION !== null) return MANUAL_LOCATION;

    if (navigator.geolocation && window.isSecureContext) {
        try {
            const position = await new Promise((resolve, reject) =>
                navigator.geolocation.getCurrentPosition(resolve, reject, {
                    enableHighAccuracy: true,
                    timeout: 6000,
                    maximumAge: 60000
                })
            );
            return {
                lat: position.coords.latitude,
                lon: position.coords.longitude,
                source: "Browser location (not necessarily Arduino)"
            };
        } catch (error) {
            console.warn("Browser location failed:", error);
        }
    }
    try {
        const response = await fetch("https://ipapi.co/json/", { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const lat = Number(data.latitude);
        const lon = Number(data.longitude);
        if (Number.isFinite(lat) && Number.isFinite(lon) &&
            Math.abs(lat) <= 85 && Math.abs(lon) <= 180) {
            return { lat, lon, source: "Approximate IP location (not necessarily Arduino)" };
        }
    } catch (error) {
        console.warn("IP location failed, using demonstration fallback:", error);
    }
    return FALLBACK_LOCATION;
}

async function startSolarScout() {
    console.log("SolarScout WebUI started");
    initRunControls();
    // Begin live polling even if location lookup takes time.
    updateDashboard();
    setInterval(updateDashboard, REFRESH_INTERVAL_MS);

    try {
        initializedLocation = await getMapLocation();
    } catch (error) {
        console.warn("SolarScout: location lookup failed, using fallback:", error);
        initializedLocation = FALLBACK_LOCATION;
    }
    if (!mapOrigin) mapOrigin = initializedLocation;
    if (loadedRun) applyRunOrigin(loadedRun.run);
    const lat = Number(mapOrigin.lat);
    const lon = Number(mapOrigin.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
        Math.abs(lat) > 85 || Math.abs(lon) > 180) {
        showMapMessage("Invalid map origin coordinates. Set MANUAL_LOCATION correctly.");
        return;
    }
    lastDataCount = -1;
    refreshSatellite(currentPoints);
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startSolarScout);
} else {
    startSolarScout();
}