import os
import tempfile
import unittest
from datetime import datetime

os.environ["DATABASE_URL"] = f"sqlite:///{tempfile.NamedTemporaryFile(suffix='.db').name}"

from fastapi.testclient import TestClient

from app.main import app
from app.database import SessionLocal
from app.models import SimulationState
from app.simulation import _deterministic_profile


class SimulationClosedLoopTest(unittest.TestCase):
    def test_entities_tick_and_grid_connection(self) -> None:
        with TestClient(app) as client:
            entities_response = client.get("/api/simulation/entities")
            self.assertEqual(entities_response.status_code, 200)
            entities = entities_response.json()
            self.assertEqual(
                {row["type"] for row in entities},
                {"transport_crew", "crane", "production_equipment", "storage_unit",
                 "transmission_line", "wind_turbine_site"},
            )

            update = client.post("/api/simulation/entities", json={
                "id": "production-F-B", "type": "production_equipment",
                "position": [40.58, 109.96], "target_id": "F-B", "progress": 0,
                "status": "producing", "payload": {"rates_per_hour": {"tower": 1}},
            })
            self.assertEqual(update.status_code, 200)
            self.assertEqual(update.json()["payload"]["inventory"]["tower"], 0)
            self.assertEqual(update.json()["payload"]["rates_per_hour"]["tower"], 1)

            tick_response = client.post(
                "/api/simulation/tick",
                json={"steps": 40, "step_hours": 1, "start_time": "2027-01-01T00:00:00Z"},
            )
            self.assertEqual(tick_response.status_code, 200)
            ticked = tick_response.json()
            self.assertGreaterEqual(ticked["state"]["tick_count"], 40)

            site = next(row for row in ticked["entities"] if row["type"] == "wind_turbine_site")
            production = next(row for row in ticked["entities"] if row["type"] == "production_equipment")
            self.assertGreaterEqual(production["payload"]["dispatch_count"], 1)
            self.assertGreater(sum(production["payload"]["last_dispatch_inventory"].values()), 0)
            self.assertGreaterEqual(site["payload"]["installed_units"], 1)
            self.assertEqual(site["progress"], 100)
            self.assertEqual(site["status"], "online")

            turbine_id = site["payload"]["completed_turbine_ids"][0]
            operation_response = client.get(f"/api/turbines/{turbine_id}/history")
            self.assertEqual(operation_response.status_code, 200)
            operations = operation_response.json()["operations"]
            self.assertGreater(len(operations), 0)
            self.assertGreater(operations[0]["power_kw"], 0)

            storage = next(row for row in ticked["entities"] if row["type"] == "storage_unit")
            self.assertIn(storage["payload"]["mode"], {"idle", "charge", "discharge"})
            self.assertGreaterEqual(storage["payload"]["soc"], 0)
            self.assertLessEqual(storage["payload"]["soc"], 1)

            client.post("/api/simulation/entities", json={
                "id": storage["id"], "type": "storage_unit",
                "position": storage["position"], "target_id": storage["target_id"],
                "progress": storage["progress"], "status": "standby",
                "payload": {"capacity_mwh": 2, "soc": 0.98, "mode": "idle"},
            })
            db = SessionLocal()
            try:
                state = db.get(SimulationState, "default")
                state.current_time = datetime(2027, 1, 1, 13)
                state.tick_count = 13
                db.commit()
            finally:
                db.close()
            charge_response = client.post(
                "/api/simulation/tick",
                json={"steps": 1, "step_hours": 1, "start_time": "2027-01-01T13:00:00Z"},
            )
            self.assertEqual(charge_response.status_code, 200)
            charged = charge_response.json()
            charged_storage = next(row for row in charged["entities"] if row["type"] == "storage_unit")
            self.assertEqual(charged_storage["payload"]["soc"], 1)
            self.assertEqual(charged_storage["payload"]["mode"], "charge")

            client.post("/api/simulation/entities", json={
                "id": storage["id"], "type": "storage_unit",
                "position": storage["position"], "target_id": storage["target_id"],
                "progress": storage["progress"], "status": "standby",
                "payload": {"capacity_mwh": 2, "soc": 0.5, "mode": "idle"},
            })

            db = SessionLocal()
            try:
                state = db.get(SimulationState, "default")
                state.current_time = datetime(2027, 1, 4)
                state.tick_count = 72
                db.commit()
            finally:
                db.close()

            discharge_response = client.post(
                "/api/simulation/tick",
                json={"steps": 1, "step_hours": 4, "start_time": "2027-01-04T00:00:00Z"},
            )
            self.assertEqual(discharge_response.status_code, 200)
            discharge = discharge_response.json()
            storage = next(row for row in discharge["entities"] if row["type"] == "storage_unit")
            line = next(row for row in discharge["entities"] if row["type"] == "transmission_line")
            self.assertEqual(storage["payload"]["soc"], 0)
            self.assertEqual(storage["payload"]["mode"], "discharge")
            load_mw, gen_mw = _deterministic_profile(72)
            expected_flow = min(
                line["payload"]["capacity_mw"],
                max(-line["payload"]["capacity_mw"], gen_mw - storage["payload"]["delta_mw"]),
            )
            self.assertAlmostEqual(line["payload"]["flow_mw"], expected_flow, places=6)

            timeseries_response = client.get("/api/simulation/timeseries?hours=72")
            self.assertEqual(timeseries_response.status_code, 200)
            timeseries = timeseries_response.json()
            self.assertEqual(len(timeseries["timestamps"]), 72)
            self.assertEqual(len(timeseries["price_yuan_mwh"]), 72)
            self.assertEqual(len(timeseries["load_mw"]), 72)
            self.assertEqual(len(timeseries["gen_mw"]), 72)
            self.assertEqual(len(timeseries["storage_delta"]), 72)
            self.assertTrue(all(price >= 0 for price in timeseries["price_yuan_mwh"]))
            self.assertEqual(client.get("/api/simulation/timeseries?hours=72").json(), timeseries)
            self.assertEqual(
                len({tuple(timeseries[key]) for key in ("price_yuan_mwh", "load_mw", "gen_mw", "storage_delta")}),
                4,
            )

            delete_response = client.delete("/api/simulation/entities/storage-wf-hohhot")
            self.assertEqual(delete_response.status_code, 200)
            self.assertEqual(delete_response.json()["status"], "deleted")


if __name__ == "__main__":
    unittest.main()
