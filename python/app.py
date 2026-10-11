"""photoRover Arduino App Lab bridge, SQLite and dashboard REST API."""

from fastapi import HTTPException
from pydantic import BaseModel
from arduino.app_utils import App, Bridge
from arduino.app_bricks.web_ui import WebUI

from collector import SolarCollector
from db import PhotoRoverDB

# Set True to import bundled test scans into a fresh active run.
TEST_MODE = False


class CreateRun(BaseModel):
    name: str | None = None


class RenameRun(BaseModel):
    name: str


class SetOrigin(BaseModel):
    latitude: float
    longitude: float
    source: str = "manual"


def load_test_data(collector):
    import json
    from pathlib import Path
    with Path(__file__).with_name("test_data.json").open(encoding="utf-8") as file:
        measurements = json.load(file)["measurements"]
    for measurement in measurements:
        collector.receive(measurement)
    print(f"Imported {len(measurements)} test scans", flush=True)


def start_app():
    db = PhotoRoverDB()
    collector = SolarCollector(db)
    web_ui = WebUI()

    def list_runs():
        return {"runs": db.list_runs(), "active_run_id": collector.get_active_id()}

    def get_run(run_id: int):
        result = db.run_data(run_id)
        if result is None:
            raise HTTPException(status_code=404, detail="Run not found")
        return result

    def create_run(payload: CreateRun):
        try:
            run = collector.start_new_run(payload.name)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        return {"run": run, "active_run_id": collector.get_active_id()}

    def rename_run(run_id: int, payload: RenameRun):
        try:
            run = db.rename_run(run_id, payload.name)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        if run is None:
            raise HTTPException(status_code=404, detail="Run not found")
        return {"run": run}

    def set_origin(run_id: int, payload: SetOrigin):
        try:
            run = db.set_origin(
                run_id, payload.latitude, payload.longitude, payload.source
            )
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        if run is None:
            raise HTTPException(status_code=404, detail="Run not found")
        return {"run": run}

    def delete_run(run_id: int):
        removed, replacement = collector.remove_run(run_id)
        if not removed:
            raise HTTPException(status_code=404, detail="Run not found")
        return {
            "deleted_id": run_id,
            "active_run_id": collector.get_active_id(),
            "replacement_run": replacement
        }

    def get_scan(run_id: int, scan_id: int):
        scan = db.get_scan(run_id, scan_id)
        if scan is None:
            raise HTTPException(status_code=404, detail="Scan not found")
        return scan

    # Register APIs before App.run(). expose_api uses FastAPI internally.
    web_ui.expose_api("GET", "/api/solar", collector.get_data)
    web_ui.expose_api("GET", "/api/runs", list_runs)
    web_ui.expose_api("POST", "/api/runs", create_run)
    web_ui.expose_api("GET", "/api/runs/{run_id}", get_run)
    web_ui.expose_api("PATCH", "/api/runs/{run_id}", rename_run)
    web_ui.expose_api("PATCH", "/api/runs/{run_id}/origin", set_origin)
    web_ui.expose_api("DELETE", "/api/runs/{run_id}", delete_run)
    web_ui.expose_api("GET", "/api/runs/{run_id}/scans/{scan_id}", get_scan)

    # Register only once, rather than twice as in the earlier repo version.
    Bridge.provide("solar_data", collector.receive)

    if TEST_MODE:
        load_test_data(collector)

    print(f"photoRover database: {db.path}", flush=True)
    print("photoRover WebUI running!", flush=True)
    App.run()
