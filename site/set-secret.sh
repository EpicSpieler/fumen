#!/usr/bin/env bash
# Puts the osu! client secret into the site's .env on the server, typed in hidden (it never shows
# up on screen, in a shell history or anywhere else), then restarts the site.
#   node scripts/deploy-site.mjs --secret   (runs this on the VPS)
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { cp .env.example .env; chmod 600 .env; }

read -rsp "osu! client secret (osu.ppy.sh > Settings > OAuth > Fumen): " secret
echo
if ! [[ "$secret" =~ ^[A-Za-z0-9]{20,100}$ ]]; then
  echo "That doesn't look like an osu! client secret (letters and digits only). Nothing changed."
  exit 1
fi

# printf is a shell builtin: the secret never becomes a program's argument (visible in ps)
umask 077
{ grep -v '^OSU_CLIENT_SECRET=' .env || true; printf 'OSU_CLIENT_SECRET=%s\n' "$secret"; } > .env.new
mv .env.new .env
chmod 600 .env
unset secret

sudo systemctl restart fumen-web
sleep 1
port=$(sed -n 's/^PORT=//p' .env)
echo "site: $(curl -s "http://127.0.0.1:${port:-3020}/health")"
