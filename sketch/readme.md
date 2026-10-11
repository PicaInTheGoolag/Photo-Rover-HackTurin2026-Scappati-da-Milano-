# photoRover: Arduino UNO Q firmware (`sketch/`)

`sketch.ino` runs the hardware side of photoRover on the **Arduino UNO Q**. The sketch scans a photovoltaic panel with two servos, samples electrical power and analog light, watches an IMU to wait for stable stops, estimates relative cart position, and sends one **7×5 solar power matrix** to Python after each completed scan. It also moves the panel to the highest-power angle and reports results through the LCD and Serial Monitor.

The Python/SQLite database lives on the Linux/App Lab side, **not** in this Arduino sketch.

## Source and configuration

| File | Purpose |
| --- | --- |
| `sketch.ino` | All firmware logic: devices, scanning, IMU, dead reckoning, display and `Bridge.notify()`. |
| `sketch.yaml` | Default Arduino App Lab sketch profile, Zephyr platform and pinned dependency versions. |
| `readme.md` | This hardware and firmware reference. |

## Hardware connections described by the code

| Component | Firmware binding / role |
| --- | --- |
| **Arduino UNO Q** | Host MCU, Arduino RouterBridge connection to Python. |
| **PV panel + INA219** | `Adafruit_INA219 ina219(0x40)` on I²C; reads bus voltage in V and current in mA. |
| **Light sensor** | `analogRead(A0)`, averages five readings. |
| **Modulino Movement** | `ModulinoMovement movement`; motion/stability and acceleration, roll and pitch. |
| **Pan servo** | `panServo.attach(9)`, Arduino digital pin **9**. |
| **Tilt servo** | `tiltServo.attach(10)`, Arduino digital pin **10**. |
| **Grove RGB LCD 16×2** | `rgb_lcd lcd`, I²C; last X/Y estimate and maximum scan power. |
| **Serial Monitor** | `Serial.begin(9600)`, verbose scan data, comparison maps and CSV-like route output. |

The source does not include a full electrical wiring schematic. Check power, ground and physical I²C bus connections against your prototype. **Do not power both servos directly from GPIO signal pins**; use a suitable regulated power source and a common ground.

### Arduino libraries

The sketch includes:

```cpp
#include "Modulino.h"
#include <Servo.h>
#include <Adafruit_INA219.h>
#include <Wire.h>
#include <Arduino_RouterBridge.h>
#include "rgb_lcd.h"
```

`sketch.yaml` selects `arduino:zephyr` and lists **Arduino_Modulino 0.9.1**, **Servo 1.3.0**, **Adafruit INA219 1.2.3**, **Grove - LCD RGB Backlight 1.0.2**, plus other direct/transitive library dependencies. Build through the matching Arduino UNO Q / App Lab toolchain rather than assuming a generic Arduino UNO compilation target.

## Scan geometry and matrix indexing

The code declares:

```cpp
const int PAN_MIN  = 0;
const int PAN_MAX  = 180;
const int TILT_MIN = 30;
const int TILT_MAX = 150;
const int STEP     = 30;
```

Therefore there are **7** physical pan commands (`0,30,60,90,120,150,180°`) and **5** tilt commands (`30,60,90,120,150°`), or **35** combinations.

Arrays are declared with the first index for pan and the second for tilt:

```cpp
float voltageMap[PAN_STEPS][TILT_STEPS];
float currentMap[PAN_STEPS][TILT_STEPS];
float powerMap[PAN_STEPS][TILT_STEPS];
```

The packet sent to Python is likewise `power[panIndex][tiltIndex]`, **seven arrays of five values**. The dashboard subsequently displays the 7 pan values as *columns* and the 5 tilt values as *rows*. It labels these angles **relative to 90°**, namely pan `−90…90°` and tilt `−60…60°`. **The firmware itself still sends the physical 0…180° / 30…150° commands**; the browser subtracts 90° only when labeling its axes.

## Electrical and light measurements

At each angle:

1. The pan and/or tilt servo moves and waits for the default **350 ms** settle time.
2. `readLight()` averages **5** `analogRead(A0)` samples, each with a 10 ms delay.
3. `readPanel()` averages **5** INA219 bus-voltage and current readings, also with 10 ms delays.
4. The firmware computes `power_mW = voltage_V * current_mA` (because V × mA = mW).
5. Light, voltage, current and power are stored in their local 7×5 arrays. The sketch tracks the highest `power_mW` and its physical pan/tilt commands.

Only the **power matrix** and **relative X/Y** are included in the Bridge message. Analog light, per-angle voltage and current, selected best pan/tilt, and measured roll/pitch are **not** persisted by the current Python database. They remain available in the firmware's Serial output and/or local arrays.

## Stability, dead reckoning and main loop

**Setup:**

1. Starts Serial at 9600 baud and initializes the Arduino RouterBridge (`Bridge.begin()`).
2. Starts I²C and LCD; initializes INA219 or stops if the INA219 is not detected.
3. Starts Modulino and Movement, calibrates acceleration X/Y offsets by averaging **20** readings while the cart is stationary.
4. Attaches servos at pins 9/10, points both to `90°`, and starts the dead-reckoning timer.

**Loop:**

1. Calls `updatePosition()`, which integrates offset-corrected acceleration into X/Y velocity/position with a noise threshold and damping factor.
2. Checks `isStable()` using changes in acceleration over **5** samples, with an additional **1,000 ms** stability window in `waitForStability()`.
3. Stops integrated velocity, preserves the previous maps, then scans all 35 servo combinations.
4. Prints the scan's light and power maps and differences from the previous power map, then returns the panel to the best recorded physical orientation.
5. Stores a route summary in the firmware buffer (up to **50** points), updates the LCD with X/Y and peak measured power, prints a CSV-like map summary, and calls `sendPositionAndPower()`.
6. Waits until movement is detected again before scanning the next stop.

> **Timing:** Each of the 35 orientations incurs servo settle and sampling delays, and there are additional stabilization checks. The Python/dashboard one-second polling rate does not imply that the MCU produces one scan per second.

## Arduino → Python JSON packet

The firmware assembles a JSON string and sends it via:

```cpp
Bridge.notify("solar_data", json);
```

Packet shape:

```json
{
  "x": 1.25,
  "y": -0.40,
  "power": [
    [2,4,6,8,10],
    [3,5,7,9,11],
    [4,6,8,10,12],
    [5,7,9,11,13],
    [6,8,10,12,14],
    [7,9,11,13,15],
    [8,10,12,14,16]
  ]
}
```

- `x`/`y`: floating-point relative cart-position estimates, formatted to **three decimal places**.
- `power`: 7 rows × 5 columns of power in **milliwatts**, formatted to **one decimal place**.
- The callback name is exactly `solar_data`. The Python side registers `Bridge.provide("solar_data", collector.receive)`.
- Python computes an average of the **35** powers for the map's route-color and Current Power card, and stores both the scan's mean and its individual maximum in SQLite.

The outgoing packet has **no timestamp, run ID, start GPS, or heading**. The Python backend supplies a receive timestamp and assigns a run ID. The starting GPS location is added through the dashboard.

## On-device display and diagnostic data

- **LCD row 1:** latest estimated `X` and `Y` values, with 2 decimal places.
- **LCD row 2:** `Pmax:` and the *best angle's individual power*, in mW.
- **Serial:** scan-by-scan pan/tilt, analog light, V/I/P, complete light and power tables, changes from the previous scan, best orientation and a CSV-like route summary.
- **`mapPoints[MAX_POINTS]`:** at most **50** firmware-side summary points for the Serial report. This limit is **not** the SQLite storage limit; the sketch continues to send its complete matrix even after the firmware summary array becomes full.

## Running and troubleshooting

1. Position the cart stably and connect all sensors, servos and the LCD.
2. Open the Arduino UNO Q project in **Arduino App Lab** and compile the sketch with `sketch.yaml` dependencies.
3. Start the Python app on the same UNO Q so the Bridge callback is ready.
4. Watch Serial for initialization (`BRIDGE OK`, `WIRE OK`, `INA219 OK`, `Movement OK`) and scan completion (`JSON inviato`).
5. On the dashboard, confirm the live run receives the expected 35-cell matrix. Stop/move/stop the cart to add another point.

**Compilation errors about `ModulinoHubPort::select()`, `clear()`, `Modulino` or `__increaseI2CPriority()`:** these are **linker-level Modulino symbols**, not JavaScript or database issues. Ensure the matching Arduino_Modulino implementation source is included by your installed App Lab/Zephyr library build; try clearing the App Lab build cache and checking the installed library version. Avoid papering over the linker problem by changing unrelated solar dashboard files.

**No sensor data:** check INA219 I²C address (`0x40`), that the Modulino starts, Servo power/ground, Serial logs and whether a complete sweep finishes and `Bridge.notify()` executes. Check the Python backend for invalid 7×5 matrix logging.

**Scans repeat/no new point:** after a scan, the MCU waits until it detects movement; stable readings alone do not trigger another sweep until that state changes.

## Important engineering limitations

- **IMU position is an estimate, not GPS:** raw acceleration integration accumulates drift and depends on orientation and gravity. There is no wheel odometry, absolute heading or GPS receiver in the current transmitted payload.
- **Database run changes do not reset the firmware's X/Y:** clicking **New run** in the dashboard or restarting Python does not automatically reset `posX` and `posY` on the still-running MCU. A run-specific coordinate reset needs additional firmware/protocol support or backend re-basing.
- **A0 light sensing differs from panel power:** the light map is a raw analog signal; the quantitative power shown on the dashboard comes from INA219 voltage × current measurements, not irradiance calibration.
- **Power draw and geometry need calibration:** readings depend on the PV panel, electrical load, temperature and actual physical positioning. The dashboard's centered angle labels are not independent angle-sensor measurements.
- **Firmware-local buffers are bounded:** `MAX_POINTS = 50` affects the Arduino's Serial map report, not the number of scans SQLite can retain.

See [project overview](../README.md), [Python/SQLite backend](../python/readme.md), and [dashboard](../assets/readme.md).
