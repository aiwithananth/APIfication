"""APIfication control plane + development data plane.

In development both planes run in one process. In production the gateway
(`app.runtime.gateway`) runs as a separate, horizontally scaled data-plane
service with its own identity, using the same contracts.
"""
from __future__ import annotations

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import db
from .ai import assistant
from .config import CORS_ORIGINS, PLATFORM_VERSION, SEED_DEMO
from .routers import ai, connectors, core, governance
from .runtime import gateway

log = logging.getLogger("apification")

app = FastAPI(title="APIfication Control Plane", version=PLATFORM_VERSION,
              description="Governed API, GraphQL and MCP capability platform — management API.")
app.add_middleware(CORSMiddleware, allow_origins=CORS_ORIGINS, allow_credentials=True,
                   allow_methods=["*"], allow_headers=["*"])

app.include_router(core.router)
app.include_router(connectors.router)
app.include_router(governance.router)
app.include_router(ai.router)
app.include_router(gateway.router)

# wire assistant actions to the same service functions the UI uses
assistant.actions.create_project = lambda name, description="": core.create_project(name, description)
assistant.actions.generate_capability = lambda prompt, project_id, connector_id=None: core.generate_capability(prompt, project_id, connector_id)
assistant.actions.run_tests = lambda cid: core.run_cap_tests(cid)
assistant.actions.deploy = lambda cid, env: governance.deploy(cid, env)
assistant.actions.simulate = lambda args: core.simulate(args)


@app.on_event("startup")
def startup() -> None:
    db.engine()
    if SEED_DEMO:
        try:
            from .seed import seed
            seed()
        except Exception:  # noqa: BLE001
            log.exception("Demo seed failed")


@app.get("/health")
def health():
    return {"status": "ok", "version": PLATFORM_VERSION}
