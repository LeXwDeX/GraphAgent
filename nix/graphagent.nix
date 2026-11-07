{
  lib,
  stdenvNoCC,
  callPackage,
  bun,
  nodejs_26,
  sysctl,
  makeBinaryWrapper,
  models-dev,
  ripgrep,
  installShellFiles,
  versionCheckHook,
  writableTmpDirAsHomeHook,
  node_modules ? callPackage ./node_modules.nix { },
}:
let
  toolchain = import ./toolchain.nix { inherit lib; };
in
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "graphagent";
  inherit (node_modules) version src;
  inherit node_modules;

  nativeBuildInputs = [
    (toolchain.requireVersion "bun" bun)
    (toolchain.requireVersion "node" nodejs_26) # for patchShebangs node_modules
    installShellFiles
    makeBinaryWrapper
    models-dev
    writableTmpDirAsHomeHook
  ];

  configurePhase = ''
    runHook preConfigure

    cp -R ${finalAttrs.node_modules}/. .
    patchShebangs node_modules
    patchShebangs packages/*/node_modules

    runHook postConfigure
  '';

  env.MODELS_DEV_API_JSON = "${models-dev}/dist/_api.json";
  env.GRAPHAGENT_DISABLE_MODELS_FETCH = true;
  env.GRAPHAGENT_VERSION = finalAttrs.version;
  env.GRAPHAGENT_CHANNEL = "dev";

  buildPhase = ''
    runHook preBuild
    node script/toolchain.mjs check

    cd ./packages/graphagent
    bun --bun ./script/build.ts --single --skip-install
    bun --bun ./script/schema.ts schema.json

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    install -Dm755 dist/graphagent-*/bin/graphagent $out/bin/graphagent
    install -Dm644 schema.json $out/share/graphagent/schema.json

    wrapProgram $out/bin/graphagent \
      --prefix PATH : ${
        lib.makeBinPath (
          [
            ripgrep
          ]
          # bun runs sysctl to detect if running on rosetta2
          ++ lib.optional stdenvNoCC.hostPlatform.isDarwin sysctl
        )
      }

    runHook postInstall
  '';

  postInstall = lib.optionalString (stdenvNoCC.buildPlatform.canExecute stdenvNoCC.hostPlatform) ''
    # trick yargs into also generating zsh completions
    installShellCompletion --cmd graphagent \
      --bash <($out/bin/graphagent completion) \
      --zsh <(SHELL=/bin/zsh $out/bin/graphagent completion)
  '';

  nativeInstallCheckInputs = [
    versionCheckHook
    writableTmpDirAsHomeHook
  ];
  doInstallCheck = true;
  versionCheckKeepEnvironment = [ "HOME" "GRAPHAGENT_DISABLE_MODELS_FETCH" ];
  versionCheckProgramArg = "--version";

  passthru = {
    jsonschema = "${placeholder "out"}/share/graphagent/schema.json";
    env = finalAttrs.env;
  };

  meta = {
    description = "The open source coding agent";
    homepage = "https://opencode.ai";
    license = lib.licenses.mit;
    mainProgram = "graphagent";
    inherit (node_modules.meta) platforms;
  };
})
