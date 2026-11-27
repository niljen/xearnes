#!/usr/bin/env bash
# Reconstruit le serveur Oracle de Xearnes sur Ubuntu 22.04 (ARM, aarch64). À lancer en tant qu'utilisateur "ubuntu" (sudo sans mot de passe).
# Idempotent : on peut le relancer sans danger. PAS ENCORE TESTÉ sur un serveur neuf : lancer les étapes une par une et vérifier.
#
# Utilisation (depuis l'ordinateur, une étape à la fois) :
#   scp setup.sh ../workspace/server.py ubuntu@<IP>:~/
#   ssh ubuntu@<IP> 'bash setup.sh base'        # mises à jour, nginx, python
#   ssh ubuntu@<IP> 'bash setup.sh ollama'      # Ollama + modèles gemma3 4b et 1b (plusieurs minutes)
#   ssh ubuntu@<IP> 'bash setup.sh workspace'   # service des fichiers du Workspace
#   ssh ubuntu@<IP> 'bash setup.sh tunnel'      # cloudflared (tunnel rapide) démarré automatiquement
#   ssh ubuntu@<IP> 'bash setup.sh keepalive'   # petite activité régulière (évite qu'Oracle juge le serveur inactif)
#   ssh ubuntu@<IP> 'GATE_KEY=<48 caractères hexa> bash setup.sh gate'   # portail nginx (clé d'accès), voir README
#   scp tts_server.py ubuntu@<IP>:~/ ; ssh ubuntu@<IP> 'bash setup.sh tts'   # voix Kokoro
#   ssh ubuntu@<IP> 'bash setup.sh status'      # état de tout
set -euo pipefail
STEP="${1:-status}"
HOME_DIR="$HOME"

say() { printf '\n== %s\n' "$*"; }

step_base() {
  say "Mises à jour et paquets de base"
  sudo DEBIAN_FRONTEND=noninteractive apt-get update -y
  sudo DEBIAN_FRONTEND=noninteractive apt-get -y -o Dpkg::Options::=--force-confold upgrade
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nginx python3 curl ca-certificates unattended-upgrades
  # Le site par défaut de nginx n'est pas utilisé
  sudo rm -f /etc/nginx/sites-enabled/default
  sudo systemctl enable --now nginx
  # Pas de service inutile exposé (l'ancien serveur avait rpcbind)
  sudo systemctl disable --now rpcbind.socket rpcbind.service 2>/dev/null || true
}

step_ollama() {
  say "Ollama"
  if ! command -v ollama >/dev/null; then
    curl -fsSL https://ollama.com/install.sh | sh
  fi
  # Écoute seulement en local ; garde les modèles chargés (« Forever »)
  sudo mkdir -p /etc/systemd/system/ollama.service.d
  printf '[Service]\nEnvironment="OLLAMA_HOST=127.0.0.1:11434"\nEnvironment="OLLAMA_KEEP_ALIVE=-1"\nEnvironment="OLLAMA_MAX_LOADED_MODELS=2"\n' | sudo tee /etc/systemd/system/ollama.service.d/xearnes.conf >/dev/null
  sudo systemctl daemon-reload
  sudo systemctl enable --now ollama
  sleep 3
  ollama pull gemma3:4b
  ollama pull gemma3:1b
  ollama list
}

step_gate() {
  say "Portail nginx (127.0.0.1:8081, clé d'accès)"
  : "${GATE_KEY:?Donne GATE_KEY=<48 caractères hexadécimaux> (la même clé que le secret OLLAMA_AUTH_KEY du Worker)}"
  case "$GATE_KEY" in *[!0-9a-f]*|"") echo "clé invalide"; exit 1;; esac
  [ "${#GATE_KEY}" -eq 48 ] || { echo "la clé doit avoir 48 caractères"; exit 1; }
  printf 'map_hash_bucket_size 128;\nmap $http_x_xearnes_key $xearnes_key_ok {\n  default 0;\n  "%s" 1;\n}\n' "$GATE_KEY" | sudo tee /etc/nginx/conf.d/00-xearnes-key.conf >/dev/null
  sudo chmod 600 /etc/nginx/conf.d/00-xearnes-key.conf
  sudo tee /etc/nginx/conf.d/xearnes-ollama.conf >/dev/null <<'NGINX'
# Portail devant Ollama : seulement POST /api/chat et le Workspace /ws/, seulement avec la clé partagée. Tout le reste est refusé.
server {
    listen 127.0.0.1:8081 default_server;
    server_name _;
    client_max_body_size 256k;

    location = /api/chat {
        if ($xearnes_key_ok = 0) { return 403; }
        limit_except POST { deny all; }
        proxy_pass http://127.0.0.1:11434;
        proxy_http_version 1.1;
        proxy_set_header Host localhost:11434;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    location /ws/ {
        if ($xearnes_key_ok = 0) { return 403; }
        client_max_body_size 400k;
        rewrite ^/ws/(.*)$ /$1 break;
        proxy_pass http://127.0.0.1:8082;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_read_timeout 30s;
    }

    location = /tts {
        if ($xearnes_key_ok = 0) { return 403; }
        limit_except POST { deny all; }
        client_max_body_size 8k;
        proxy_pass http://127.0.0.1:8083;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_read_timeout 90s;
    }

    location / { return 404; }
}
NGINX
  sudo nginx -t
  sudo systemctl reload nginx
  GATE_KEY="" # ne pas laisser la clé dans l'environnement du script
  echo "portail prêt"
}

step_workspace() {
  say "Service du Workspace (fichiers des projets)"
  [ -f "$HOME_DIR/server.py" ] || { echo "copie d'abord server.py dans $HOME_DIR"; exit 1; }
  mkdir -p "$HOME_DIR/xearnes-workspace/data"
  cp "$HOME_DIR/server.py" "$HOME_DIR/xearnes-workspace/server.py"
  sudo tee /etc/systemd/system/xearnes-workspace.service >/dev/null <<UNIT
[Unit]
Description=Xearnes Workspace (projets et fichiers des agents)
After=network.target

[Service]
User=$USER
WorkingDirectory=$HOME_DIR/xearnes-workspace
Environment=XW_DATA=$HOME_DIR/xearnes-workspace/data
Environment=XW_PORT=8082
ExecStart=/usr/bin/python3 $HOME_DIR/xearnes-workspace/server.py
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$HOME_DIR/xearnes-workspace
MemoryMax=300M
TasksMax=64

[Install]
WantedBy=multi-user.target
UNIT
  sudo systemctl daemon-reload
  sudo systemctl enable --now xearnes-workspace
  sleep 1
  curl -s http://127.0.0.1:8082/health; echo
}

step_tunnel() {
  say "Tunnel cloudflared (adresse temporaire, redémarre tout seul)"
  if ! command -v cloudflared >/dev/null; then
    sudo curl -fsSL -o /usr/local/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64
    sudo chmod +x /usr/local/bin/cloudflared
  fi
  sudo tee /etc/systemd/system/cloudflared-quick.service >/dev/null <<'UNIT'
[Unit]
Description=Cloudflare quick tunnel vers le portail Xearnes
After=network-online.target nginx.service
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8081 --logfile /var/log/cloudflared-quick.log
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
  sudo systemctl daemon-reload
  sudo systemctl enable --now cloudflared-quick
  for i in $(seq 1 30); do
    URL=$(sudo grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' /var/log/cloudflared-quick.log 2>/dev/null | tail -1 || true)
    [ -n "$URL" ] && break
    sleep 2
  done
  echo "Adresse du tunnel : ${URL:-<introuvable : regarde /var/log/cloudflared-quick.log>}"
  echo "Dans le Worker, OLLAMA_URL doit valoir : ${URL:-<adresse>}/api/chat"
}

step_keepalive() {
  say "Activité régulière (évite qu'Oracle considère le serveur comme inactif)"
  sudo tee /usr/local/bin/xearnes-keepalive.sh >/dev/null <<'SH'
#!/usr/bin/env bash
# Une petite génération locale : garde le modèle chargé et un peu de processeur utilisé
curl -s -m 120 http://127.0.0.1:11434/api/generate -d '{"model":"gemma3:1b","prompt":"Dis bonjour en un mot.","stream":false,"options":{"num_predict":8}}' >/dev/null || true
SH
  sudo chmod +x /usr/local/bin/xearnes-keepalive.sh
  sudo tee /etc/systemd/system/xearnes-keepalive.service >/dev/null <<'UNIT'
[Unit]
Description=Xearnes keep-alive
[Service]
Type=oneshot
ExecStart=/usr/local/bin/xearnes-keepalive.sh
UNIT
  sudo tee /etc/systemd/system/xearnes-keepalive.timer >/dev/null <<'UNIT'
[Unit]
Description=Xearnes keep-alive toutes les 15 minutes
[Timer]
OnBootSec=5min
OnUnitActiveSec=15min
[Install]
WantedBy=timers.target
UNIT
  sudo systemctl daemon-reload
  sudo systemctl enable --now xearnes-keepalive.timer
}

step_tts() {
  say "Voix Kokoro (127.0.0.1:8083) pour en, fr, es, it, pt"
  [ -f "$HOME_DIR/tts_server.py" ] || { echo "copie d'abord tts_server.py dans $HOME_DIR"; exit 1; }
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q espeak-ng python3-venv >/dev/null
  mkdir -p "$HOME_DIR/kokoro" && cd "$HOME_DIR/kokoro"
  [ -d venv ] || python3 -m venv venv
  ./venv/bin/pip install -q kokoro-onnx soundfile
  B=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0
  [ -f kokoro-v1.0.onnx ] || curl -sfL -o kokoro-v1.0.onnx $B/kokoro-v1.0.onnx
  [ -f voices-v1.0.bin ] || curl -sfL -o voices-v1.0.bin $B/voices-v1.0.bin
  cp "$HOME_DIR/tts_server.py" "$HOME_DIR/kokoro/tts_server.py"
  sudo tee /etc/systemd/system/xearnes-tts.service >/dev/null <<UNIT
[Unit]
Description=Xearnes voix Kokoro (127.0.0.1:8083)
After=network.target

[Service]
User=$USER
WorkingDirectory=$HOME_DIR/kokoro
ExecStart=$HOME_DIR/kokoro/venv/bin/python $HOME_DIR/kokoro/tts_server.py
Environment=OMP_NUM_THREADS=2
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
MemoryMax=1500M
TasksMax=64

[Install]
WantedBy=multi-user.target
UNIT
  sudo systemctl daemon-reload
  sudo systemctl enable --now xearnes-tts
  sleep 5; curl -s http://127.0.0.1:8083/health; echo
}

step_status() {
  say "État"
  echo "uptime: $(uptime -p)"
  echo "disque: $(df -h / | tail -1 | awk '{print $5" utilisé, "$4" libre"}')"
  echo "mémoire: $(free -h | sed -n 2p | awk '{print $3"/"$2}')"
  for s in nginx ollama xearnes-workspace xearnes-tts cloudflared-quick xearnes-keepalive.timer; do echo "$s: $(systemctl is-active $s 2>&1)"; done
  echo "modèles:"; ollama list 2>/dev/null | head -5 || true
  echo "tunnel: $(sudo grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' /var/log/cloudflared-quick.log 2>/dev/null | tail -1)"
  echo "portail sans clé -> $(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:8081/api/chat -d '{}') (403 attendu)"
}

case "$STEP" in
  base) step_base ;;
  ollama) step_ollama ;;
  gate) step_gate ;;
  workspace) step_workspace ;;
  tunnel) step_tunnel ;;
  keepalive) step_keepalive ;;
  tts) step_tts ;;
  status) step_status ;;
  *) echo "étapes : base | ollama | gate | workspace | tunnel | keepalive | tts | status"; exit 1 ;;
esac
