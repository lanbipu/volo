from tracksim.cli.commands.meta import manifest


def test_manifest_has_convert():
    _, data = manifest()
    assert "sim.convert" in {op["operation_id"] for op in data["operations"]}
