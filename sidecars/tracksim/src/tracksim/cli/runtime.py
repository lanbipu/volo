from __future__ import annotations

import uuid
from datetime import datetime, timezone


def new_request_id() -> str:
    return str(uuid.uuid4())


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def resolve_output(explicit: str | None, *, ai_agent_env: bool, is_tty: bool) -> str:
    if explicit is not None:
        return explicit
    if ai_agent_env:
        return "json"
    return "text"


def color_enabled(*, no_color_flag: bool, no_color_env: bool, is_tty: bool) -> bool:
    if no_color_flag or no_color_env or not is_tty:
        return False
    return True
