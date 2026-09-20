{
  description = "Observable sub-agents for Pi";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
    llm-agents = {
      url = "github:numtide/llm-agents.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = inputs @ {flake-parts, ...}:
    flake-parts.lib.mkFlake {inherit inputs;} {
      systems = ["x86_64-linux" "aarch64-linux" "aarch64-darwin" "x86_64-darwin"];

      perSystem = {
        pkgs,
        system,
        ...
      }: let
        agents = inputs.llm-agents.packages.${system};
      in {
        formatter = pkgs.alejandra;

        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_24
            pkgs.tmux
            agents.pi
            agents.claude-code
          ];
        };

        checks = {
          format =
            pkgs.runCommand "pi-subagents-format" {
              nativeBuildInputs = [pkgs.alejandra];
            } ''
              alejandra --check ${./flake.nix}
              touch $out
            '';

          no-code-comments =
            pkgs.runCommand "pi-subagents-no-code-comments" {
              nativeBuildInputs = [pkgs.ripgrep];
              src = builtins.path {
                path = ./.;
                name = "pi-subagents-source";
              };
            } ''
              pattern='(^|[^:])//|/\*|\*/'
              printf '%s\n' 'const value = 1; // forbidden' > "$TMPDIR/comment-fixture.ts"
              rg --quiet "$pattern" "$TMPDIR/comment-fixture.ts"
              violations="$TMPDIR/violations"
              : > "$violations"
              while IFS= read -r -d "" file; do
                rg --line-number "$pattern" "$file" >> "$violations" || true
              done < <(find "$src" -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' -o -name '*.mjs' -o -name '*.cjs' \) -print0)
              if test -s "$violations"; then
                printf '%s\n' 'code comments are forbidden:' >&2
                cat "$violations" >&2
                exit 1
              fi
              touch $out
            '';
        };
      };
    };
}
