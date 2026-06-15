"""NDJSON event writer. Every event is a single JSON line on stdout."""
from __future__ import annotations

import sys
from typing import TextIO

from pydantic import BaseModel


def write_event(ev: BaseModel, *, stream: TextIO | None = None) -> None:
    """Serialize a pydantic event model to NDJSON and flush.

    Flushing matters: the Rust adapter reads stdout line-by-line and must
    receive progress events promptly during a long BA run.
    """
    out = stream or sys.stdout
    out.write(ev.model_dump_json())
    out.write("\n")
    out.flush()
