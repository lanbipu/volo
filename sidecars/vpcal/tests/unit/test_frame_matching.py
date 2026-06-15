"""Unit tests for image <-> tracking frame alignment (spec §3.6)."""

from __future__ import annotations

import pytest

from vpcal.io.frame_matching import (
    FrameMatch,
    MatchReport,
    match_frames,
    parse_frame_number,
)


# --------------------------------------------------------------------------- #
# parse_frame_number
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "filename, expected",
    [
        ("0001.png", 1),
        ("0012.png", 12),
        ("frame_12.PNG", 12),
        ("captures/normal/0003.png", 3),
        ("abc.png", None),
        ("img_2_5.png", 5),  # last run of digits wins
        ("/abs/path/to/0042.jpeg", 42),
        ("00000.png", 0),
        ("v2/captures/0007.png", 7),  # digits only from the basename stem
        ("123", 123),  # no extension
    ],
)
def test_parse_frame_number(filename, expected):
    assert parse_frame_number(filename) == expected


def test_parse_frame_number_ignores_directory_digits():
    # Directory contains digits, but the stem does not -> None.
    assert parse_frame_number("captures/normal/frame.png") is None


# --------------------------------------------------------------------------- #
# frame_id strategy
# --------------------------------------------------------------------------- #


def test_frame_id_happy_path():
    images = ["0001.png", "0002.png", "0003.png"]
    tracking = [1, 2, 3]
    report = match_frames(images, tracking, strategy="frame_id")

    assert isinstance(report, MatchReport)
    assert report.unmatched_images == []
    assert report.unused_tracking == []
    assert report.matched == [
        FrameMatch("0001.png", 0),
        FrameMatch("0002.png", 1),
        FrameMatch("0003.png", 2),
    ]


def test_frame_id_is_default_strategy():
    images = ["0002.png"]
    tracking = [1, 2]
    report = match_frames(images, tracking)  # no strategy kwarg
    assert report.matched == [FrameMatch("0002.png", 1)]
    assert report.unused_tracking == [0]


def test_frame_id_maps_to_field_not_position():
    # Tracking records out of order: image 0003 must hit the record whose
    # frame_id == 3 (index 0), not positional index 3.
    images = ["0003.png"]
    tracking = [3, 1, 2]
    report = match_frames(images, tracking, strategy="frame_id")
    assert report.matched == [FrameMatch("0003.png", 0)]
    assert report.unused_tracking == [1, 2]


def test_frame_id_unmatched_image_no_number():
    images = ["0001.png", "banner.png"]
    tracking = [1, 2]
    report = match_frames(images, tracking, strategy="frame_id")
    assert report.matched == [FrameMatch("0001.png", 0)]
    assert report.unmatched_images == ["banner.png"]
    assert report.unused_tracking == [1]


def test_frame_id_unmatched_image_number_absent():
    images = ["0001.png", "0099.png"]
    tracking = [1, 2]
    report = match_frames(images, tracking, strategy="frame_id")
    assert report.matched == [FrameMatch("0001.png", 0)]
    assert report.unmatched_images == ["0099.png"]
    assert report.unused_tracking == [1]


def test_frame_id_unused_tracking():
    images = ["0001.png"]
    tracking = [1, 2, 3]
    report = match_frames(images, tracking, strategy="frame_id")
    assert report.matched == [FrameMatch("0001.png", 0)]
    assert report.unmatched_images == []
    assert report.unused_tracking == [1, 2]


def test_frame_id_duplicate_tracking_ids_first_is_canonical():
    # frame_id 5 appears twice; first occurrence (index 0) is canonical.
    # The second occurrence (index 2) is never matched -> unused.
    images = ["0005.png", "0006.png"]
    tracking = [5, 6, 5]
    report = match_frames(images, tracking, strategy="frame_id")
    assert report.matched == [
        FrameMatch("0005.png", 0),
        FrameMatch("0006.png", 1),
    ]
    assert report.unmatched_images == []
    assert report.unused_tracking == [2]


# --------------------------------------------------------------------------- #
# line_number strategy
# --------------------------------------------------------------------------- #


def test_line_number_happy_path():
    images = ["0001.png", "0002.png", "0003.png"]
    tracking = [10, 20, 30]  # frame_id values irrelevant for line_number
    report = match_frames(images, tracking, strategy="line_number")
    assert report.matched == [
        FrameMatch("0001.png", 0),
        FrameMatch("0002.png", 1),
        FrameMatch("0003.png", 2),
    ]
    assert report.unmatched_images == []
    assert report.unused_tracking == []


def test_line_number_sorts_images_lexicographically():
    images = ["c.png", "a.png", "b.png"]
    tracking = [0, 1, 2]
    report = match_frames(images, tracking, strategy="line_number")
    assert report.matched == [
        FrameMatch("a.png", 0),
        FrameMatch("b.png", 1),
        FrameMatch("c.png", 2),
    ]


def test_line_number_extra_images_unmatched():
    images = ["0001.png", "0002.png", "0003.png"]
    tracking = [0, 1]
    report = match_frames(images, tracking, strategy="line_number")
    assert report.matched == [
        FrameMatch("0001.png", 0),
        FrameMatch("0002.png", 1),
    ]
    assert report.unmatched_images == ["0003.png"]
    assert report.unused_tracking == []


def test_line_number_extra_tracking_unused():
    images = ["0001.png", "0002.png"]
    tracking = [0, 1, 2, 3]
    report = match_frames(images, tracking, strategy="line_number")
    assert report.matched == [
        FrameMatch("0001.png", 0),
        FrameMatch("0002.png", 1),
    ]
    assert report.unmatched_images == []
    assert report.unused_tracking == [2, 3]


# --------------------------------------------------------------------------- #
# timestamp strategy
# --------------------------------------------------------------------------- #


def test_timestamp_happy_path_nearest_neighbour():
    images = ["a.png", "b.png", "c.png"]
    tracking = [0, 1, 2]
    image_ts = [0.10, 0.20, 0.30]
    track_ts = [0.11, 0.19, 0.31]  # all within default 0.05 tolerance
    report = match_frames(
        images,
        tracking,
        strategy="timestamp",
        image_timestamps=image_ts,
        tracking_timestamps=track_ts,
    )
    assert report.matched == [
        FrameMatch("a.png", 0),
        FrameMatch("b.png", 1),
        FrameMatch("c.png", 2),
    ]
    assert report.unmatched_images == []
    assert report.unused_tracking == []


def test_timestamp_picks_closest_record():
    images = ["a.png"]
    tracking = [0, 1]
    image_ts = [0.10]
    track_ts = [0.13, 0.105]  # second is closer
    report = match_frames(
        images,
        tracking,
        strategy="timestamp",
        image_timestamps=image_ts,
        tracking_timestamps=track_ts,
    )
    assert report.matched == [FrameMatch("a.png", 1)]
    assert report.unused_tracking == [0]


def test_timestamp_outside_tolerance_unmatched():
    images = ["a.png"]
    tracking = [0]
    image_ts = [0.10]
    track_ts = [0.20]  # delta 0.10 > 0.05
    report = match_frames(
        images,
        tracking,
        strategy="timestamp",
        image_timestamps=image_ts,
        tracking_timestamps=track_ts,
    )
    assert report.matched == []
    assert report.unmatched_images == ["a.png"]
    assert report.unused_tracking == [0]


def test_timestamp_custom_tolerance():
    images = ["a.png"]
    tracking = [0]
    image_ts = [0.10]
    track_ts = [0.18]  # delta 0.08, inside a wider tolerance
    report = match_frames(
        images,
        tracking,
        strategy="timestamp",
        image_timestamps=image_ts,
        tracking_timestamps=track_ts,
        timestamp_tolerance_s=0.1,
    )
    assert report.matched == [FrameMatch("a.png", 0)]


def test_timestamp_greedy_does_not_reuse_record():
    # Two images both closest to record 0; greedy assigns it to the first,
    # the second falls back to the next within-tolerance record.
    images = ["a.png", "b.png"]
    tracking = [0, 1]
    image_ts = [0.100, 0.101]
    track_ts = [0.100, 0.130]  # b's true nearest is 0, but 0 is taken
    report = match_frames(
        images,
        tracking,
        strategy="timestamp",
        image_timestamps=image_ts,
        tracking_timestamps=track_ts,
        timestamp_tolerance_s=0.05,
    )
    assert report.matched == [
        FrameMatch("a.png", 0),
        FrameMatch("b.png", 1),
    ]
    assert report.unused_tracking == []


def test_timestamp_second_image_unmatched_when_only_candidate_taken():
    images = ["a.png", "b.png"]
    tracking = [0]
    image_ts = [0.100, 0.101]
    track_ts = [0.100]  # only one record; taken by a.png
    report = match_frames(
        images,
        tracking,
        strategy="timestamp",
        image_timestamps=image_ts,
        tracking_timestamps=track_ts,
    )
    assert report.matched == [FrameMatch("a.png", 0)]
    assert report.unmatched_images == ["b.png"]
    assert report.unused_tracking == []


# --------------------------------------------------------------------------- #
# error cases
# --------------------------------------------------------------------------- #


def test_unknown_strategy_raises():
    with pytest.raises(ValueError):
        match_frames(["0001.png"], [1], strategy="bogus")


def test_timestamp_missing_both_arrays_raises():
    with pytest.raises(ValueError):
        match_frames(["a.png"], [0], strategy="timestamp")


def test_timestamp_missing_image_timestamps_raises():
    with pytest.raises(ValueError):
        match_frames(
            ["a.png"],
            [0],
            strategy="timestamp",
            tracking_timestamps=[0.1],
        )


def test_timestamp_missing_tracking_timestamps_raises():
    with pytest.raises(ValueError):
        match_frames(
            ["a.png"],
            [0],
            strategy="timestamp",
            image_timestamps=[0.1],
        )
