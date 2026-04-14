from fastapi.testclient import TestClient

from inference_server.main import app


def test_health_route_reports_queue_and_model_state() -> None:
    with TestClient(app) as client:
        response = client.get("/health")

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert payload["model_manager"]["loaded_model"] is None
    assert payload["queue"] == {"pending": 0, "active": 0}
