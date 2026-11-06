{ lib }:
let
  packageJson = builtins.fromJSON (builtins.readFile ../package.json);
  bunMatch = builtins.match "bun@([0-9]+\\.[0-9]+\\.[0-9]+)" packageJson.packageManager;
  nodeMatch = builtins.match "([0-9]+\\.[0-9]+\\.[0-9]+)[[:space:]]*" (builtins.readFile ../.node-version);
  goLine = lib.findFirst (line: lib.hasPrefix "go " line) "" (lib.splitString "\n" (builtins.readFile ../config_assistant/go.mod));
  goMatch = builtins.match "go ([0-9]+\\.[0-9]+\\.[0-9]+)" goLine;
  pins = {
    bun = if bunMatch == null then throw "packageManager must pin exact bun@major.minor.patch" else builtins.head bunMatch;
    node = if nodeMatch == null then throw ".node-version must pin exact Node major.minor.patch" else builtins.head nodeMatch;
    go = if goMatch == null then throw "go.mod must pin exact Go major.minor.patch" else builtins.head goMatch;
  };
in
{
  inherit pins;
  requireVersion = name: package:
    assert lib.assertMsg (package.version == pins.${name})
      "Repository requires ${name}@${pins.${name}}, but locked nixpkgs provides ${package.version}. Update the Nix input and regenerate nix/hashes.json on a Nix host; version checks must remain enabled.";
    package;
}
