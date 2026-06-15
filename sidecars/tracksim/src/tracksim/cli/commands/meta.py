from __future__ import annotations

from typing import Any

from tracksim.manifest import build_manifest

VERSION = "0.1.0"


def version() -> tuple[str, dict[str, Any]]:
    return "meta.version", {
        "version": VERSION,
        "contract_version": build_manifest()["contract_version"],
    }


def manifest() -> tuple[str, dict[str, Any]]:
    return "meta.manifest", build_manifest()


def schema() -> tuple[str, dict[str, Any]]:
    m = build_manifest()
    commands = [
        {"operation_id": op["operation_id"], "summary": op["summary"]}
        for op in m["operations"]
    ]
    return "meta.schema", {"commands": commands}


_BASH = """\
# bash completion for tracksim
_tracksim_completions() {
  local cur="${COMP_WORDS[COMP_CWORD]}"
  local cmds="run send convert controllers config freed opentrackio manifest schema completion version"
  COMPREPLY=( $(compgen -W "${cmds}" -- "${cur}") )
}
complete -F _tracksim_completions tracksim
"""

_ZSH = """\
#compdef tracksim
_tracksim() {
  local -a cmds
  cmds=(run send convert controllers config freed opentrackio manifest schema completion version)
  _describe 'command' cmds
}
_tracksim "$@"
"""

_FISH = """\
# fish completion for tracksim
complete -c tracksim -f
for cmd in run send convert controllers config freed opentrackio manifest schema completion version
    complete -c tracksim -n __fish_use_subcommand -a $cmd
end
"""


def completion(shell: str) -> str:
    scripts = {"bash": _BASH, "zsh": _ZSH, "fish": _FISH}
    return scripts[shell]
