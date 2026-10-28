{
  description = "OpenCode development flake";

  inputs = {
    # nix develop resolves Bash through this conventional input, including on Intel Darwin.
    nixpkgs.follows = "nixpkgs-darwin";
    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    nixpkgs-darwin.url = "github:NixOS/nixpkgs/nixpkgs-26.05-darwin";
  };

  outputs =
    { self, nixpkgs-unstable, nixpkgs-darwin, ... }:
    let
      nixpkgs = nixpkgs-unstable;
      systems = [
        "aarch64-linux"
        "x86_64-linux"
        "aarch64-darwin"
        "x86_64-darwin"
      ];
      forEachSystem = f: nixpkgs.lib.genAttrs systems (system:
        let input = if system == "x86_64-darwin" then nixpkgs-darwin else nixpkgs;
        in f (input.legacyPackages.${system}.extend toolchainOverlay));
      rev = self.shortRev or self.dirtyShortRev or "dirty";
      toolchain = import ./nix/toolchain.nix { inherit (nixpkgs) lib; };
      toolchainOverlay = final: prev: {
        # nixpkgs omits Intel Darwin although Bun still publishes its baseline binary.
        bun = if prev.stdenv.hostPlatform.system == "x86_64-darwin" then
          (toolchain.requireVersion "bun" (prev.callPackage "${nixpkgs}/pkgs/by-name/bu/bun/package.nix" { })).overrideAttrs (old: {
            src = final.fetchurl {
              url = "https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-darwin-x64-baseline.zip";
              hash = "sha256-1KFVrfv9CRVes7oFyeOlRPOSl9emhhbTx3WfZ6tcR9w=";
            };
            meta = old.meta // { platforms = old.meta.platforms ++ [ "x86_64-darwin" ]; };
          }) else prev.bun;
      };
    in
    {
      devShells = forEachSystem (pkgs: {
        default = pkgs.mkShell {
          packages = [
            (toolchain.requireVersion "bun" pkgs.bun)
            (toolchain.requireVersion "node" pkgs.nodejs_24)
            (toolchain.requireVersion "go" (pkgs.go_1_27 or pkgs.go))
            pkgs.pkg-config
            pkgs.openssl
            pkgs.git
          ];
          shellHook = ''
            export GOTOOLCHAIN=local
            node ${self}/script/toolchain.mjs check --go
          '';
        };
      });

      overlays = {
        default = nixpkgs.lib.composeManyExtensions [ toolchainOverlay (
          final: _prev:
          let
            node_modules = final.callPackage ./nix/node_modules.nix {
              inherit rev;
            };
          in
          rec {
            opencode = final.callPackage ./nix/opencode.nix {
              inherit node_modules;
            };
            opencode-desktop = final.callPackage ./nix/desktop.nix {
              inherit opencode;
            };
          }
        ) ];
      };

      packages = forEachSystem (
        pkgs:
        let
          node_modules = pkgs.callPackage ./nix/node_modules.nix {
            inherit rev;
          };
        in
        rec {
          default = opencode;
          opencode = pkgs.callPackage ./nix/opencode.nix {
            inherit node_modules;
          };
          opencode-desktop = pkgs.callPackage ./nix/desktop.nix {
            inherit opencode;
          };
          # Updater derivation with fakeHash - build fails and reveals correct hash
          node_modules_updater = node_modules.override {
            hash = pkgs.lib.fakeHash;
          };
        }
      );
    };
}
