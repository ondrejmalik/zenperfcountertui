#!/usr/bin/env python3
"""Shared PR size accounting and review warnings for an exact Git diff."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[2]
SOFT_CAP = 600
HARD_CAP = 900
LARGE = "size/large"
WAIVER = "size/architect-waiver"
PRODUCTION_PATH = re.compile(r"crates/[^/]+/src/.+\.rs\Z")
NON_PRODUCTION = re.compile(r"(?:^|/)(?:tests?|fixtures?|snapshots?)/|(?:^|/)(?:test_\w+|\w+_tests?)\.rs\Z")
HUNK = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@")
# A lightweight lexical filter for the warning. Match comments, strings and
# character literals before considering punctuation on a changed source line.
RUST_LITERAL_OR_COMMENT = re.compile(
    r'//[^\n]*|/\*.*?\*/|r(?P<hashes>\#*)"(?s:.*?)"(?P=hashes)'
    r'|"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])\'',
    re.DOTALL,
)


@dataclass(frozen=True)
class DiffSize:
    production: int
    other: int
    moved: int
    files: tuple[str, ...]
    warnings: tuple[str, ...]


def git(*args: str) -> str:
    return subprocess.run(
        ["git", "--literal-pathspecs", *args],
        cwd=ROOT, capture_output=True, check=True, encoding="utf-8", errors="replace",
    ).stdout


def is_production(path: str) -> bool:
    return bool(PRODUCTION_PATH.fullmatch(path) and not NON_PRODUCTION.search(path))


def size_tier(production: int) -> str:
    if production <= SOFT_CAP:
        return "standard"
    if production <= HARD_CAP:
        return "justification-required"
    return "architect-waiver-required"


def moved_line_count(removed: list[str | None], added: list[str | None], window: int = 3) -> int:
    # Match unchanged blocks once, even if the block appears multiple times.
    starts: dict[tuple[str | None, ...], list[int]] = {}
    for index in range(len(added) - window + 1):
        block = tuple(added[index:index + window])
        if None not in block and any(line and len(line) >= 3 for line in block):
            starts.setdefault(block, []).append(index)
    used = set()
    moved = 0
    index = 0
    while index <= len(removed) - window:
        best_start, best_length = 0, 0
        for start in starts.get(tuple(removed[index:index + window]), ()):
            length = 0
            while (
                index + length < len(removed)
                and start + length < len(added)
                and added[start + length] is not None
                and start + length not in used
                and removed[index + length] == added[start + length]
            ):
                length += 1
            if length >= window and length > best_length:
                best_start, best_length = start, length
        used.update(range(best_start, best_start + best_length))
        moved += best_length
        index += best_length or 1
    return moved * 2


def rust_warnings(path: str, source: str, added_lines: list[int]) -> list[str]:
    masked = RUST_LITERAL_OR_COMMENT.sub(
        lambda match: re.sub(r"[^\n]", " ", match.group()), source,
    ).split("\n")
    warnings = []
    for number in added_lines:
        line = masked[number - 1]
        if re.search(r"\bmacro_rules!\s*\w+", line):
            warnings.append(f"{path}:{number}: inspect new macro_rules! for line-count compression")
        # Array repeats and semicolons inside macro arguments are common Rust.
        # Inspect top-level statement semicolons on the changed line.
        depth = semicolons = 0
        for char in line:
            if char in "([":
                depth += 1
            elif char in ")]":
                depth = max(0, depth - 1)
            elif char == ";" and depth == 0:
                semicolons += 1
        if semicolons > 1:
            warnings.append(f"{path}:{number}: inspect multiple semicolons for compressed statements")
    return warnings


def measure_diff(base: str, head: str = "HEAD") -> DiffSize:
    start = git("merge-base", base, head).strip()
    args = (start, head, "--")
    changes = git("diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", *args)
    production = other = 0
    files: list[str] = []
    removed: list[str | None] = []
    added: list[str | None] = []
    warnings: list[str] = []
    for entry in filter(None, changes.split("\0")):
        inserts, deletes, path = entry.split("\t", 2)
        files.append(path)
        if inserts == "-":
            continue
        prod = is_production(path)
        if prod:
            production += int(inserts) + int(deletes)
        else:
            other += int(inserts) + int(deletes)
        if not path.endswith(".rs"):
            continue

        patch = git("diff", "--unified=0", "--no-renames", "--no-ext-diff", "--no-textconv", *args, path)
        added_lines: list[int] = []
        number = None
        for line in patch.split("\n"):
            if match := HUNK.match(line):
                number = int(match.group(1))
                if prod:
                    removed.append(None)
                    added.append(None)
            elif number is not None and line.startswith("+"):
                added_lines.append(number)
                number += 1
                if prod:
                    added.append(line[1:].strip())
            elif number is not None and line.startswith("-") and prod:
                removed.append(line[1:].strip())
        if added_lines:
            source = git("show", f"{head}:{path}")
            warnings.extend(rust_warnings(path, source, added_lines))

    moved = moved_line_count(removed, added)
    return DiffSize(production - moved, other, moved, tuple(files), tuple(warnings))
