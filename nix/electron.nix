# Official prebuilt Electron matching the desktop workspace pin. Archive SHA256s
# were checked against downloaded bytes, SHASUMS256.txt and release API digests.
{ lib, stdenvNoCC, fetchurl, unzip, makeWrapper, electron_45-bin ? null }:
let
  sources = builtins.fromJSON (builtins.readFile ./electron-sources.json);
  workspace = builtins.fromJSON (builtins.readFile ../packages/desktop/package.json);
  version = workspace.devDependencies.electron;
  archive = sources.sources.${stdenvNoCC.hostPlatform.system}
    or (throw "No verified Electron archive for ${stdenvNoCC.hostPlatform.system}");
  src = assert lib.assertMsg (version == sources.version)
    "Electron pin changed; verify official archive bytes and update nix/electron-sources.json first.";
    fetchurl {
      url = "https://github.com/electron/electron/releases/download/v${version}/${archive.file}";
      hash = archive.sha256;
    };
in
if stdenvNoCC.hostPlatform.isDarwin then stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "electron";
  inherit version src;
  nativeBuildInputs = [ unzip makeWrapper ];
  dontUnpack = true;
  dontBuild = true;
  installPhase = ''
    runHook preInstall
    mkdir -p $out/Applications $out/bin
    unzip $src
    mv Electron.app $out/Applications
    makeWrapper $out/Applications/Electron.app/Contents/MacOS/Electron $out/bin/electron
    runHook postInstall
  '';
  passthru.dist = "${finalAttrs.finalPackage}/Applications";
  meta = {
    description = "Official Electron binary for the desktop workspace";
    license = lib.licenses.mit;
    mainProgram = "electron";
    platforms = [ "x86_64-darwin" "aarch64-darwin" ];
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
  };
}) else assert lib.assertMsg (electron_45-bin != null) "nixpkgs must provide the Electron 45 Linux binary wrapper"; electron_45-bin.overrideAttrs (finalAttrs: old: {
  inherit version src;
  # Keep nixpkgs' Linux library paths, interpreter and graphics patching.
  passthru = old.passthru // {
    dist = "${finalAttrs.finalPackage}/libexec/electron";
    headers = throw "Desktop packaging uses the verified binary; Electron development headers are not provided.";
  };
})
