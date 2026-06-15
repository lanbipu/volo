use mesh_adapter_visual_ba::ipc::PatternMeta;

#[test]
fn deserializes_v2_pattern_meta() {
    let json = r#"{"schema_version":2,"aruco_dict":"DICT_6X6_1000",
      "cabinets":[{"col":0,"row":0,"aruco_id_start":0,"aruco_id_end":39,
        "squares_x":9,"squares_y":9,"square_px":120,"pixel_pitch_mm":[0.2778,0.2778]},
       {"col":1,"row":0,"aruco_id_start":40,"aruco_id_end":111,
        "squares_x":16,"squares_y":9,"square_px":120,"pixel_pitch_mm":[0.3125,0.3125]}]}"#;
    let meta: PatternMeta = serde_json::from_str(json).unwrap();
    assert_eq!(meta.schema_version, 2);
    assert_eq!(meta.cabinets[0].squares_x, 9);
    assert_eq!(meta.cabinets[0].squares_y, 9);
    assert_eq!(meta.cabinets[1].squares_x, 16);
    assert_eq!(meta.cabinets[1].pixel_pitch_mm, [0.3125, 0.3125]);
    // round-trip
    let back: PatternMeta =
        serde_json::from_str(&serde_json::to_string(&meta).unwrap()).unwrap();
    assert_eq!(back.cabinets.len(), 2);
}
