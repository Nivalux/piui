{ lib
, stdenv
, buildPackages
, git
, makeWrapper
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

  nativeBuildInputs = [
    buildPackages.zig_0_17
    makeWrapper
  ];

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

  meta = {
    description = "Small web front end for the pi coding agent";
    license = lib.licenses.gpl2Only;
    mainProgram = "piui";
    platforms = lib.platforms.linux;
  };
})
