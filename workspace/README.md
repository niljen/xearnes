# Xearnes Workspace (version 0)

Espace privé où une équipe d'agents IA (Planificateur, Codeur, Relecteur, Cybersécurité, Débogueur, Datasets, RGPD)
travaille sur des projets dont les fichiers sont stockés sur le serveur Oracle.

## Pièces
- `workspace.html` (à la racine du site, noindex) : l'interface (téléphone et ordinateur). Connexion par code email.
  L'enchaînement des agents se fait dans le navigateur ; chaque appel de modèle passe par le Worker.
- `cloudflare-worker/workspace.js` : routes `/ws/*` (relais vers Oracle) et `/ws-llm` (appel d'un modèle).
  Accès = jeton de connexion valide ET adresse dans la variable `WS_ALLOWED` (wrangler.toml, séparées par des virgules).
  Plafond d'appels de modèles par jour : `WS_DAILY_CALLS` (150 par défaut). Les réveils de GPU partagent le budget `RUNPOD_DAILY_WAKES*`.
- `workspace/server.py` : service de fichiers sur Oracle (Python standard, 127.0.0.1:8082, aucune commande exécutée).
  Installé dans `/home/ubuntu/xearnes-workspace/`, service systemd `xearnes-workspace`, données dans `data/`.
- nginx (Oracle) : `location /ws/` dans `/etc/nginx/conf.d/xearnes-ollama.conf`, protégé par la même clé d'accès que le chat.

## Règles de sécurité
- Aucun agent n'exécute de code ni de commande. Les fichiers proposés arrivent dans « Changements proposés » et ne sont écrits qu'après validation.
- Chemins de fichiers : segments simples, 4 niveaux, pas de `..`. Limites : 200 Ko par fichier, 5 Mo et 200 fichiers par projet, 30 projets.
- Le service Oracle n'est joignable que par nginx (clé) ; la clé n'est connue que de nginx et du Worker.
- Pas d'API commerciale branchée : il faut le compte, la clé et l'accord de ton père, et leurs conditions interdisent d'entraîner un modèle avec leurs réponses.

## Mettre à jour
- Service Oracle : copier `server.py` puis `sudo systemctl restart xearnes-workspace`.
- Ajouter une adresse : modifier `WS_ALLOWED` dans `cloudflare-worker/wrangler.toml`, puis `npx wrangler deploy`.

## Ajouts (2026-11-01)
- **Mémoire Xearnes** : projet réservé `memoire`, fichier `xearnes.md` (créé automatiquement avec un texte de départ). Elle est ajoutée aux consignes de TOUS les agents (8000 caractères max). Bouton « 🧠 Mémoire Xearnes » pour la lire et la modifier : les agents voient les changements au lancement suivant. Ne jamais y mettre de clé ni de donnée personnelle.
- **Équipes Architecture IA et Économie** : Architecte ou Économiste, puis Critique ; le résultat arrive en proposition (`ARCHITECTURE.md`, `ECONOMIE.md`). L'Économiste ne donne aucun conseil d'investissement, juridique ou fiscal.
- **API pour le code, l'architecture et l'économie** (jamais les datasets : refusé par le Worker) : fournisseurs `openai`, `mistral`, `openrouter`, `anthropic`.
  Un fournisseur n'apparaît que si le secret `WS_KEY_<NOM>` ET la variable `WS_MODEL_<NOM>` sont configurés (clé : `npx wrangler secret put WS_KEY_OPENAI` depuis un fichier, jamais dans le chat ; modèle : variable dans wrangler.toml).
  Plafond : `WS_API_DAILY_CALLS` appels par jour (60 par défaut). Sans compteur KV, aucun appel API n'est fait.
  Un adulte crée le compte et la clé (idéalement avec une limite de dépense) et accepte les conditions du fournisseur.
- **GitHub** : un jeton « fine-grained » créé par un adulte (compte GitHub à partir de 13 ans), limité à UN dépôt, permission « Contents : lecture et écriture ». Il se colle dans la page (rubrique GitHub), reste sur l'appareil et n'est envoyé qu'à api.github.com. « Envoyer » écrit les fichiers du projet dans le dépôt, « Importer » récupère les fichiers texte (100 Ko max chacun, 60 max).
