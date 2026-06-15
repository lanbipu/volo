from tracksim.cli.commands.meta import completion


def test_completion_includes_convert():
    # 回归(Codex P3)：新增 convert 顶层命令后，三种 shell 补全脚本都应包含它
    for shell in ("bash", "zsh", "fish"):
        assert "convert" in completion(shell), shell
