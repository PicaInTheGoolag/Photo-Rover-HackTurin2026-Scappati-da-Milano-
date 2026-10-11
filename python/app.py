import json
from pathlib import Path

from arduino.app_utils import App, Bridge
from arduino.app_bricks.web_ui import WebUI

from collector import SolarCollector


# Set False when using real Arduino data
TEST_MODE = False

def load_test_data(collector):
    import json
    from pathlib import Path

    path = Path(__file__).with_name("test_data.json")

    with open(path, "r") as f:
        data = json.load(f)

    for measurement in data["measurements"]:
        collector.receive(measurement)

    print(
        f"Loaded {len(data['measurements'])} positions",
        flush=True
    )

def start_app():

    collector = SolarCollector()

    web_ui = WebUI()

    Bridge.provide(
        "solar_data",
        collector.receive
    )

    web_ui.expose_api(
        "GET",
        "/api/solar",
        collector.get_data
    )

    if TEST_MODE:
        load_test_data(collector)
    else:
        Bridge.provide(
            "solar_data",
            collector.receive
        )

    print("SolarScout running!", flush=True)
    
    App.run()