"""Density check notes for ASUS/LG (P1-C1).

Razer SSH (lanbp@192.168.10.173) was unreachable from this session
(Permission denied: publickey/password). Cabinet-grid granularity therefore
remains unknown at implement time.

Mitigation taken in P1:
  - Open ``markers_per_cabinet`` to the full 6-bit ``local_id`` range (1..64)
    via an N×N sub-grid inside each cabinet. Encoding protocol unchanged.
  - Stage-level planner can further raise density / edge coverage independent
    of the physical cabinet count.

Follow-up on Razer: inspect ASUS/LG screen JSON ``cabinet_size`` and section
extents, then set a production default ``markers_per_cabinet`` that yields
≥60 trustworthy markers under normal dual-screen framing.
"""
