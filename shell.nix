{ pkgs ? import <nixpkgs> { } }:

pkgs.mkShellNoCC {
  packages = with pkgs; [
    zig
    just
    nodejs_24
    typescript
    git
    ripgrep
    fd
    playwright
    chromium
  ];

  shellHook = ''
    # Keep the build cache inside the checkout: a clone of this project then
    # neither warms nor depends on a machine-wide zig cache.
    export ZIG_GLOBAL_CACHE_DIR="$PWD/.zig-cache/global"
    export PATH="$PWD/zig-out/bin:$PATH"

    # The browser tests drive this chromium through playwright-core instead of
    # downloading a private copy of a browser at test time.
    export PLAYWRIGHT_CORE="${pkgs.playwright}"
    export PIUI_CHROMIUM="${pkgs.chromium}/bin/chromium"
  '';
}
