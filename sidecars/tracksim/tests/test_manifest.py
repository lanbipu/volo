from tracksim.manifest import build_manifest
from tracksim.envelope import CONTRACT_VERSION

EXPECTED_OPERATION_IDS = {
    "sim.run",
    "sim.send",
    "sim.convert",
    "controllers.list",
    "controllers.monitor",
    "config.init",
    "config.show",
    "config.validate",
    "freed.decode",
    "opentrackio.decode",
    "meta.manifest",
    "meta.schema",
    "meta.version",
    "meta.completion",
}


def test_manifest_is_dict_with_operations():
    m = build_manifest()
    assert isinstance(m, dict)
    assert m["contract_version"] == CONTRACT_VERSION
    assert isinstance(m["operations"], list)


def test_manifest_operation_id_set_exact():
    m = build_manifest()
    ids = {op["operation_id"] for op in m["operations"]}
    assert ids == EXPECTED_OPERATION_IDS


def test_manifest_operation_ids_unique():
    m = build_manifest()
    ids = [op["operation_id"] for op in m["operations"]]
    assert len(ids) == len(set(ids))
    assert len(ids) == 14


def test_each_operation_has_summary():
    m = build_manifest()
    for op in m["operations"]:
        assert isinstance(op.get("summary"), str)
        assert op["summary"]
