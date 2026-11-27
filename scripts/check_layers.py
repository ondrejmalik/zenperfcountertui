#!/usr/bin/env python3
"""Enforce architectural layer dependency rules across workspace crates with a live negative control."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tomllib

if os.name == "nt":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[1]


def discover_rust_edges_toml(root: Path = ROOT) -> list[tuple[str, str]]:
    """Pure-Python fallback using workspace Cargo.toml files when cargo is unavailable."""
    ws_toml = root / "Cargo.toml"
    if not ws_toml.exists():
        return []
    ws_data = tomllib.loads(ws_toml.read_text(encoding="utf-8"))
    members = ws_data.get("workspace", {}).get("members", [])
    manifests: dict[str, dict] = {}
    for rel in members:
        manifest = root / rel / "Cargo.toml"
        if manifest.exists():
            data = tomllib.loads(manifest.read_text(encoding="utf-8"))
            name = data.get("package", {}).get("name")
            if name:
                manifests[name] = data

    ws_names = set(manifests.keys())
    edges: set[tuple[str, str]] = set()
    for src, data in manifests.items():
        for section in ("dependencies", "build-dependencies"):
            deps = data.get(section, {})
            if not isinstance(deps, dict):
                continue
            for dep_key, dep_val in deps.items():
                dst = dep_val.get("package", dep_key) if isinstance(dep_val, dict) else dep_key
                if dst in ws_names and dst != src:
                    edges.add((src, dst))
    return sorted(edges)


def discover_rust_edges(root: Path = ROOT) -> list[tuple[str, str]]:
    if not (root / "Cargo.toml").exists():
        return []
    if shutil.which("cargo"):
        res = subprocess.run(
            ["cargo", "metadata", "--no-deps", "--format-version", "1"],
            cwd=root,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        if res.returncode == 0:
            meta = json.loads(res.stdout)
            members = set(meta.get("workspace_members", []))
            ws_pkgs = [p for p in meta.get("packages", []) if p.get("id") in members]
            ws_names = {p["name"] for p in ws_pkgs}
            edges: set[tuple[str, str]] = set()
            for pkg in ws_pkgs:
                src = pkg["name"]
                for dep in pkg.get("dependencies", []):
                    if dep.get("kind") == "dev":
                        continue
                    dst = dep.get("name")
                    if dst in ws_names and dst != src:
                        edges.add((src, dst))
            return sorted(edges)
    return discover_rust_edges_toml(root)


def validate_graph(config: dict, edges: list[tuple[str, str]]) -> list[str]:
    pkg_layer: dict[str, str] = config.get("packages", {})
    rules: dict[str, list[str]] = config.get("rules", {})
    exceptions = {tuple(x) for x in config.get("allowed_exceptions", [])}
    errors: list[str] = []

    for src, dst in edges:
        if src == dst or (src, dst) in exceptions:
            continue
        if src not in pkg_layer:
            errors.append(f"unclassified package '{src}' missing from scripts/layers.json")
            continue
        if dst not in pkg_layer:
            errors.append(f"unclassified dependency '{dst}' missing from scripts/layers.json")
            continue
        src_layer = pkg_layer[src]
        dst_layer = pkg_layer[dst]
        if dst_layer == "tool" and src_layer != "tool":
            errors.append(f"shipped package '{src}' ({src_layer}) must not depend on tool package '{dst}'")
        elif dst_layer not in rules.get(src_layer, []):
            errors.append(
                f"layer violation: '{src}' ({src_layer}) -> '{dst}' ({dst_layer}); "
                f"'{src_layer}' may only depend on {rules.get(src_layer, [])}"
            )
    return errors


def negative_control() -> bool:
    sample_cfg = {
        "rules": {
            "core": ["core"],
            "platform": ["core", "platform"],
            "product": ["platform", "product"],
            "tool": ["core", "platform", "product", "tool"],
        },
        "packages": {"c": "core", "p": "platform", "app": "product", "t": "tool"},
        "allowed_exceptions": [],
    }
    bad_edges = [("c", "p"), ("app", "c"), ("p", "t")]
    return len(validate_graph(sample_cfg, bad_edges)) == 3


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=ROOT / "scripts/layers.json")
    parser.add_argument("--base", default=None)
    args = parser.parse_args()

    if not negative_control():
        print("check_layers: negative_control() failed to detect synthetic violations!", file=sys.stderr)
        return 1

    if not args.config.exists():
        print("check_layers: negative_control passed (no scripts/layers.json present yet).")
        return 0

    config = json.loads(args.config.read_text(encoding="utf-8"))
    declared = [tuple(e) for e in config.get("declared_edges", [])]
    discovered = discover_rust_edges(ROOT)
    edges = sorted(set(declared) | set(discovered))
    errors = validate_graph(config, edges)
    for err in errors:
        print(f"check_layers: {err}", file=sys.stderr)
    print(f"check_layers: {len(errors)} violation(s) across {len(edges)} edge(s); negative control passed.")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
