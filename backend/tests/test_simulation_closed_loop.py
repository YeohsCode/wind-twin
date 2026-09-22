import os
import tempfile
import unittest

os.environ["DATABASE_URL"] = f"sqlite:///{tempfile.NamedTemporaryFile(suffix='.db').name}"

from fastapi.testclient import TestClient

from app.main import app


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

            delete_response = client.delete("/api/simulation/entities/storage-wf-hohhot")
            self.assertEqual(delete_response.status_code, 200)
            self.assertEqual(delete_response.json()["status"], "deleted")


if __name__ == "__main__":
    unittest.main()
