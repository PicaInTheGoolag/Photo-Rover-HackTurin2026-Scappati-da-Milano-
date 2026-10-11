
/* ===============================================
   SOLARSCOUT - LIVE DATA + AUTO-FITTING SATELLITE
   =============================================== */

// Google Maps Static API key supplied by maps-config.js
const GOOGLE_MAPS_KEY =
    window.SOLARSCOUT_GOOGLE_MAPS_KEY || "";

const API_URL = "/api/solar";
const REFRESH_INTERVAL_MS = 1000;

// Original photoRover power colors
const RED_POWER_MW = 0;
const GREEN_POWER_MW = 20;

// Satellite map configuration
const MAP_WIDTH = 600;
const MAP_HEIGHT = 400;
const ROUTE_FILL = 0.74;
const MIN_ZOOM = 0;
const MAX_ZOOM = 21;
const FIRST_POINT_ZOOM = 20;

// Set a manual starting location if known.
// Otherwise browser/IP location will be attempted.
const MANUAL_LOCATION = null;

// Demonstration fallback, not real rover position
const FALLBACK_LOCATION = {
    lat: 45.4782,
    lon: 9.2273,
    source: "DEMO fallback (set actual start location)"
};

let mapOrigin = null;
let currentPoints = [];
let displayedMapFrame = null;
let requestedMapSignature = null;
let requestSequence = 0;
let updateInProgress = false;
let lastDataCount = -1;


// ===============================================
// UTILITIES
// ===============================================

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function validPoint(point) {
    return point != null &&
        point.x != null &&
        point.y != null &&
        point.power_mw != null &&
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

    if (element) {
        element.textContent = message;
    }
}


// ===============================================
// POWER COLOR
// RED -> ORANGE -> YELLOW -> GREEN
// ===============================================

function powerColor(power) {
    const value = Number(power);

    if (!Number.isFinite(value)) {
        return "#64748b";
    }

    const t = clamp(
        (value - RED_POWER_MW) /
        (GREEN_POWER_MW - RED_POWER_MW),
        0,
        1
    );

    const stops = [
        [220, 38, 38],
        [249, 115, 22],
        [234, 179, 8],
        [132, 204, 22],
        [22, 163, 74]
    ];

    const scaled = t * (stops.length - 1);

    const i = Math.min(
        Math.floor(scaled),
        stops.length - 2
    );

    const fraction = scaled - i;

    const rgb = stops[i].map((start, channel) =>
        Math.round(
            start +
            fraction * (
                stops[i + 1][channel] - start
            )
        )
    );

    return `rgb(${rgb.join(",")})`;
}


// ===============================================
// GEOGRAPHIC PROJECTION
// ===============================================

const DEG = Math.PI / 180;
const EARTH_RADIUS_METERS = 6378137;

function metersToLocation(x, y) {
    // Local X is assumed east, Y north.
    // Actual accuracy depends on rover orientation.

    const lat = clamp(
        mapOrigin.lat +
        (Number(y) / EARTH_RADIUS_METERS) / DEG,
        -85.05112878,
        85.05112878
    );

    const cosLat = Math.max(
        Math.cos(mapOrigin.lat * DEG),
        0.01
    );

    const lon =
        mapOrigin.lon +
        (
            Number(x) /
            (EARTH_RADIUS_METERS * cosLat)
        ) / DEG;

    return { lat, lon };
}

function projectWorld(lat, lon) {
    const sinLat = Math.sin(
        clamp(
            lat,
            -85.05112878,
            85.05112878
        ) * DEG
    );

    return {
        x: (lon + 180) / 360 * 256,

        y: (
            0.5 -
            Math.log(
                (1 + sinLat) / (1 - sinLat)
            ) / (4 * Math.PI)
        ) * 256
    };
}

function unprojectWorld(worldX, worldY) {
    const lon = worldX / 256 * 360 - 180;

    const n = Math.PI * (
        1 - 2 * worldY / 256
    );

    const lat = Math.atan(Math.sinh(n)) / DEG;

    return { lat, lon };
}


// ===============================================
// AUTO-FITTING SATELLITE MAP
// ===============================================

function makeMapFrame(points) {
    if (!mapOrigin) return null;

    const valid = points.filter(validPoint);

    const projected = valid.length
        ? valid.map(point => {
            const gps = metersToLocation(
                point.x,
                point.y
            );

            return projectWorld(
                gps.lat,
                gps.lon
            );
        })
        : [
            projectWorld(
                mapOrigin.lat,
                mapOrigin.lon
            )
        ];

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
            ? Math.log2(
                (MAP_WIDTH * ROUTE_FILL) /
                worldWidth
            )
            : Infinity;

        const zoomHeight = worldHeight > 0
            ? Math.log2(
                (MAP_HEIGHT * ROUTE_FILL) /
                worldHeight
            )
            : Infinity;

        zoom = Math.floor(
            Math.min(zoomWidth, zoomHeight)
        );
    }

    zoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);

    return {
        zoom,
        centerWorldX,
        centerWorldY,
        center: unprojectWorld(
            centerWorldX,
            centerWorldY
        )
    };
}

function refreshSatellite(points) {
    if (!mapOrigin) return;

    if (
        !GOOGLE_MAPS_KEY ||
        GOOGLE_MAPS_KEY ===
        "PASTE_YOUR_NEW_GOOGLE_MAPS_KEY_HERE"
    ) {
        showMapMessage(
            "Satellite imagery needs a Google Maps Static API key. " +
            "The trajectory still works."
        );

        setLocationInfo(
            "Map origin: " +
            mapOrigin.source +
            " | Satellite key not configured"
        );

        return;
    }

    const frame = makeMapFrame(points);

    if (!frame) return;

    const latitude = frame.center.lat.toFixed(8);
    const longitude = frame.center.lon.toFixed(8);

    const signature =
        `${latitude},${longitude}|${frame.zoom}`;

    if (signature === requestedMapSignature) {
        return;
    }

    requestedMapSignature = signature;

    const parameters = new URLSearchParams({
        center: `${latitude},${longitude}`,
        zoom: String(frame.zoom),
        size: `${MAP_WIDTH}x${MAP_HEIGHT}`,
        scale: "2",
        maptype: "satellite",
        key: GOOGLE_MAPS_KEY
    });

    const imageURL =
        "https://maps.googleapis.com/maps/api/staticmap?" +
        parameters.toString();

    const requestID = ++requestSequence;
    const preload = new Image();

    showMapMessage(
        displayedMapFrame
            ? "Updating satellite scale..."
            : "Loading satellite imagery..."
    );

    setLocationInfo(
        "Loading map: " +
        mapOrigin.source +
        " | Zoom " +
        frame.zoom
    );

    preload.onload = () => {
        if (requestID !== requestSequence) {
            return;
        }

        const imageElement =
            document.getElementById("google-background");

        if (!imageElement) return;

        imageElement.src = imageURL;
        imageElement.classList.add("is-loaded");

        displayedMapFrame = frame;

        showMapMessage("");

        const metersPerPixel =
            156543.03392 *
            Math.cos(frame.center.lat * DEG) /
            (2 ** frame.zoom);

        setLocationInfo(
            `${mapOrigin.source} | ` +
            `Auto zoom ${frame.zoom} | ` +
            `${metersPerPixel.toFixed(3)} meters/pixel`
        );

        drawTrajectory(currentPoints);

        console.log(
            "SolarScout satellite updated to zoom",
            frame.zoom
        );
    };

    preload.onerror = () => {
        if (requestID !== requestSequence) {
            return;
        }

        showMapMessage(
            "Satellite image failed. Check the " +
            "Static Maps API, billing, API-key " +
            "restrictions, and Network > staticmap."
        );

        setLocationInfo(
            "Satellite unavailable | " +
            mapOrigin.source
        );

        console.error(
            "SolarScout: Google Static Maps image failed."
        );
    };

    preload.src = imageURL;
}


// ===============================================
// SOLAR TRAJECTORY DRAWING
// ===============================================

function drawTrajectory(points) {
    const canvas =
        document.getElementById("trajectory");

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
        const factor =
            2 ** displayedMapFrame.zoom;

        xy = point => {
            const gps = metersToLocation(
                point.x,
                point.y
            );

            const world = projectWorld(
                gps.lat,
                gps.lon
            );

            return {
                x:
                    W / 2 +
                    (
                        world.x -
                        displayedMapFrame.centerWorldX
                    ) * factor * W / MAP_WIDTH,

                y:
                    H / 2 +
                    (
                        world.y -
                        displayedMapFrame.centerWorldY
                    ) * factor * H / MAP_HEIGHT
            };
        };
    } else {
        // Draw relative route even without satellite.

        const xs = valid.map(p => Number(p.x));
        const ys = valid.map(p => Number(p.y));

        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);

        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;

        const scale = Math.min(
            (W * ROUTE_FILL) /
                Math.max(maxX - minX, 0.1),

            (H * ROUTE_FILL) /
                Math.max(maxY - minY, 0.1)
        );

        xy = point => ({
            x:
                W / 2 +
                (Number(point.x) - centerX) * scale,

            y:
                H / 2 -
                (Number(point.y) - centerY) * scale
        });
    }

    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = 10;

    // Colored route segments
    for (let i = 1; i < valid.length; i++) {
        const previous = valid[i - 1];
        const current = valid[i];

        const a = xy(previous);
        const b = xy(current);

        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);

        const meanPower =
            (
                Number(previous.power_mw) +
                Number(current.power_mw)
            ) / 2;

        ctx.strokeStyle = powerColor(meanPower);
        ctx.stroke();
    }

    // Position markers
    for (let i = 0; i < valid.length; i++) {
        const point = valid[i];
        const pos = xy(point);

        const isStart = i === 0;
        const isLatest = i === valid.length - 1;

        const color = isStart
            ? "#2563eb"
            : isLatest
                ? "#111827"
                : powerColor(point.power_mw);

        ctx.beginPath();

        ctx.arc(
            pos.x,
            pos.y,
            (isStart || isLatest) ? 10 : 8,
            0,
            Math.PI * 2
        );

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

            ctx.strokeText(
                String(i + 1),
                pos.x,
                pos.y - 21
            );

            ctx.fillStyle = "#111827";

            ctx.fillText(
                String(i + 1),
                pos.x,
                pos.y - 21
            );
        }
    }
}


// ===============================================
// POWER MATRIX 7 x 5
//
// PAN: columns
// TILT: rows
//
// Data remains matrix[pan][tilt]
// ===============================================

const PAN_ANGLES = [
    -90, -60, -30, 0, 30, 60, 90
];

const TILT_ANGLES = [
    -60, -30, 0, 30, 60
];

function drawHeatmap(matrix) {
    const canvas =
        document.getElementById("heatmap");

    if (!canvas) return;

    // Landscape canvas for 7 columns x 5 rows.
    // No HTML changes required.

    const WIDTH = 840;
    const HEIGHT = 600;

    if (canvas.width !== WIDTH) {
        canvas.width = WIDTH;
    }

    if (canvas.height !== HEIGHT) {
        canvas.height = HEIGHT;
    }

    canvas.style.aspectRatio = "7 / 5";

    canvas.setAttribute(
        "aria-label",
        "Power matrix with pan columns, tilt rows and maximum highlighted"
    );

    const ctx = canvas.getContext("2d");

    if (!ctx) return;

    ctx.clearRect(0, 0, WIDTH, HEIGHT);

    // Internal margins for titles and angles
    const left = 108;
    const top = 120;
    const right = 20;
    const bottom = 24;

    const cellWidth =
        (WIDTH - left - right) /
        PAN_ANGLES.length;

    const cellHeight =
        (HEIGHT - top - bottom) /
        TILT_ANGLES.length;

    const hasMatrix =
        Array.isArray(matrix) &&
        matrix.length === PAN_ANGLES.length &&
        matrix.every(
            row =>
                Array.isArray(row) &&
                row.length === TILT_ANGLES.length
        );

    // Maximum power tracking
    let bestPower = -Infinity;
    let bestPan = -1;
    let bestTilt = -1;

    // -------------------------------------------
    // Draw power cells
    // -------------------------------------------

    for (
        let tilt = 0;
        tilt < TILT_ANGLES.length;
        tilt++
    ) {
        for (
            let pan = 0;
            pan < PAN_ANGLES.length;
            pan++
        ) {
            const x = left + pan * cellWidth;
            const y = top + tilt * cellHeight;

            const value = hasMatrix
                ? Number(matrix[pan][tilt])
                : NaN;

            if (Number.isFinite(value)) {
                ctx.fillStyle = powerColor(value);

                if (value > bestPower) {
                    bestPower = value;
                    bestPan = pan;
                    bestTilt = tilt;
                }
            } else {
                // Waiting for measurements
                ctx.fillStyle = "#e2e8f0";
            }

            ctx.fillRect(
                x,
                y,
                cellWidth,
                cellHeight
            );

            // White cell separators
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = 1.5;

            ctx.strokeRect(
                x,
                y,
                cellWidth,
                cellHeight
            );
        }
    }

    // -------------------------------------------
    // Highlight maximum measurement
    // WITHOUT changing its power color
    // -------------------------------------------

    if (bestPan >= 0 && bestTilt >= 0) {
        const x = left + bestPan * cellWidth;
        const y = top + bestTilt * cellHeight;

        const inset = 5;

        ctx.save();

        // Strong dark outline
        ctx.strokeStyle = "#101827";
        ctx.lineWidth = 7;

        ctx.strokeRect(
            x + inset,
            y + inset,
            cellWidth - 2 * inset,
            cellHeight - 2 * inset
        );

        // Dashed white outline
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 3;
        ctx.setLineDash([8, 5]);

        ctx.strokeRect(
            x + inset,
            y + inset,
            cellWidth - 2 * inset,
            cellHeight - 2 * inset
        );

        ctx.setLineDash([]);

        ctx.restore();
    }

    // -------------------------------------------
    // PAN AND TILT HEADERS
    // -------------------------------------------

    // Dark labels on the white canvas
    ctx.fillStyle = "#1f2937";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    // PAN title
    ctx.font = "bold 26px Arial";

    ctx.fillText(
        "PAN (°)",
        left + 3.5 * cellWidth,
        30
    );

    // PAN column angles
    ctx.font = "bold 22px Arial";

    for (
        let pan = 0;
        pan < PAN_ANGLES.length;
        pan++
    ) {
        ctx.fillText(
            `${PAN_ANGLES[pan]}°`,
            left + (pan + 0.5) * cellWidth,
            top - 28
        );
    }

    // TILT row angles
    ctx.textAlign = "right";

    for (
        let tilt = 0;
        tilt < TILT_ANGLES.length;
        tilt++
    ) {
        ctx.fillText(
            `${TILT_ANGLES[tilt]}°`,
            left - 15,
            top + (tilt + 0.5) * cellHeight
        );
    }

    // Vertical TILT title
    ctx.save();

    ctx.translate(
        25,
        top + 2.5 * cellHeight
    );

    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.font = "bold 22px Arial";

    ctx.fillText("TILT (°)", 0, 0);

    ctx.restore();
}


// ===============================================
// DASHBOARD STATISTICS
// ===============================================

function updateStatistics(data) {
    const points = Array.isArray(data.points)
        ? data.points
        : [];

    document.getElementById("samples").textContent =
        String(data.count ?? points.length);

    if (!data.latest) return;

    const latest = data.latest;

    document.getElementById("power").textContent =
        Number(latest.power_mw).toFixed(2) + " mW";

    document.getElementById("position").textContent =
        `(${Number(latest.x).toFixed(2)}, ` +
        `${Number(latest.y).toFixed(2)})`;

    const powers = points
        .map(p => Number(p.power_mw))
        .filter(Number.isFinite);

    const maxPower = powers.length
        ? Math.max(...powers)
        : 0;

    document.getElementById("maxPower").textContent =
        maxPower.toFixed(2) + " mW";
}


// ===============================================
// LIVE DATA FROM PYTHON BACKEND
// ===============================================

async function updateDashboard() {
    if (updateInProgress) return;

    updateInProgress = true;

    try {
        const response = await fetch(
            API_URL,
            { cache: "no-store" }
        );

        if (!response.ok) {
            throw new Error(
                `HTTP ${response.status}`
            );
        }

        const data = await response.json();

        if (
            !data ||
            !Array.isArray(data.points)
        ) {
            throw new Error(
                "Unexpected response from /api/solar"
            );
        }

        currentPoints = data.points;

        // Update graphics
        drawTrajectory(currentPoints);
        drawHeatmap(data.power_matrix || []);

        // Update statistics
        updateStatistics(data);

        // Connection status
        document.getElementById("status").textContent =
            (data.count ?? currentPoints.length) > 0
                ? "Connected | Data available"
                : "Connected | Waiting for samples";

        // Recalculate satellite frame when route changes
        const count =
            data.count ?? currentPoints.length;

        const end =
            currentPoints[currentPoints.length - 1];

        const lastKey =
            `${count}|${end?.x ?? ""}|${end?.y ?? ""}`;

        if (lastKey !== lastDataCount) {
            lastDataCount = lastKey;
            refreshSatellite(currentPoints);
        }

    } catch (error) {
        console.error(
            "SolarScout backend:",
            error
        );

        document.getElementById("status").textContent =
            "Backend disconnected";

    } finally {
        updateInProgress = false;
    }
}


// ===============================================
// LOCATION INITIALIZATION
// ===============================================

async function getMapLocation() {
    if (MANUAL_LOCATION !== null) {
        return MANUAL_LOCATION;
    }

    // Browser location
    if (
        navigator.geolocation &&
        window.isSecureContext
    ) {
        try {
            const position = await new Promise(
                (resolve, reject) =>
                    navigator.geolocation.getCurrentPosition(
                        resolve,
                        reject,
                        {
                            enableHighAccuracy: true,
                            timeout: 6000,
                            maximumAge: 60000
                        }
                    )
            );

            return {
                lat: position.coords.latitude,
                lon: position.coords.longitude,
                source: "Browser location (not necessarily Arduino)"
            };

        } catch (error) {
            console.warn(
                "Browser location failed:",
                error
            );
        }
    }

    // Approximate IP location
    try {
        const response = await fetch(
            "https://ipapi.co/json/",
            { cache: "no-store" }
        );

        if (!response.ok) {
            throw new Error(
                `HTTP ${response.status}`
            );
        }

        const data = await response.json();

        const lat = Number(data.latitude);
        const lon = Number(data.longitude);

        if (
            Number.isFinite(lat) &&
            Number.isFinite(lon) &&
            Math.abs(lat) <= 85 &&
            Math.abs(lon) <= 180
        ) {
            return {
                lat,
                lon,
                source: "Approximate IP location (not necessarily Arduino)"
            };
        }

    } catch (error) {
        console.warn(
            "IP location failed, using fallback:",
            error
        );
    }

    return FALLBACK_LOCATION;
}


// ===============================================
// START APPLICATION
// ===============================================

async function startSolarScout() {
    console.log("SolarScout WebUI started");

    // Start backend polling immediately
    updateDashboard();

    setInterval(
        updateDashboard,
        REFRESH_INTERVAL_MS
    );

    // Find map origin
    try {
        mapOrigin = await getMapLocation();

    } catch (error) {
        console.warn(
            "Location lookup failed:",
            error
        );

        mapOrigin = FALLBACK_LOCATION;
    }

    const lat = Number(mapOrigin.lat);
    const lon = Number(mapOrigin.lon);

    if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lon) ||
        Math.abs(lat) > 85 ||
        Math.abs(lon) > 180
    ) {
        showMapMessage(
            "Invalid map origin coordinates. " +
            "Set MANUAL_LOCATION correctly."
        );

        return;
    }

    refreshSatellite(currentPoints);
}


// ===============================================
// PAGE INITIALIZATION
// ===============================================

if (document.readyState === "loading") {
    document.addEventListener(
        "DOMContentLoaded",
        startSolarScout
    );
} else {
    startSolarScout();
}
