"""Secret vault abstraction.

Registry records only ever hold a *secret reference* such as
``secret://vault/sec_ab12cd34``. Secret values are encrypted at rest and are
never returned through the management API after creation.

The default backend is a local Fernet-encrypted file for development. Swap
`LocalVault` for a Vault/OpenBao or cloud secret-manager backend in production
by implementing the same three methods.
"""
from __future__ import annotations

import json
import os
import threading
import uuid

from cryptography.fernet import Fernet

from .config import VAULT_FILE, VAULT_KEY_FILE

PREFIX = "secret://vault/"


class LocalVault:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        if not VAULT_KEY_FILE.exists():
            VAULT_KEY_FILE.write_bytes(Fernet.generate_key())
            try:
                os.chmod(VAULT_KEY_FILE, 0o600)
            except OSError:
                pass
        self._fernet = Fernet(VAULT_KEY_FILE.read_bytes())

    def _load(self) -> dict[str, dict]:
        if not VAULT_FILE.exists():
            return {}
        return json.loads(VAULT_FILE.read_text() or "{}")

    def _save(self, data: dict[str, dict]) -> None:
        VAULT_FILE.write_text(json.dumps(data, indent=1))

    def put(self, value: str, *, label: str = "", owner: str = "") -> str:
        sid = f"sec_{uuid.uuid4().hex[:12]}"
        with self._lock:
            data = self._load()
            data[sid] = {"label": label, "owner": owner, "value": self._fernet.encrypt(value.encode()).decode()}
            self._save(data)
        return PREFIX + sid

    def get(self, ref: str) -> str | None:
        """Resolve a secret. Only runtime components call this — never routers."""
        if not ref or not ref.startswith(PREFIX):
            return None
        sid = ref[len(PREFIX):]
        entry = self._load().get(sid)
        if not entry:
            return None
        return self._fernet.decrypt(entry["value"].encode()).decode()

    def delete(self, ref: str) -> None:
        if not ref.startswith(PREFIX):
            return
        with self._lock:
            data = self._load()
            data.pop(ref[len(PREFIX):], None)
            self._save(data)

    def list_refs(self) -> list[dict]:
        return [{"ref": PREFIX + k, "label": v.get("label", ""), "owner": v.get("owner", "")} for k, v in self._load().items()]


vault = LocalVault()


def mask(value: str | None) -> str:
    if not value:
        return ""
    return "•" * 8 + value[-4:] if len(value) > 8 else "•" * 8
