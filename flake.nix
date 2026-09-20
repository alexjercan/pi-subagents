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

        checks.format =
          pkgs.runCommand "pi-subagents-format" {
            nativeBuildInputs = [pkgs.alejandra];
          } ''
            alejandra --check ${./flake.nix}
            touch $out
          '';
      };
    };
}
