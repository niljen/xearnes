# Reconstruire le serveur Oracle de Xearnes

Contexte : le 11 novembre 2026, l'essai gratuit d'Oracle Cloud a pris fin. Le serveur (instance A1 de Stockholm) a été arrêté puis supprimé par le système d'Oracle (journal d'audit : arrêt le 11/11 à 11:09 UTC, suppression le 12/11 à 10:06 UTC). Perdu : les modèles Ollama, les fichiers du Workspace, la configuration. Gardé : le site, le Worker Cloudflare, RunPod, tout le code, la clé du portail, les données d'entraînement.

## Ce que fait le serveur
- **Ollama** avec `gemma3:4b` et `gemma3:1b` (réponses aux questions simples, personnelles ou d'identité).
- **Portail nginx** sur `127.0.0.1:8081` : seulement `POST /api/chat` et `/ws/`, seulement avec l'en-tête `X-Xearnes-Key`.
- **Service Workspace** (`workspace/server.py`) sur `127.0.0.1:8082`.
- **Tunnel cloudflared** (adresse temporaire en `trycloudflare.com`) qui redémarre tout seul.
- **Keep-alive** toutes les 15 minutes (petite génération locale).

## Ordre des opérations
1. Créer l'instance **Always Free** (`VM.Standard.A1.Flex`, 4 CPU, 24 Go, Ubuntu 22.04 aarch64, adresse IP publique) avec la clé publique `xearnes_v2.pub`.
2. Copier `setup.sh` et `../workspace/server.py` sur le serveur, puis lancer les étapes `base`, `ollama`, `workspace`, `tunnel`, `keepalive`, `status` (voir l'en-tête de `setup.sh`).
3. Étape `gate` : elle a besoin de la **même clé** que le secret `OLLAMA_AUTH_KEY` du Worker (fichier `~/.xearnes_oracle_gate_key` sur l'ordinateur). La clé ne doit jamais être affichée ni collée dans le chat.
4. Récupérer l'adresse du tunnel, puis mettre à jour le secret `OLLAMA_URL` du Worker (valeur : `<adresse>/api/chat`) et redéployer.
5. Tester : le chat, une question à information personnelle (doit rester sur Oracle), le Workspace.

## À garder en tête
- Un serveur **Always Free** peut être repris par Oracle s'il paraît inactif ou si le compte n'est pas utilisé : se connecter à la console de temps en temps. Le keep-alive aide.
- L'adresse du tunnel **change à chaque redémarrage** du service. Prévoir une adresse fixe avec HTTPS (par exemple `oracle.xearnes.com`) plus tard.
- Les étapes n'ont pas été testées sur un serveur neuf : les lancer une par une et vérifier avec `status`.
