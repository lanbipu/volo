from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_gitignore_exists():
    assert (ROOT / ".gitignore").is_file()


def test_gitignore_covers_python():
    text = (ROOT / ".gitignore").read_text(encoding="utf-8")
    assert "__pycache__/" in text
    assert "*.egg-info/" in text


def test_readme_mentions_contract_version():
    text = (ROOT / "README.md").read_text(encoding="utf-8")
    assert "contract_version 1.0" in text


def test_changelog_mentions_contract_version():
    text = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    assert "contract_version 1.0" in text
