{ pkgs ? import <nixpkgs> { } }:

pkgs.mkShellNoCC {
  packages = with pkgs; [
    zig
    just
    nodejs_24
    typescript
    biome
    git
    ripgrep
    fd
    playwright
    chromium
    fontconfig
    dejavu_fonts
    noto-fonts-color-emoji
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
    export FONTCONFIG_FILE="${pkgs.writeText "piui-fonts.conf" ''
      <?xml version="1.0"?>
      <fontconfig>
        <dir>${pkgs.dejavu_fonts}/share/fonts</dir>
        <dir>${pkgs.noto-fonts-color-emoji}/share/fonts</dir>
        <cachedir prefix="xdg">fontconfig</cachedir>
      </fontconfig>
    ''}"
    export PI_MONOREPO="${pkgs.pi-coding-agent}/lib/node_modules/pi-monorepo"
  '';
}
