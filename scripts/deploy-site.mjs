// Deploys site/ (the homepage and the osu! login's server half) to the VPS behind
// fumen.dertesti.dev: files to ~/fumen-web, the systemd unit fumen-web, then a restart and a
// health check. The server's .env (with the osu! client secret) stays on the server: the first
// deploy creates it from .env.example without the secret, `--secret` fills it in.
//
//   node scripts/deploy-site.mjs            deploy
//   node scripts/deploy-site.mjs --secret   type the osu! client secret in on the server (hidden)
//
// SSH host: "vps" (~/.ssh/config), or VPS_HOST. sudo on the server asks for its password.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const host = process.env.VPS_HOST ?? "vps";
const dir = "fumen-web"; // in the home folder of the SSH user
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: "inherit" });
const remote = (script, tty = false) => run("ssh", [...(tty ? ["-t"] : []), host, script]);

if (process.argv.includes("--secret")) {
  remote(`bash ~/${dir}/set-secret.sh`, true);
  process.exit(0);
}

console.log(`→ files to ${host}:~/${dir}`);
remote(`mkdir -p ~/${dir} && rm -rf ~/${dir}/public`);
run("scp", ["-q", "-r", "site/server.mjs", "site/public", "site/.env.example", "site/fumen-web.service", "site/set-secret.sh", `${host}:${dir}/`]);

console.log("→ service");
remote(
  [
    "set -e",
    `cd ~/${dir}`,
    "[ -f .env ] || { cp .env.example .env; chmod 600 .env; echo '  .env created (no osu! secret yet: --secret)'; }",
    // the unit as committed, with this server's node and home folder
    `sed -e "s|/usr/bin/node|$(command -v node)|" -e "s|/home/dertesti/${dir}|$HOME/${dir}|g" -e "s|^User=.*|User=$(whoami)|" fumen-web.service > fumen-web.service.local`,
    "if ! cmp -s fumen-web.service.local /etc/systemd/system/fumen-web.service; then sudo install -m 644 fumen-web.service.local /etc/systemd/system/fumen-web.service && sudo systemctl daemon-reload && sudo systemctl enable fumen-web; fi",
    "sudo systemctl restart fumen-web",
    "sleep 1",
    "port=$(sed -n 's/^PORT=//p' .env)",
    'echo "  health: $(curl -s "http://127.0.0.1:${port:-3020}/health")"',
  ].join("\n"),
  true,
);
console.log("✓ deployed");
