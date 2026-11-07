#!/usr/bin/env python3
"""Collect real native Nix build evidence; never infer hashes from failed installs."""
import argparse
import base64
import json
import os
from pathlib import Path
import re
import shutil
import subprocess


def output_hash(log, derivation):
    pattern = (
        r"hash mismatch in fixed-output derivation ['\"]"
        + re.escape(derivation)
        + r"['\"]:\s*specified:\s*(sha256-[A-Za-z0-9+/=]+)\s*got:\s*(sha256-[A-Za-z0-9+/=]+)"
    )
    matches = re.findall(pattern, log)
    if len(matches) != 1:
        raise RuntimeError("Updater failed without exactly one hash mismatch for its own derivation")
    specified, actual = matches[0]
    if base64.b64decode(specified.removeprefix("sha256-"), validate=True) != bytes(32):
        raise RuntimeError("Updater must use lib.fakeHash; refusing an unrelated mismatch")
    if len(base64.b64decode(actual.removeprefix("sha256-"), validate=True)) != 32:
        raise RuntimeError("Nix reported an invalid SHA256")
    return actual


def reviewed_inputs(lock, expected, legacy):
    """Keep package pins and Nix's Bash input separate, resolving actual lock edges."""
    nodes = lock["nodes"]
    inputs = nodes[lock["root"]]["inputs"]
    if inputs.get("nixpkgs") != ["nixpkgs-darwin"]:
        raise RuntimeError("nix develop must resolve Bash from the supported Darwin input")
    unstable = nodes[inputs["nixpkgs-unstable"]]["locked"]
    darwin = nodes[inputs["nixpkgs-darwin"]]["locked"]
    if unstable["rev"] != expected:
        raise RuntimeError("flake.lock does not match the reviewed unstable nixpkgs revision")
    if darwin["rev"] != legacy:
        raise RuntimeError("Legacy Darwin input does not match the reviewed revision")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--system", required=True)
    parser.add_argument("--apply", action="store_true", help="Apply the measured native hash before acceptance builds")
    parser.add_argument("--evidence", default="nix-evidence")
    args = parser.parse_args()
    evidence = Path(args.evidence)
    evidence.mkdir(parents=True, exist_ok=True)

    def run(name, command):
        result = subprocess.run(command, text=True, capture_output=True)
        (evidence / (name + ".log")).write_text(result.stdout + result.stderr)
        print(result.stdout + result.stderr, flush=True)
        return result

    system = run("system", ["nix", "eval", "--impure", "--raw", "--expr", "builtins.currentSystem"])
    if system.returncode or system.stdout != args.system:
        raise RuntimeError("The runner must build its native platform; cross evaluation is not acceptance")
    expected = Path("nix/nixpkgs-revision").read_text().strip()
    lock = json.loads(Path("flake.lock").read_text())
    legacy = Path("nix/nixpkgs-darwin-revision").read_text().strip()
    reviewed_inputs(lock, expected, legacy)
    shutil.copyfile("flake.lock", evidence / "flake.lock")
    version_check = run("toolchain", ["nix", "develop", "--command", "node", "script/toolchain.mjs", "check", "--go"])
    if version_check.returncode:
        raise RuntimeError("The exact native Bun, Node and Go runtime check failed")
    drv = run("updater-derivation", ["nix", "eval", "--raw", ".#node_modules_updater.drvPath"])
    if drv.returncode:
        raise RuntimeError("Updater evaluation failed")
    probe = run("updater", ["nix", "build", ".#node_modules_updater", "--no-link", "--print-build-logs"])
    if probe.returncode == 0:
        raise RuntimeError("fakeHash updater unexpectedly succeeded")
    measured = output_hash(probe.stdout + probe.stderr, drv.stdout)
    hashes = json.loads(Path("nix/hashes.json").read_text())
    candidate = json.loads(json.dumps(hashes))
    candidate["nodeModules"][args.system] = measured
    (evidence / "hashes.json").write_text(json.dumps(candidate, indent=2) + "\n")
    (evidence / "measurement.json").write_text(json.dumps({
        "system": args.system, "source_commit": os.environ.get("GITHUB_SHA"),
        "nixpkgs_unstable_revision": expected, "nixpkgs_darwin_revision": legacy, "updater_derivation": drv.stdout,
        "node_modules_hash": measured, "applied": args.apply,
    }, indent=2) + "\n")
    if args.apply:
        Path("nix/hashes.json").write_text(json.dumps(candidate, indent=2) + "\n")
    elif hashes["nodeModules"].get(args.system) != measured:
        raise RuntimeError("Committed hash is stale; measured native candidate is in the evidence artifact")
    builds = run("packages", ["nix", "build", ".#graphagent", "--no-link", "--print-build-logs", "--json"])
    if builds.returncode:
        raise RuntimeError("Normal CLI derivation did not build")
    (evidence / "packages.json").write_text(builds.stdout)


if __name__ == "__main__":
    main()
