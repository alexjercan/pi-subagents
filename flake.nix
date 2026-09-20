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
        inherit (pkgs) lib;
        agents = inputs.llm-agents.packages.${system};
        manifest = lib.importJSON ./package.json;
        lock = lib.importJSON ./package-lock.json;
        runtimeManifest = builtins.removeAttrs manifest ["devDependencies"];
        runtimePackages = lib.filterAttrs (name: package:
          name == "" || !(package.dev or false))
        lock.packages;
        runtimeLock =
          lock
          // {
            packages =
              runtimePackages
              // {
                "" = builtins.removeAttrs runtimePackages."" ["devDependencies"];
              };
          };
        runtimeNpmRoot = pkgs.runCommand "pi-subagents-npm-root" {} ''
          mkdir -p "$out"
          cp ${pkgs.writeText "package.json" (builtins.toJSON runtimeManifest)} \
            "$out/package.json"
          cp ${pkgs.writeText "package-lock.json" (builtins.toJSON runtimeLock)} \
            "$out/package-lock.json"
        '';
        nodejs = pkgs.nodejs_24;
        nodeModules = pkgs.importNpmLock.buildNodeModules {
          npmRoot = runtimeNpmRoot;
          inherit nodejs;

          derivationArgs = {
            pname = "pi-subagents-node-modules";
            version = manifest.version;
            npmFlags = ["--legacy-peer-deps" "--omit=dev"];
          };
        };
        piSubagents =
          pkgs.runCommand "pi-subagents-${manifest.version}" {
            passthru = {
              inherit nodeModules;
              version = manifest.version;
              agentProfiles = ./examples/subagents.yaml;
            };
          } ''
            mkdir -p "$out"
            cp -R ${./extensions} "$out/extensions"
            cp -R ${./examples} "$out/examples"
            cp ${./package.json} "$out/package.json"
            cp ${./README.md} "$out/README.md"
            ln -s ${nodeModules}/node_modules "$out/node_modules"
          '';
        mcpPiSmokeExtension = pkgs.writeText "pi-subagents-mcp-smoke.ts" ''
          import { Client } from "${piSubagents}/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
          import { StreamableHTTPClientTransport } from "${piSubagents}/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js";
          import { createDelegationHost } from "${piSubagents}/extensions/pi-subagents/mcp.ts";

          export default function smoke(pi) {
            pi.on("session_start", async () => {
              const host = await createDelegationHost({
                start: async () => ({}),
                message: async () => undefined,
                list: async () => ({ kinds: [], runs: [] }),
                ask: async () => "answer",
              });
              const authorization = host.grant("smoke", []);
              const client = new Client({ name: "smoke", version: "1" });
              await client.connect(new StreamableHTTPClientTransport(
                new URL(host.url),
                { requestInit: { headers: { Authorization: authorization } } },
              ));
              await client.callTool({ name: "subagent_list", arguments: {} });
              await Promise.allSettled([
                client.close(),
                Promise.resolve(host.revoke(authorization)),
              ]);
              await host.close();
            });
          }
        '';
      in {
        formatter = pkgs.alejandra;

        packages = {
          default = piSubagents;
          pi-subagents = piSubagents;
        };

        devShells.default = pkgs.mkShell {
          packages = [
            nodejs
            agents.pi
            agents.claude-code
          ];
        };

        checks = {
          package =
            pkgs.runCommand "pi-subagents-package" {
              nativeBuildInputs = [nodejs pkgs.jq];
            } ''
              root=${piSubagents}
              test -f "$root/package.json"
              entry=$(jq -r '.pi.extensions[0]' "$root/package.json")
              test -f "$root/''${entry#./}"
              test -f ${piSubagents.agentProfiles}
              test -d "$root/node_modules/@modelcontextprotocol/sdk"
              test -d "$root/node_modules/yaml"
              test -d "$root/node_modules/zod"
              node --experimental-strip-types --input-type=module -e \
                "await import('$root/extensions/pi-subagents/mcp.ts')"
              touch "$out"
            '';

          mcp-pi-runtime =
            pkgs.runCommand "pi-subagents-mcp-pi-runtime" {
              nativeBuildInputs = [agents.pi];
            } ''
              export HOME="$TMPDIR/home"
              mkdir -p "$HOME"
              printf %s "" | pi --mode rpc --no-session --no-tools \
                --no-extensions --no-skills --no-context-files \
                --extension ${mcpPiSmokeExtension} \
                > "$TMPDIR/stdout" 2> "$TMPDIR/stderr"
              if grep -E 'extension_error|FakeSocket|stream is not readable' \
                "$TMPDIR/stdout" "$TMPDIR/stderr"; then
                cat "$TMPDIR/stdout" >&2
                cat "$TMPDIR/stderr" >&2
                exit 1
              fi
              touch "$out"
            '';

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
