/**
 * GUIDE-MCP-WEB.md  –  Guide de déploiement du serveur MCP HTTP pour ChatGPT web
 *
 * Ce fichier est un guide en prose — copiez son contenu dans un vrai .md si besoin.
 */

/*
═══════════════════════════════════════════════════════════════════════════════
  GUIDE DE DÉPLOIEMENT MCP HTTP — ChatGPT Web (Pro / Plus / Business)
  proxy-avocat v4.3.2
═══════════════════════════════════════════════════════════════════════════════

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  STRUCTURE DU PROJET APRÈS CETTE MISE À JOUR
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  proxy-avocat/
  ├── lib/
  │   └── tools.js        ← logique partagée (TOOLS + handleTool + OAuth)
  ├── mcp.js              ← transport stdio  (Claude Desktop + ChatGPT Desktop)
  ├── mcp-http.js         ← transport HTTP/SSE  (ChatGPT web)
  ├── server.js           ← proxy Express existant (inchangé)
  ├── package.json
  └── .env


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ÉTAPE 1 — PRÉREQUIS LOCAUX
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  1.1  Vérifier la version de Node

    node --version          # doit afficher v18.x ou supérieur

  1.2  Installer les dépendances

    npm install

    Le package.json inclut désormais :
      "@modelcontextprotocol/sdk": "^1.10.2"
      "express": "^4.21.2"
      "cors": "^2.8.5"

  1.3  Créer le fichier .env

    Copiez et remplissez :

    ┌─────────────────────────────────────────────────────┐
    │ LF_CLIENT_ID=votre_client_id_piste                  │
    │ LF_CLIENT_SECRET=votre_client_secret_piste          │
    │                                                     │
    │ # Judilibre (optionnel, reprend LF_* si absent)     │
    │ # JD_CLIENT_ID=votre_client_id_judilibre            │
    │ # JD_CLIENT_SECRET=votre_client_secret_judilibre    │
    │                                                     │
    │ USE_SANDBOX=true      # false = production PISTE    │
    │ MCP_PORT=3001                                       │
    │ MCP_SECRET=un_token_secret_long_et_aléatoire        │
    │ LOG_LEVEL=info                                      │
    └─────────────────────────────────────────────────────┘

    Pour générer MCP_SECRET :
      node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

  1.4  Tester le démarrage local

    node --env-file=.env mcp-http.js

    Vous devez voir :
      [INF] proxy-avocat MCP HTTP v4.3.2
      [INF] Mode    : SANDBOX
      [INF] Port    : 3001
      [INF] SSE     : http://localhost:3001/sse
      [INF] Health  : http://localhost:3001/health

  1.5  Vérifier le endpoint de santé

    curl http://localhost:3001/health

    Réponse attendue :
      { "ok": true, "service": "proxy-avocat-mcp-http", "sandbox": true, "sessions": 0 }


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ÉTAPE 2 — TEST LOCAL AVEC NGROK (avant déploiement)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Ngrok crée un tunnel HTTPS public vers votre localhost.
  Utile pour tester ChatGPT web sans payer d'hébergement.

  2.1  Installer ngrok

    npm install -g ngrok
    # ou sur macOS avec Homebrew :
    brew install ngrok/ngrok/ngrok

  2.2  S'inscrire sur ngrok.com et configurer le token

    ngrok config add-authtoken VOTRE_TOKEN_NGROK

  2.3  Lancer ngrok en parallèle du serveur MCP

    Terminal 1 :
      node --env-file=.env mcp-http.js

    Terminal 2 :
      ngrok http 3001

    Ngrok affiche une URL publique, par exemple :
      https://a1b2c3d4.ngrok-free.app

  2.4  Tester la connectivité depuis internet

    curl https://a1b2c3d4.ngrok-free.app/health

    Réponse attendue : { "ok": true, ... }

  ⚠  ATTENTION SÉCURITÉ : avec ngrok gratuit, l'URL change à chaque redémarrage.
     Définissez MCP_SECRET dans votre .env pour que seul ChatGPT puisse appeler le serveur.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ÉTAPE 3 — DÉPLOIEMENT EN PRODUCTION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ChatGPT exige une URL HTTPS fixe et accessible 24h/24.
  Trois options classées par facilité.

  ──────────────────────────────────────
  OPTION A — Railway  (recommandé, le plus simple)
  ──────────────────────────────────────

  Railway déploie automatiquement depuis GitHub.

  A1. Créer un compte sur https://railway.app

  A2. Pousser votre code sur GitHub
      git init
      git add .
      git commit -m "feat: MCP HTTP server"
      git remote add origin https://github.com/VOUS/proxy-avocat.git
      git push -u origin main

  A3. Nouveau projet Railway
      → "New Project" → "Deploy from GitHub repo"
      → Sélectionner votre dépôt

  A4. Définir la commande de démarrage
      Dans Settings → Deploy → Start Command :
        node mcp-http.js

  A5. Définir les variables d'environnement
      Dans la section Variables, ajouter :

        LF_CLIENT_ID          = votre_valeur
        LF_CLIENT_SECRET      = votre_valeur
        USE_SANDBOX           = false          ← production PISTE
        MCP_PORT              = 3001
        MCP_SECRET            = votre_token_secret
        LOG_LEVEL             = info

  A6. Générer le domaine public
      Settings → Networking → Generate Domain
      → Vous obtenez : https://proxy-avocat-production.up.railway.app

  A7. Vérifier
      curl https://proxy-avocat-production.up.railway.app/health


  ──────────────────────────────────────
  OPTION B — Render  (gratuit avec limitations)
  ──────────────────────────────────────

  B1. Créer un compte sur https://render.com

  B2. "New Web Service" → connecter votre dépôt GitHub

  B3. Configurer :
      - Build Command  : npm install
      - Start Command  : node mcp-http.js
      - Plan           : Free (suffisant pour tests, s'endort après 15 min d'inactivité)

  B4. Variables d'environnement : mêmes qu'en option A

  B5. URL générée : https://proxy-avocat.onrender.com

  ⚠  Le plan gratuit Render met le serveur en veille après 15 min d'inactivité.
     La première connexion SSE peut prendre 30 s (réveil du serveur).
     Pour un usage permanent, utiliser le plan Starter (~7$/mois).


  ──────────────────────────────────────
  OPTION C — VPS (contrôle total)
  ──────────────────────────────────────

  Pour un VPS OVH, Scaleway, Hetzner ou équivalent avec Ubuntu 22.04.

  C1. Connexion SSH
      ssh user@IP_SERVEUR

  C2. Installer Node 18+
      curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
      sudo apt-get install -y nodejs

  C3. Copier le projet (via git ou scp)
      git clone https://github.com/VOUS/proxy-avocat.git
      cd proxy-avocat
      npm install

  C4. Créer le fichier .env sur le serveur
      nano .env
      # Remplir avec les vraies valeurs

  C5. Installer et configurer PM2 (gestionnaire de processus)
      npm install -g pm2
      pm2 start mcp-http.js --name proxy-avocat-mcp
      pm2 save
      pm2 startup   # active le démarrage automatique

  C6. Configurer Nginx comme reverse proxy avec HTTPS (via Let's Encrypt)

      sudo apt install -y nginx certbot python3-certbot-nginx

      Créer /etc/nginx/sites-available/mcp :
      ┌──────────────────────────────────────────────────────┐
      │ server {                                             │
      │     listen 80;                                       │
      │     server_name mcp.votre-domaine.com;              │
      │                                                      │
      │     location / {                                     │
      │         proxy_pass         http://localhost:3001;    │
      │         proxy_http_version 1.1;                      │
      │         proxy_set_header   Upgrade $http_upgrade;    │
      │         proxy_set_header   Connection keep-alive;    │
      │         proxy_set_header   Host $host;               │
      │         proxy_cache_bypass $http_upgrade;            │
      │                                                      │
      │         # SSE : désactiver le buffering              │
      │         proxy_buffering    off;                      │
      │         proxy_read_timeout 86400s;                   │
      │         proxy_send_timeout 86400s;                   │
      │     }                                                │
      │ }                                                    │
      └──────────────────────────────────────────────────────┘

      sudo ln -s /etc/nginx/sites-available/mcp /etc/nginx/sites-enabled/
      sudo nginx -t
      sudo systemctl reload nginx
      sudo certbot --nginx -d mcp.votre-domaine.com

      URL finale : https://mcp.votre-domaine.com


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ÉTAPE 4 — CONFIGURER CHATGPT WEB
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  4.1  Compte requis
       ChatGPT Pro, Plus, Business, Enterprise ou Education.

  4.2  Activer Developer Mode
       → chatgpt.com → icône profil (en bas à gauche)
       → Paramètres (Settings)
       → Onglet "Connected apps" ou "Connectors"
       → "Advanced"
       → Activer "Developer mode"

  4.3  Ajouter le connecteur MCP
       → "Add custom connector" ou "Add MCP server"
       → Remplir les champs :

         Name        : proxy-avocat (ou "Légifrance + Judilibre")
         URL (SSE)   : https://votre-domaine.com/sse
         Auth type   : Bearer token
         Token       : la valeur de MCP_SECRET

       → Cliquer "Connect" ou "Save"

  4.4  Activer les tools dans la conversation
       → Dans une conversation, cliquer sur l'icône d'outils (⚙ ou puzzle)
       → Sélectionner "proxy-avocat"
       → Les 17 tools apparaissent dans la liste

  4.5  Tester
       Tapez dans le chat :
         "Recherche la jurisprudence récente sur la faute inexcusable de l'employeur"
       ChatGPT doit invoquer lf_search ou jd_search et afficher les résultats.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ÉTAPE 5 — SÉCURITÉ EN PRODUCTION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  5.1  Toujours définir MCP_SECRET
       Sans ce token, n'importe qui connaissant l'URL peut appeler vos APIs PISTE.
       ChatGPT envoie le token dans l'en-tête Authorization: Bearer <token>.

  5.2  Utiliser HTTPS obligatoirement
       ChatGPT refuse les URLs en HTTP. Let's Encrypt (certbot) est gratuit.

  5.3  Rate limiting (optionnel mais recommandé)
       Ajoutez express-rate-limit pour limiter les appels par IP :

         npm install express-rate-limit

       Dans mcp-http.js, avant les routes :
         const rateLimit = require('express-rate-limit');
         app.use(rateLimit({ windowMs: 60_000, max: 100 }));

  5.4  Ne jamais committer .env
       Vérifiez que .env est dans .gitignore :
         echo ".env" >> .gitignore

  5.5  Rotation des secrets
       Si MCP_SECRET est compromis, changez-le dans les variables d'environnement
       et mettez à jour le connecteur dans ChatGPT Settings.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  RÉSOLUTION DES PROBLÈMES COURANTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ❌ "Session inconnue ou expirée"
     → La connexion SSE s'est interrompue. ChatGPT doit se reconnecter.
     → Vérifiez que proxy_read_timeout est bien à 86400s dans Nginx.

  ❌ "Unauthorized — Bearer token invalide"
     → MCP_SECRET ne correspond pas au token configuré dans ChatGPT.
     → Vérifiez les variables d'environnement sur le serveur.

  ❌ ChatGPT n'affiche pas les tools
     → Cliquez "Refresh" dans le connecteur (ChatGPT recharge la liste des tools).
     → Vérifiez que /sse répond bien avec Content-Type: text/event-stream.

  ❌ "OAuth 401" dans les logs serveur
     → LF_CLIENT_ID ou LF_CLIENT_SECRET incorrects.
     → Vérifiez sur https://developer.aife.economie.gouv.fr (PISTE).

  ❌ Le serveur Render se réveille lentement
     → Normal sur le plan gratuit. Upgrade vers Starter ou utiliser Railway.

  ❌ Ngrok : "ERR_NGROK_3200 Tunnel not found"
     → L'URL ngrok a changé (redémarrage). Mettez à jour le connecteur ChatGPT.
     → Solution permanente : utiliser un domaine fixe (Railway/Render/VPS).


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  RÉCAPITULATIF DES COMMANDES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  # Installation
  npm install

  # Test local
  node --env-file=.env mcp-http.js
  curl http://localhost:3001/health

  # Tunnel temporaire pour ChatGPT web
  npx ngrok http 3001

  # Démarrage en production (PM2)
  pm2 start mcp-http.js --name proxy-avocat-mcp --env production
  pm2 logs proxy-avocat-mcp
  pm2 restart proxy-avocat-mcp

  # Vérifier l'endpoint SSE manuellement
  curl -N -H "Authorization: Bearer VOTRE_SECRET" \
       https://votre-domaine.com/sse


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ARCHITECTURE FINALE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ┌──────────────────┐     stdio      ┌──────────────┐
  │  Claude Desktop  │ ─────────────► │   mcp.js     │
  └──────────────────┘                └──────┬───────┘
                                             │
  ┌──────────────────┐     stdio             │  require
  │ ChatGPT Desktop  │ ─────────────► mcp.js │  ('./lib/tools.js')
  └──────────────────┘                       │
                                             ▼
  ┌──────────────────┐   HTTPS/SSE   ┌──────────────┐
  │  ChatGPT web     │ ─────────────► │ mcp-http.js  │
  │  (Pro/Plus/Biz)  │               └──────┬───────┘
  └──────────────────┘                      │
                                            ▼
                                   ┌──────────────────┐
                                   │  lib/tools.js    │
                                   │  (logique commune)│
                                   └──────┬───────────┘
                                          │
                          ┌───────────────┴──────────────┐
                          ▼                               ▼
                 ┌─────────────────┐           ┌──────────────────┐
                 │  API Légifrance │           │  API Judilibre   │
                 │  (PISTE OAuth2) │           │  (PISTE OAuth2)  │
                 └─────────────────┘           └──────────────────┘
*/
