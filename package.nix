{ lib
, stdenv
, buildPackages
, git
, makeWrapper
, nodejs
, typescript
, doCheck ? true
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "piui";
  version = "0.1.0";

  src = lib.cleanSourceWith {
    src = ./.;
    filter = path: _:
      let
        keep = baseNameOf path;
        dropped = [ ".zig-cache" "zig-out" ".work" ".piui" "node_modules" "log.txt" "result" "tmp" ];
      in
      !(lib.elem keep dropped);
  };

  nativeBuildInputs =
    [ buildPackages.zig_0_17 makeWrapper ]
    ++ lib.optionals doCheck [ nodejs typescript git ];

  doCheck = doCheck;

  dontConfigure = true;

  buildPhase = ''
    runHook preBuild

    # The build cache has nowhere to live otherwise: HOME is read-only here.
    export ZIG_GLOBAL_CACHE_DIR="$TMPDIR/zig-global"
    export ZIG_LOCAL_CACHE_DIR="$TMPDIR/zig-local"

    zig build -Doptimize=ReleaseSafe --prefix "$out"

    runHook postBuild
  '';

  installPhase = ":";

  postInstall = ''
    wrapProgram "$out/bin/piui" --prefix PATH : ${lib.makeBinPath [ git ]}
  '';

  checkPhase = ''
    runHook preCheck

    export ZIG_GLOBAL_CACHE_DIR="$TMPDIR/zig-global"
    export ZIG_LOCAL_CACHE_DIR="$TMPDIR/zig-local"
    export HOME="$TMPDIR"

    zig build -Doptimize=ReleaseSafe test-zig
    node --test --test-timeout=15000 --test-force-exit web/test/*.test.js
    tsc --project web

    runHook postCheck
  '';

  meta = {
    description = "Small web front end for the pi coding agent";
    license = lib.licenses.gpl2Only;
    mainProgram = "piui";
    platforms = lib.platforms.linux;
  };
})
