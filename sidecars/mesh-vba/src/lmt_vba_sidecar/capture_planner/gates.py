"""Observability gate constants for capture planning.

MUST stay in sync with the real reconstruction gate. The source of truth is
`reconstruct.py` (MIN_PNP_CORNERS, QUALITY_MIN_VIEWS) and the defaults of
`observability.check_observability` (min_views, min_points). A unit test
asserts these mirror; if reconstruct changes its gate, that test breaks loud.
"""
from __future__ import annotations

# A single view needs this many visible points to seed its PnP pose.
MIN_PNP_CORNERS = 4
# A cabinet needs at least this many observing views (HARD gate).
MIN_VIEWS = 2
# A cabinet needs at least this many total observations across views (HARD).
MIN_POINTS_PER_CABINET = 8
# Below this many views (but >= MIN_VIEWS) the cabinet is flagged low-observation.
QUALITY_MIN_VIEWS = 4
