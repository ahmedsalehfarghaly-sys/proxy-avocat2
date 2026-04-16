/**
 * lib/tools.js  –  Logique partagée entre mcp.js (stdio) et mcp-http.js (SSE)
 *
 * Exporte :
 *   TOOLS         – définitions JSON Schema des tools MCP
 *   handleTool    – exécution d'un tool (prend name + args, retourne un objet)
 *   initConfig    – à appeler au démarrage avec les variables d'env
 */

'use strict';

// ─── Config PISTE (initialisée par initConfig) ────────────────────────────────

let LF_BASE, JD_BASE, OAUTH_URL;
let LF_CLIENT_ID, LF_CLIENT_SECRET, JD_CLIENT_ID, JD_CLIENT_SECRET;

function initConfig() {
  const USE_SANDBOX = process.env.USE_SANDBOX !== 'false';

  LF_BASE   = USE_SANDBOX
    ? 'https://sandbox-api.piste.gouv.fr/dila/legifrance/lf-engine-app'
    : 'https://api.piste.gouv.fr/dila/legifrance/lf-engine-app';

  JD_BASE   = USE_SANDBOX
    ? 'https://sandbox-api.piste.gouv.fr/cassation/judilibre/v1.0'
    : 'https://api.piste.gouv.fr/cassation/judilibre/v1.0';

  OAUTH_URL = USE_SANDBOX
    ? 'https://sandbox-oauth.piste.gouv.fr/api/oauth/token'
    : 'https://oauth.piste.gouv.fr/api/oauth/token';

  LF_CLIENT_ID     = process.env.LF_CLIENT_ID     || '';
  LF_CLIENT_SECRET = process.env.LF_CLIENT_SECRET || '';
  JD_CLIENT_ID     = process.env.JD_CLIENT_ID     || LF_CLIENT_ID;
  JD_CLIENT_SECRET = process.env.JD_CLIENT_SECRET || LF_CLIENT_SECRET;

  return { USE_SANDBOX, LF_BASE, JD_BASE };
}

// ─── Token cache ──────────────────────────────────────────────────────────────

const _tokens = {};

async function getToken(clientId, clientSecret) {
  if (!clientId || !clientSecret)
    throw new Error('Identifiants API manquants — vérifiez LF_CLIENT_ID / LF_CLIENT_SECRET');
  const now    = Date.now();
  const cached = _tokens[clientId];
  if (cached && cached.expiresAt > now + 15_000) return cached.token;
  const res = await fetch(OAUTH_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type: 'client_credentials', client_id: clientId,
      client_secret: clientSecret, scope: 'openid',
    }).toString(),
  });
  if (!res.ok) throw new Error('OAuth ' + res.status + ': ' + await res.text());
  const data = await res.json();
  _tokens[clientId] = { token: data.access_token, expiresAt: now + (data.expires_in ?? 3600) * 1000 };
  return data.access_token;
}

// ─── Retry ────────────────────────────────────────────────────────────────────

const RETRY_STATUSES = new Set([429, 503]);
const RETRY_DELAYS   = [500, 1500, 4000];

async function fetchWithRetry(url, options, clientId, clientSecret) {
  let attempt = 0;
  while (true) {
    const res = await fetch(url, options);
    if (res.status === 401 && attempt === 0) {
      delete _tokens[clientId];
      const t = await getToken(clientId, clientSecret);
      options = { ...options, headers: { ...options.headers, Authorization: 'Bearer ' + t } };
      attempt++; continue;
    }
    if (RETRY_STATUSES.has(res.status) && attempt < RETRY_DELAYS.length) {
      const wait = Math.max(RETRY_DELAYS[attempt], Number(res.headers.get('retry-after') || 0) * 1000);
      await new Promise(r => setTimeout(r, wait));
      attempt++; continue;
    }
    return res;
  }
}

// ─── Appels API ───────────────────────────────────────────────────────────────

async function callLegifrance(path, payload = {}, method = 'POST') {
  const token = await getToken(LF_CLIENT_ID, LF_CLIENT_SECRET);
  let options = {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json' },
  };
  if (method !== 'GET') options.body = JSON.stringify(payload);
  const res  = await fetchWithRetry(LF_BASE + path, options, LF_CLIENT_ID, LF_CLIENT_SECRET);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error('Légifrance ' + res.status + ' ' + path); e.status = res.status; throw e; }
  return data;
}

async function callJudilibre(path, queryParams = {}) {
  const token = await getToken(JD_CLIENT_ID, JD_CLIENT_SECRET);
  const qs = new URLSearchParams(
    Object.entries(queryParams)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => [k, String(v)])
  ).toString();
  const res  = await fetchWithRetry(JD_BASE + path + (qs ? '?' + qs : ''),
    { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } },
    JD_CLIENT_ID, JD_CLIENT_SECRET);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error('Judilibre ' + res.status + ' ' + path); e.status = res.status; throw e; }
  return data;
}

// ─── Helpers NLP ──────────────────────────────────────────────────────────────

const today      = () => new Date().toISOString().split('T')[0];
const normalizeWS = v => String(v || '').replace(/\s+/g, ' ').trim();

function normalizeSyntax(v) {
  let q = normalizeWS(v).replace(/[""]/g, '"').replace(/['']/g, "'");
  const seen = new Set(), out = [];
  for (const tok of q.split(' ').filter(Boolean)) {
    const k = tok.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(tok); }
  }
  q = out.join(' ');
  q = q.replace(/\b([LRDA]\.?(?:\s)?\d[\w.-]*)\s+(code de la sécurité sociale|css)\b/gi,
    (_, a) => 'article ' + a.replace(/\s+/g, '') + ' code de la sécurité sociale');
  q = q.replace(/\b(1240|1241|1231-1)\s+code civil\b/gi, (_, a) => 'article ' + a + ' code civil');
  return normalizeWS(q);
}

function detectIntent(query) {
  const q = (query || '').toLowerCase();
  const hasArt = /\barticle\b/.test(q) || /\b[lrda]\.?(?:\s)?\d[\w.-]*\b/i.test(query || '') || /\b1240\b|\b1241\b|\b1231-1\b/.test(q);
  if (/\bidcc\b|\bconvention collective\b|\bsyntec\b|\bmétallurgie\b/.test(q)) return 'KALI';
  if (/\bjorftext\b|\bnor\b|\bjournal officiel\b|\bjorf\b|\bdécret\b|\barrêté\b|\bordonnance\b/.test(q)) return 'JORF_LODA';
  if (/\bcour de cassation\b|\bjurisprudence\b|\barrêt\b|\bpourvoi\b|\becli\b/.test(q)) return 'JURISPRUDENCE';
  if (hasArt && /\bcode\b/.test(q)) return 'ARTICLE';
  if (/\bcode civil\b|\bcode de la sécurité sociale\b|\bcode du travail\b|\bcode\b/.test(q)) return 'CODE';
  return 'GENERIC';
}

const FOND_BY_INTENT = {
  ARTICLE: 'CODE_ETAT', CODE: 'CODE_ETAT', JURISPRUDENCE: 'JURI',
  JORF_LODA: 'LODA_ETAT', KALI: 'KALI', GENERIC: 'ALL',
};

function rerankByIntent(intent, results) {
  const arr = Array.isArray(results) ? [...results] : [];
  const originOf = r => String(r.origin || r.type || r.fond || r.nature || r.corpus || '').toUpperCase();
  const pm = {
    ARTICLE:      ['LEGI', 'CODE', 'JURI', 'JORF', 'KALI'],
    CODE:         ['LEGI', 'CODE', 'JURI', 'JORF', 'KALI'],
    JURISPRUDENCE:['JURI', 'CASSATION', 'LEGI', 'JORF', 'KALI'],
    JORF_LODA:    ['JORF', 'LODA', 'LEGI', 'JURI', 'KALI'],
    KALI:         ['KALI', 'ACCO', 'LEGI', 'JURI', 'JORF'],
    GENERIC:      ['LEGI', 'JURI', 'JORF', 'KALI'],
  };
  const p = pm[intent] || pm.GENERIC;
  return arr.sort((a, b) => {
    const ia = p.findIndex(x => originOf(a).includes(x));
    const ib = p.findIndex(x => originOf(b).includes(x));
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
}

const CONTENTIEUX_LAYERS = {
  TEXTE:         ['LEGI', 'CODE', 'LEGIARTI', 'LEGITEXT'],
  JUGE:          ['JURI', 'JUFI', 'CETAT', 'CONSTIT', 'CASSATION'],
  ADMINISTRATION:['JORF', 'LODA', 'CIRC', 'DOSSIER'],
  PROCEDURE:     ['KALI', 'ACCO', 'CNIL'],
};
const LAYER_ORDER = ['TEXTE', 'JUGE', 'ADMINISTRATION', 'PROCEDURE', 'AUTRE'];

function detectLayer(result) {
  const src = String(result.origin || result.type || result.fond || result.nature || result.corpus || result.id || '').toUpperCase();
  for (const [layer, markers] of Object.entries(CONTENTIEUX_LAYERS)) {
    if (markers.some(m => src.includes(m))) return layer;
  }
  return 'AUTRE';
}

function rerankContentieux(results) {
  return [...(Array.isArray(results) ? results : [])].sort(
    (a, b) => LAYER_ORDER.indexOf(detectLayer(a)) - LAYER_ORDER.indexOf(detectLayer(b))
  );
}

function buildSearchPayload(query, { fond, pageSize = 10, pageNumber = 1 } = {}) {
  const intent = detectIntent(normalizeSyntax(query));
  return {
    fond: fond || FOND_BY_INTENT[intent] || 'ALL',
    recherche: {
      champs: [{ typeChamp: 'ALL', criteres: [{ typeRecherche: 'TOUS_LES_MOTS_DANS_UN_CHAMP', valeur: query, operateur: 'ET' }], operateur: 'ET' }],
      operateur: 'ET', typePagination: 'DEFAUT',
      pageSize: Math.min(Number(pageSize) || 10, 100),
      pageNumber: Number(pageNumber) || 1,
      sort: 'PERTINENCE',
    },
  };
}

async function resolveCodeId(codeTerms) {
  const list = await callLegifrance('/list/code', { codeName: codeTerms, pageSize: 3, pageNumber: 1, states: ['VIGUEUR'] });
  return (list.results || [])[0]?.cid || (list.results || [])[0]?.id || null;
}

async function resolveKaliId(query) {
  const list = await callLegifrance('/list/conventions', { titre: query, pageSize: 3, pageNumber: 1 });
  return (list.results || [])[0]?.id || null;
}

// ─── Définition des tools MCP ─────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'lf_search',
    description: 'Recherche multi-fonds dans Légifrance avec détection automatique d\'intention (code, article, jurisprudence, JORF/LODA, KALI, circulaire) et rerankage contentieux (TEXTE → JUGE → ADMINISTRATION → PROCÉDURE). Point d\'entrée principal pour toute question juridique.',
    inputSchema: {
      type: 'object',
      properties: {
        query:      { type: 'string',  description: 'Requête en langage naturel' },
        fond:       { type: 'string',  description: 'Fond forcé (ALL, CODE_ETAT, JURI, LODA_ETAT, KALI, JORF, ACCO, CNIL, CIRC)' },
        pageSize:   { type: 'number',  description: 'Résultats par page (défaut 10, max 100)' },
        pageNumber: { type: 'number',  description: 'Numéro de page (défaut 1)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'lf_suggest',
    description: 'Autocomplétion / suggestions Légifrance pour une requête partielle.',
    inputSchema: {
      type: 'object',
      properties: {
        query:         { type: 'string',  description: 'Début de la requête' },
        supplies:      { type: 'array',   items: { type: 'string' }, description: 'Fonds ciblés' },
        documentsDits: { type: 'boolean', description: 'Inclure les documents dits (défaut false)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'lf_article_fetch',
    description: 'Récupère le texte intégral d\'un article de code. Stratégie cascade : getArticleWithIdAndNum → search+getArticle → search_only.',
    inputSchema: {
      type: 'object',
      properties: {
        articleNumber: { type: 'string', description: 'Numéro d\'article (ex: "L1237-19", "1240")' },
        codeTerms:     { type: 'string', description: 'Nom du code (ex: "code du travail")' },
        query:         { type: 'string', description: 'Requête libre alternative' },
      },
    },
  },
  {
    name: 'lf_consult_article_by_cid',
    description: 'Récupère un article par son CID chronologique (ex: LEGIARTI000006900408).',
    inputSchema: {
      type: 'object',
      properties: { cid: { type: 'string', description: 'CID article (commence par LEGIARTI)' } },
      required: ['cid'],
    },
  },
  {
    name: 'lf_consult_article_by_eli',
    description: 'Récupère un article par son identifiant ELI ou alias.',
    inputSchema: {
      type: 'object',
      properties: { idEliOrAlias: { type: 'string' } },
      required: ['idEliOrAlias'],
    },
  },
  {
    name: 'lf_code_resolve',
    description: 'Résout un code par son nom → retourne son textId LEGITEXT et sa table des matières.',
    inputSchema: {
      type: 'object',
      properties: { codeTerms: { type: 'string', description: 'Nom du code (ex: "code du travail")' } },
      required: ['codeTerms'],
    },
  },
  {
    name: 'lf_consult_code',
    description: 'Retourne le texte consolidé d\'un code à une date donnée. textId ou codeTerms requis.',
    inputSchema: {
      type: 'object',
      properties: {
        textId:    { type: 'string', description: 'Identifiant LEGITEXT' },
        codeTerms: { type: 'string', description: 'Nom du code si textId inconnu' },
        date:      { type: 'string', description: 'Date ISO (défaut: aujourd\'hui)' },
        sctCid:    { type: 'string', description: 'CID section pour ne récupérer qu\'une partie' },
      },
    },
  },
  {
    name: 'lf_jorf_get',
    description: 'Journal officiel : texte par NOR/JORFTEXT, ou les 5 derniers JO si aucun identifiant.',
    inputSchema: {
      type: 'object',
      properties: { nor: { type: 'string', description: 'NOR (ex: MTRD2301234D) ou JORFTEXT...' } },
    },
  },
  {
    name: 'lf_law_decree_search',
    description: 'Recherche dans les lois, décrets et arrêtés (fond LODA_ETAT).',
    inputSchema: {
      type: 'object',
      properties: {
        query:      { type: 'string' },
        pageSize:   { type: 'number' },
        pageNumber: { type: 'number' },
      },
      required: ['query'],
    },
  },
  {
    name: 'lf_circulaire_search',
    description: 'Recherche dans les circulaires administratives (fond CIRC).',
    inputSchema: {
      type: 'object',
      properties: {
        query:      { type: 'string' },
        pageSize:   { type: 'number' },
        pageNumber: { type: 'number' },
      },
      required: ['query'],
    },
  },
  {
    name: 'lf_consult_juri',
    description: 'Jurisprudence Légifrance : Conseil d\'État (CETAT), Conseil constitutionnel (CONSTIT), juridictions du fond (JURI). textId pour consultation directe, query pour recherche.',
    inputSchema: {
      type: 'object',
      properties: {
        textId:         { type: 'string' },
        query:          { type: 'string' },
        searchedString: { type: 'string' },
        pageSize:       { type: 'number' },
      },
    },
  },
  {
    name: 'lf_list_conventions',
    description: 'Liste les conventions collectives KALI, filtrable par IDCC ou titre.',
    inputSchema: {
      type: 'object',
      properties: {
        titre:       { type: 'string' },
        idcc:        { type: 'string' },
        pageSize:    { type: 'number' },
        pageNumber:  { type: 'number' },
        legalStatus: { type: 'string' },
      },
    },
  },
  {
    name: 'lf_consult_kali',
    description: 'Texte ou contenus d\'une convention collective KALI par id, IDCC, ou nom.',
    inputSchema: {
      type: 'object',
      properties: {
        id:             { type: 'string' },
        idcc:           { type: 'string' },
        query:          { type: 'string' },
        mode:           { type: 'string', enum: ['text', 'cont'] },
        searchedString: { type: 'string' },
      },
    },
  },
  {
    name: 'lf_chrono',
    description: 'Historique des versions d\'un texte (CID chronologique).',
    inputSchema: {
      type: 'object',
      properties: { textCid: { type: 'string' } },
      required: ['textCid'],
    },
  },
  {
    name: 'jd_search',
    description: 'Recherche dans Judilibre (Cour de cassation + autres). Filtres : chambre, juridiction, solution, date, publication.',
    inputSchema: {
      type: 'object',
      properties: {
        query:        { type: 'string' },
        operator:     { type: 'string' },
        chamber:      { type: 'string' },
        jurisdiction: { type: 'string' },
        solution:     { type: 'string' },
        publication:  { type: 'string' },
        date_start:   { type: 'string' },
        date_end:     { type: 'string' },
        page_size:    { type: 'number' },
        page:         { type: 'number' },
        sort:         { type: 'string' },
        order:        { type: 'string' },
      },
      required: ['query'],
    },
  },
  {
    name: 'jd_decision',
    description: 'Texte intégral d\'une décision Judilibre par son identifiant.',
    inputSchema: {
      type: 'object',
      properties: {
        id:                 { type: 'string' },
        resolve_references: { type: 'boolean' },
        query:              { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'jd_taxonomy',
    description: 'Taxonomie Judilibre (chambres, juridictions, solutions, publications).',
    inputSchema: {
      type: 'object',
      properties: {
        id:            { type: 'string' },
        key:           { type: 'string' },
        value:         { type: 'string' },
        context_value: { type: 'string' },
      },
    },
  },
  // ── Légifrance : Articles complémentaires ────────────────────────────────────
  {
    name: 'lf_article_resolve',
    description: 'Résolution légère d\'article : retourne uniquement le meilleur résultat (bestMatch) sans récupérer le texte intégral. Plus rapide que lf_article_fetch quand seul l\'identifiant est nécessaire.',
    inputSchema: {
      type: 'object',
      properties: {
        articleNumber: { type: 'string', description: 'Numéro d\'article (ex: "L1237-19", "1240")' },
        codeTerms:     { type: 'string', description: 'Nom du code (ex: "code du travail")' },
        query:         { type: 'string', description: 'Requête libre alternative' },
      },
    },
  },
  {
    name: 'lf_consult_same_num_article',
    description: 'Retourne les articles portant le même numéro dans d\'autres textes (codes, lois). Utile pour les articles de renvoi ou les reprises de numérotation.',
    inputSchema: {
      type: 'object',
      properties: {
        articleCid: { type: 'string', description: 'CID de l\'article source (LEGIARTI...)' },
        articleNum: { type: 'string', description: 'Numéro de l\'article (ex: "L1237-19")' },
        textCid:    { type: 'string', description: 'CID du texte source (LEGITEXT...)' },
        date:       { type: 'string', description: 'Date de consultation ISO (défaut: aujourd\'hui)' },
      },
      required: ['articleCid', 'articleNum', 'textCid'],
    },
  },

  // ── Légifrance : Codes complémentaires ────────────────────────────────────────
  {
    name: 'lf_code_safe',
    description: 'Liste les codes en vigueur correspondant à un nom, sans résoudre la table des matières. Plus léger que lf_code_resolve, utile pour vérifier l\'existence d\'un code ou obtenir son identifiant LEGITEXT.',
    inputSchema: {
      type: 'object',
      properties: {
        codeTerms: { type: 'string', description: 'Nom du code (ex: "code civil", "code de commerce")' },
        maxItems:  { type: 'number', description: 'Nombre max de résultats (défaut 5, max 100)' },
      },
      required: ['codeTerms'],
    },
  },
  {
    name: 'lf_consult_legi_part',
    description: 'Retourne les sections (parties) d\'un texte LEGI à une date donnée. Utile pour naviguer dans la structure d\'un code sans charger tout le texte consolidé.',
    inputSchema: {
      type: 'object',
      properties: {
        textId:         { type: 'string', description: 'Identifiant LEGITEXT' },
        codeTerms:      { type: 'string', description: 'Nom du code si textId inconnu' },
        date:           { type: 'string', description: 'Date ISO (défaut: aujourd\'hui)' },
        searchedString: { type: 'string', description: 'Terme à surligner dans le résultat' },
      },
    },
  },

  // ── Légifrance : Versions canoniques ─────────────────────────────────────────
  {
    name: 'lf_search_canonical_version',
    description: 'Retourne la version canonique (officielle consolidée) d\'un texte Légifrance à une date donnée.',
    inputSchema: {
      type: 'object',
      properties: {
        textId: { type: 'string', description: 'Identifiant du texte (LEGITEXT ou JORFTEXT)' },
        date:   { type: 'string', description: 'Date ISO (défaut: aujourd\'hui)' },
      },
      required: ['textId'],
    },
  },
  {
    name: 'lf_search_canonical_article',
    description: 'Retourne la version canonique d\'un article Légifrance à une date donnée.',
    inputSchema: {
      type: 'object',
      properties: {
        articleId: { type: 'string', description: 'Identifiant de l\'article (LEGIARTI...)' },
        date:      { type: 'string', description: 'Date ISO (défaut: aujourd\'hui)' },
      },
      required: ['articleId'],
    },
  },
  {
    name: 'lf_search_nearest_version',
    description: 'Retourne la version d\'un texte Légifrance la plus proche d\'une date donnée (avant ou après).',
    inputSchema: {
      type: 'object',
      properties: {
        textId: { type: 'string', description: 'Identifiant du texte (LEGITEXT ou JORFTEXT)' },
        date:   { type: 'string', description: 'Date ISO cible' },
      },
      required: ['textId'],
    },
  },

  // ── Légifrance : JORF complémentaire ──────────────────────────────────────────
  {
    name: 'lf_consult_last_n_jo',
    description: 'Retourne les N derniers numéros du Journal officiel (JO). Utile pour surveiller les publications récentes.',
    inputSchema: {
      type: 'object',
      properties: {
        nbElement: { type: 'number', description: 'Nombre de JO à retourner (défaut 10, max 100)' },
      },
    },
  },

  // ── Légifrance : LODA ─────────────────────────────────────────────────────────
  {
    name: 'lf_list_loda',
    description: 'Liste paginée des textes LODA (lois, ordonnances, décrets, arrêtés), avec filtres sur la nature, le statut juridique et les dates.',
    inputSchema: {
      type: 'object',
      properties: {
        pageSize:        { type: 'number',  description: 'Résultats par page (défaut 10, max 100)' },
        pageNumber:      { type: 'number',  description: 'Numéro de page (défaut 1)' },
        natures:         { type: 'array',   items: { type: 'string' }, description: 'Natures filtrées (ex: ["LOI","DECRET"])' },
        legalStatus:     { type: 'string',  description: 'Statut juridique (ex: "VIGUEUR")' },
        sort:            { type: 'string',  description: 'Tri (ex: "SIGNATURE_DATE_DESC")' },
        secondSort:      { type: 'string',  description: 'Tri secondaire' },
        signatureDate:   { type: 'object',  description: 'Plage de dates de signature { start, end }' },
        publicationDate: { type: 'object',  description: 'Plage de dates de publication { start, end }' },
      },
    },
  },

  // ── Légifrance : Dossiers législatifs ────────────────────────────────────────
  {
    name: 'lf_consult_dossier_legislatif',
    description: 'Consulte un dossier législatif par son identifiant. Retourne le parcours complet d\'une loi (projet, navettes, lectures, promulgation).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Identifiant du dossier législatif' },
      },
      required: ['id'],
    },
  },
  {
    name: 'lf_list_dossiers_legislatifs',
    description: 'Liste les dossiers législatifs d\'une législature, filtrables par type (LOI, ORDONNANCE…).',
    inputSchema: {
      type: 'object',
      properties: {
        type:          { type: 'string', description: 'Type de dossier (ex: "LOI", "ORDONNANCE")' },
        legislatureId: { type: 'number', description: 'Numéro de législature (ex: 17)' },
      },
      required: ['type', 'legislatureId'],
    },
  },

  // ── Légifrance : CNIL ─────────────────────────────────────────────────────────
  {
    name: 'lf_consult_cnil',
    description: 'Consulte les textes CNIL (délibérations, décisions, recommandations). textId pour accès direct, query pour recherche dans le fond CNIL.',
    inputSchema: {
      type: 'object',
      properties: {
        textId:         { type: 'string', description: 'Identifiant du texte CNIL' },
        query:          { type: 'string', description: 'Requête de recherche libre' },
        searchedString: { type: 'string', description: 'Terme à surligner' },
        pageSize:       { type: 'number', description: 'Résultats si recherche (défaut 10)' },
      },
    },
  },

  // ── Légifrance : KALI complémentaire ─────────────────────────────────────────
  {
    name: 'lf_consult_kali_cont_idcc',
    description: 'Accès direct au contenu d\'une convention collective par son numéro IDCC. Plus direct que lf_consult_kali quand l\'IDCC est connu.',
    inputSchema: {
      type: 'object',
      properties: {
        idcc: { type: 'string', description: 'Numéro IDCC (ex: "1486", "3043")' },
      },
      required: ['idcc'],
    },
  },
  {
    name: 'lf_consult_kali_section',
    description: 'Récupère une section spécifique d\'une convention collective KALI par son identifiant de section.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Identifiant de section KALI (commence par KALISCTA ou KALISECT)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'lf_consult_kali_article',
    description: 'Récupère un article spécifique d\'une convention collective KALI par son identifiant.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Identifiant d\'article KALI (commence par KALIARTI)' },
      },
      required: ['id'],
    },
  },

  // ── Légifrance : Accords d'entreprise ────────────────────────────────────────
  {
    name: 'lf_consult_acco',
    description: 'Consulte les accords d\'entreprise (fond ACCO). id pour accès direct, query pour recherche.',
    inputSchema: {
      type: 'object',
      properties: {
        id:       { type: 'string', description: 'Identifiant de l\'accord (commence par ACCO)' },
        query:    { type: 'string', description: 'Requête de recherche libre' },
        pageSize: { type: 'number', description: 'Résultats si recherche (défaut 10)' },
      },
    },
  },

  // ── Légifrance : Suggestions complémentaires ──────────────────────────────────
  {
    name: 'lf_suggest_acco',
    description: 'Suggestions de SIRET et raisons sociales pour les accords d\'entreprise. Utile pour l\'autocomplétion sur le nom d\'une entreprise.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Début du nom d\'entreprise ou numéro SIRET partiel' },
      },
      required: ['query'],
    },
  },
  {
    name: 'lf_suggest_pdc',
    description: 'Suggestions sur le plan de classement Légifrance (PDC). Utile pour l\'autocomplétion sur des noms de rubriques ou de domaines juridiques.',
    inputSchema: {
      type: 'object',
      properties: {
        query:  { type: 'string', description: 'Texte de recherche pour la suggestion PDC' },
        origin: { type: 'string', description: 'Origine filtrée (optionnel)' },
        fond:   { type: 'string', description: 'Fond filtré (optionnel)' },
      },
      required: ['query'],
    },
  },

  // ── Légifrance : Divers ───────────────────────────────────────────────────────
  {
    name: 'lf_commit',
    description: 'Retourne l\'identifiant de version (commit) de l\'API Légifrance actuellement déployée. Utile pour diagnostiquer des comportements inattendus.',
    inputSchema: { type: 'object', properties: {} },
  },

  // ── Judilibre : Endpoints complémentaires ────────────────────────────────────
  {
    name: 'jd_scan',
    description: 'Parcours paginé des décisions Judilibre (scan séquentiel). Permet d\'itérer sur l\'ensemble du corpus avec un curseur search_after. Utile pour l\'export ou l\'analyse de données.',
    inputSchema: {
      type: 'object',
      properties: {
        type:               { type: 'string',  description: 'Type de décision' },
        chamber:            { type: 'string',  description: 'Chambre' },
        jurisdiction:       { type: 'string',  description: 'Juridiction' },
        solution:           { type: 'string',  description: 'Solution' },
        publication:        { type: 'string',  description: 'Niveau de publication' },
        date_start:         { type: 'string',  description: 'Date de début YYYY-MM-DD' },
        date_end:           { type: 'string',  description: 'Date de fin YYYY-MM-DD' },
        date_type:          { type: 'string',  description: 'Type de date (creation, update...)' },
        order:              { type: 'string',  description: 'Ordre (asc ou desc)' },
        batch_size:         { type: 'number',  description: 'Taille du lot (défaut 10)' },
        search_after:       { type: 'string',  description: 'Curseur de pagination (valeur search_after du résultat précédent)' },
        resolve_references: { type: 'string',  description: 'Résoudre les références (true/false)' },
        abridged:           { type: 'string',  description: 'Format abrégé (true/false)' },
        particularInterest: { type: 'string',  description: 'Intérêt particulier (true/false)' },
        withFileOfType:     { type: 'string',  description: 'Filtrer par type de fichier joint' },
      },
    },
  },
  {
    name: 'jd_export',
    description: 'Export par lot de décisions Judilibre. Permet de télécharger un ensemble de décisions filtrées en une seule requête.',
    inputSchema: {
      type: 'object',
      properties: {
        type:               { type: 'string' },
        chamber:            { type: 'string' },
        jurisdiction:       { type: 'string' },
        solution:           { type: 'string' },
        date_start:         { type: 'string', description: 'Date de début YYYY-MM-DD' },
        date_end:           { type: 'string', description: 'Date de fin YYYY-MM-DD' },
        date_type:          { type: 'string' },
        order:              { type: 'string' },
        batch_size:         { type: 'number', description: 'Taille du lot' },
        batch:              { type: 'number', description: 'Numéro du lot' },
        resolve_references: { type: 'string' },
        abridged:           { type: 'string' },
        withFileOfType:     { type: 'string' },
      },
    },
  },
  {
    name: 'jd_stats',
    description: 'Statistiques Judilibre : nombre de décisions par juridiction, chambre, solution, date. Utile pour des analyses quantitatives du corpus jurisprudentiel.',
    inputSchema: {
      type: 'object',
      properties: {
        jurisdiction:       { type: 'string' },
        location:           { type: 'string' },
        date_start:         { type: 'string', description: 'Date de début YYYY-MM-DD' },
        date_end:           { type: 'string', description: 'Date de fin YYYY-MM-DD' },
        particularInterest: { type: 'string' },
        keys:               { type: 'string', description: 'Clés de statistiques demandées' },
      },
    },
  },
  {
    name: 'jd_transactional_history',
    description: 'Historique transactionnel Judilibre : liste les décisions créées, modifiées ou supprimées à une date donnée. Utile pour synchroniser un index local.',
    inputSchema: {
      type: 'object',
      properties: {
        date:      { type: 'string', description: 'Date cible YYYY-MM-DD (obligatoire)' },
        page_size: { type: 'number', description: 'Taille de page' },
        from_id:   { type: 'string', description: 'Curseur de pagination' },
      },
      required: ['date'],
    },
  },

  // ── Escape hatch ─────────────────────────────────────────────────────────────
  {
    name: 'raw_request',
    description: 'Requête brute directe vers Légifrance ou Judilibre. Escape hatch pour endpoints non couverts.',
    inputSchema: {
      type: 'object',
      properties: {
        api:     { type: 'string', enum: ['legifrance', 'judilibre'] },
        path:    { type: 'string' },
        method:  { type: 'string', enum: ['GET', 'POST'] },
        payload: { type: 'object' },
      },
      required: ['api', 'path'],
    },
  },
];

// ─── Exécution des tools ──────────────────────────────────────────────────────

async function handleTool(name, args) {
  const a = args || {};

  switch (name) {

    case 'lf_search': {
      const q = normalizeSyntax(a.query), intent = detectIntent(q);
      const payload  = buildSearchPayload(q, { fond: a.fond, pageSize: a.pageSize, pageNumber: a.pageNumber });
      const upstream = await callLegifrance('/search', payload);
      const results  = rerankContentieux(rerankByIntent(intent, upstream.results || []));
      return { totalResultNumber: upstream.totalResultNumber ?? results.length, returnedCount: results.length, results, routing: { normalized_query: q, intent, fond_used: payload.fond } };
    }

    case 'lf_suggest': {
      const q = normalizeSyntax(a.query), intent = detectIntent(q);
      const upstream = await callLegifrance('/suggest', { searchText: q, supplies: a.supplies || [FOND_BY_INTENT[intent] || 'ALL'], documentsDits: a.documentsDits ?? false });
      return { returnedCount: (upstream.results || []).length, results: rerankByIntent(intent, upstream.results || []) };
    }

    case 'lf_article_fetch': {
      const articleNumber = normalizeWS(a.articleNumber || '');
      const codeTerms     = normalizeWS(a.codeTerms || '');
      const query = normalizeWS(a.query || ((articleNumber ? 'article ' + articleNumber : '') + ' ' + codeTerms).trim());
      if (!query) throw new Error('articleNumber+codeTerms ou query requis');
      const normalized = normalizeSyntax(query);
      if (articleNumber && codeTerms) {
        const textId = await resolveCodeId(codeTerms);
        if (textId) {
          try { return { mode: 'consult_by_id_and_num', textId, article: await callLegifrance('/consult/getArticleWithIdAndNum', { id: textId, num: articleNumber }) }; }
          catch { /* fallback */ }
        }
      }
      const sr   = await callLegifrance('/search', buildSearchPayload(normalized, { fond: 'CODE_ETAT', pageSize: 3 }));
      const best = (sr.results || [])[0] || null;
      if (best?.id && /^LEGIARTI/i.test(best.id)) {
        return { mode: 'consult_by_legiarti', article: await callLegifrance('/consult/getArticle', { id: best.id }) };
      }
      return { mode: 'search_only', bestMatch: best };
    }

    case 'lf_consult_article_by_cid': {
      const cid = normalizeWS(a.cid || '');
      if (!cid) throw new Error('cid requis');
      return callLegifrance('/consult/getArticleByCid', { cid });
    }

    case 'lf_consult_article_by_eli': {
      const e = normalizeWS(a.idEliOrAlias || '');
      if (!e) throw new Error('idEliOrAlias requis');
      return callLegifrance('/consult/getArticleWithIdEliOrAlias', { idEliOrAlias: e });
    }

    case 'lf_code_resolve': {
      const codeTerms = normalizeWS(a.codeTerms || '');
      if (!codeTerms) throw new Error('codeTerms requis');
      const cl      = await callLegifrance('/list/code', { codeName: codeTerms, pageSize: 3, pageNumber: 1, states: ['VIGUEUR'] });
      const ce      = (cl.results || [])[0];
      const textId  = ce?.cid || ce?.id || null;
      if (!textId) throw new Error('Code introuvable : ' + codeTerms);
      const outline = await callLegifrance('/consult/legi/tableMatieres', { textId, date: today(), nature: 'CODE' });
      return { textId, code: ce, outline: outline.sections || outline.elements || outline };
    }

    case 'lf_consult_code': {
      const date       = normalizeWS(a.date || today());
      const resolvedId = normalizeWS(a.textId || '') || (a.codeTerms ? await resolveCodeId(a.codeTerms) : null);
      if (!resolvedId) throw new Error('textId ou codeTerms requis');
      return callLegifrance('/consult/code', { textId: resolvedId, date, ...(a.sctCid ? { sctCid: a.sctCid } : {}) });
    }

    case 'lf_jorf_get': {
      const nor = normalizeWS(a.nor || '');
      if (nor) {
        const isTC = /^JORFTEXT/i.test(nor);
        return callLegifrance(isTC ? '/consult/jorf' : '/consult/getJoWithNor', isTC ? { textCid: nor } : { nor });
      }
      return callLegifrance('/consult/lastNJo', { nbElement: 5 });
    }

    case 'lf_law_decree_search': {
      const u = await callLegifrance('/search', buildSearchPayload(normalizeSyntax(a.query), { fond: 'LODA_ETAT', pageSize: a.pageSize || 10, pageNumber: a.pageNumber || 1 }));
      return { totalResultNumber: u.totalResultNumber, results: u.results || [] };
    }

    case 'lf_circulaire_search': {
      const u = await callLegifrance('/search', buildSearchPayload(normalizeSyntax(a.query), { fond: 'CIRC', pageSize: a.pageSize || 10, pageNumber: a.pageNumber || 1 }));
      return { totalResultNumber: u.totalResultNumber, results: u.results || [] };
    }

    case 'lf_consult_juri': {
      const textId = normalizeWS(a.textId || '');
      const query  = normalizeSyntax(a.query || '');
      if (textId) return callLegifrance('/consult/juri', { textId, ...(a.searchedString ? { searchedString: a.searchedString } : {}) });
      if (!query) throw new Error('textId ou query requis');
      const fond     = /\bconseil d[' ]état\b|\bcetat\b|\badministratif\b/i.test(query) ? 'CETAT'
                     : /\bconseil constitu/i.test(query) ? 'CONSTIT' : 'JURI';
      const upstream = await callLegifrance('/search', buildSearchPayload(query, { fond, pageSize: a.pageSize || 10 }));
      return { totalResultNumber: upstream.totalResultNumber, results: upstream.results || [], fond_used: fond };
    }

    case 'lf_list_conventions': {
      return callLegifrance('/list/conventions', {
        pageSize:   Math.min(Number(a.pageSize  || 10), 100),
        pageNumber: Number(a.pageNumber || 1),
        ...(a.titre       ? { titre:       a.titre }       : {}),
        ...(a.idcc        ? { idcc:        a.idcc }        : {}),
        ...(a.legalStatus ? { legalStatus: a.legalStatus } : {}),
      });
    }

    case 'lf_consult_kali': {
      const id    = normalizeWS(a.id || a.idcc || '');
      const query = normalizeWS(a.query || '');
      if (!id && !query) throw new Error('id, idcc ou query requis');
      const kaliId = id || await resolveKaliId(query);
      if (!kaliId) throw new Error('Convention introuvable : ' + query);
      const path = (a.mode || 'cont') === 'text' ? '/consult/kaliText' : '/consult/kaliCont';
      return callLegifrance(path, { id: kaliId, ...(a.searchedString ? { searchedString: a.searchedString } : {}) });
    }

    case 'lf_chrono': {
      const textCid = normalizeWS(a.textCid || '');
      if (!textCid) throw new Error('textCid requis');
      return callLegifrance('/chrono/textCid/' + encodeURIComponent(textCid), {}, 'GET');
    }

    case 'jd_search': {
      const q = normalizeSyntax(a.query);
      if (!q) throw new Error('query requis');
      return callJudilibre('/search', {
        query: q, operator: a.operator || 'and',
        page_size: Number(a.page_size || 10), page: Number(a.page || 0),
        ...(a.chamber      ? { chamber:      a.chamber }      : {}),
        ...(a.jurisdiction ? { jurisdiction: a.jurisdiction } : {}),
        ...(a.solution     ? { solution:     a.solution }     : {}),
        ...(a.publication  ? { publication:  a.publication }  : {}),
        ...(a.date_start   ? { date_start:   a.date_start }   : {}),
        ...(a.date_end     ? { date_end:     a.date_end }     : {}),
        ...(a.sort         ? { sort:         a.sort }         : {}),
        ...(a.order        ? { order:        a.order }        : {}),
      });
    }

    case 'jd_decision': {
      const id = normalizeWS(a.id || '');
      if (!id) throw new Error('id requis');
      return callJudilibre('/decision', {
        id, resolve_references: String(a.resolve_references || 'false') === 'true',
        ...(a.query ? { query: a.query } : {}),
      });
    }

    case 'jd_taxonomy': {
      return callJudilibre('/taxonomy', {
        ...(a.id            ? { id:            a.id }            : {}),
        ...(a.key           ? { key:           a.key }           : {}),
        ...(a.value         ? { value:         a.value }         : {}),
        ...(a.context_value ? { context_value: a.context_value } : {}),
      });
    }

    case 'raw_request': {
      const { api, path, method = 'POST', payload = {} } = a;
      if (!api || !path) throw new Error('api et path requis');
      if (api === 'legifrance') return callLegifrance(path, payload, (method || 'POST').toUpperCase());
      if (api === 'judilibre')  return callJudilibre(path, payload);
      throw new Error('api non supportée : ' + api);
    }

    // ── Légifrance : Articles complémentaires ─────────────────────────────────

    case 'lf_article_resolve': {
      const articleNumber = normalizeWS(a.articleNumber || '');
      const codeTerms     = normalizeWS(a.codeTerms || '');
      const query = normalizeWS(a.query || ((articleNumber ? 'article ' + articleNumber : '') + ' ' + codeTerms).trim());
      if (!query) throw new Error('articleNumber+codeTerms ou query requis');
      const normalized = normalizeSyntax(query);
      const upstream   = await callLegifrance('/search', buildSearchPayload(normalized, { fond: 'CODE_ETAT', pageSize: 5 }));
      const best       = (upstream.results || [])[0] || null;
      return { returnedCount: best ? 1 : 0, bestMatch: best, query: normalized };
    }

    case 'lf_consult_same_num_article': {
      const { articleCid, articleNum, textCid } = a;
      if (!articleCid || !articleNum || !textCid) throw new Error('articleCid, articleNum et textCid requis');
      return callLegifrance('/consult/sameNumArticle', {
        articleCid, articleNum, textCid,
        date: normalizeWS(a.date || today()),
      });
    }

    // ── Légifrance : Codes complémentaires ────────────────────────────────────

    case 'lf_code_safe': {
      const codeTerms = normalizeWS(a.codeTerms || '');
      if (!codeTerms) throw new Error('codeTerms requis');
      const upstream = await callLegifrance('/list/code', {
        codeName:  codeTerms,
        pageSize:  Math.min(Number(a.maxItems || 5), 100),
        pageNumber: 1,
        states:    ['VIGUEUR'],
      });
      return {
        mode:          'code_lookup',
        code:          (upstream.results || [])[0] || null,
        searchSummary: { totalResultNumber: upstream.totalResultNumber ?? (upstream.results || []).length, returnedCount: (upstream.results || []).length },
      };
    }

    case 'lf_consult_legi_part': {
      const date       = normalizeWS(a.date || today());
      const resolvedId = normalizeWS(a.textId || '') || (a.codeTerms ? await resolveCodeId(a.codeTerms) : null);
      if (!resolvedId) throw new Error('textId ou codeTerms requis');
      return callLegifrance('/consult/legiPart', {
        textId: resolvedId, date,
        ...(a.searchedString ? { searchedString: a.searchedString } : {}),
      });
    }

    // ── Légifrance : Versions canoniques ──────────────────────────────────────

    case 'lf_search_canonical_version': {
      const textId = normalizeWS(a.textId || '');
      if (!textId) throw new Error('textId requis');
      return callLegifrance('/search/canonicalVersion', { textId, date: normalizeWS(a.date || today()) });
    }

    case 'lf_search_canonical_article': {
      const articleId = normalizeWS(a.articleId || '');
      if (!articleId) throw new Error('articleId requis');
      return callLegifrance('/search/canonicalArticleVersion', { articleId, date: normalizeWS(a.date || today()) });
    }

    case 'lf_search_nearest_version': {
      const textId = normalizeWS(a.textId || '');
      if (!textId) throw new Error('textId requis');
      return callLegifrance('/search/nearestVersion', { textId, date: normalizeWS(a.date || today()) });
    }

    // ── Légifrance : JORF complémentaire ──────────────────────────────────────

    case 'lf_consult_last_n_jo': {
      return callLegifrance('/consult/lastNJo', { nbElement: Math.min(Number(a.nbElement || 10), 100) });
    }

    // ── Légifrance : LODA ─────────────────────────────────────────────────────

    case 'lf_list_loda': {
      const payload = {
        pageSize:   Math.min(Number(a.pageSize  || 10), 100),
        pageNumber: Number(a.pageNumber || 1),
        ...(a.natures         ? { natures:         a.natures }         : {}),
        ...(a.legalStatus     ? { legalStatus:     a.legalStatus }     : {}),
        ...(a.sort            ? { sort:            a.sort }            : {}),
        ...(a.secondSort      ? { secondSort:      a.secondSort }      : {}),
        ...(a.signatureDate   ? { signatureDate:   a.signatureDate }   : {}),
        ...(a.publicationDate ? { publicationDate: a.publicationDate } : {}),
      };
      return callLegifrance('/list/loda', payload);
    }

    // ── Légifrance : Dossiers législatifs ─────────────────────────────────────

    case 'lf_consult_dossier_legislatif': {
      const id = normalizeWS(a.id || '');
      if (!id) throw new Error('id requis');
      return callLegifrance('/consult/dossierLegislatif', { id });
    }

    case 'lf_list_dossiers_legislatifs': {
      const { type, legislatureId } = a;
      if (!type || !legislatureId) throw new Error('type et legislatureId requis');
      return callLegifrance('/list/dossiersLegislatifs', { type, legislatureId: Number(legislatureId) });
    }

    // ── Légifrance : CNIL ─────────────────────────────────────────────────────

    case 'lf_consult_cnil': {
      const textId = normalizeWS(a.textId || '');
      const query  = normalizeSyntax(a.query || '');
      if (textId) {
        return callLegifrance('/consult/cnil', { textId, ...(a.searchedString ? { searchedString: a.searchedString } : {}) });
      }
      if (!query) throw new Error('textId ou query requis');
      const upstream = await callLegifrance('/search', buildSearchPayload(query, { fond: 'CNIL', pageSize: a.pageSize || 10 }));
      return { totalResultNumber: upstream.totalResultNumber, results: upstream.results || [], fond_used: 'CNIL' };
    }

    // ── Légifrance : KALI complémentaire ──────────────────────────────────────

    case 'lf_consult_kali_cont_idcc': {
      const id = normalizeWS(a.idcc || a.id || '');
      if (!id) throw new Error('idcc requis');
      return callLegifrance('/consult/kaliContIdcc', { id });
    }

    case 'lf_consult_kali_section': {
      const id = normalizeWS(a.id || '');
      if (!id) throw new Error('id de section KALI requis');
      return callLegifrance('/consult/kaliSection', { id });
    }

    case 'lf_consult_kali_article': {
      const id = normalizeWS(a.id || '');
      if (!id) throw new Error('id d\'article KALI requis');
      return callLegifrance('/consult/kaliArticle', { id });
    }

    // ── Légifrance : Accords d'entreprise ─────────────────────────────────────

    case 'lf_consult_acco': {
      const id    = normalizeWS(a.id || '');
      const query = normalizeSyntax(a.query || '');
      if (id) return callLegifrance('/consult/acco', { id });
      if (!query) throw new Error('id ou query requis');
      const upstream = await callLegifrance('/search', buildSearchPayload(query, { fond: 'ACCO', pageSize: a.pageSize || 10 }));
      return { totalResultNumber: upstream.totalResultNumber, results: upstream.results || [], fond_used: 'ACCO' };
    }

    // ── Légifrance : Suggestions complémentaires ──────────────────────────────

    case 'lf_suggest_acco': {
      const searchText = normalizeWS(a.query || a.searchText || '');
      if (!searchText) throw new Error('query requis');
      return callLegifrance('/suggest/acco', { searchText });
    }

    case 'lf_suggest_pdc': {
      const searchText = normalizeWS(a.query || a.searchText || '');
      if (!searchText) throw new Error('query requis');
      return callLegifrance('/suggest/pdc', {
        searchText,
        ...(a.origin ? { origin: a.origin } : {}),
        ...(a.fond   ? { fond:   a.fond }   : {}),
      });
    }

    // ── Légifrance : Divers ───────────────────────────────────────────────────

    case 'lf_commit': {
      return callLegifrance('/misc/commitId', {}, 'GET');
    }

    // ── Judilibre : Endpoints complémentaires ─────────────────────────────────

    case 'jd_scan': {
      return callJudilibre('/scan', {
        ...(a.type               ? { type:               a.type }               : {}),
        ...(a.chamber            ? { chamber:            a.chamber }            : {}),
        ...(a.jurisdiction       ? { jurisdiction:       a.jurisdiction }       : {}),
        ...(a.solution           ? { solution:           a.solution }           : {}),
        ...(a.publication        ? { publication:        a.publication }        : {}),
        ...(a.date_start         ? { date_start:         a.date_start }         : {}),
        ...(a.date_end           ? { date_end:           a.date_end }           : {}),
        ...(a.date_type          ? { date_type:          a.date_type }          : {}),
        ...(a.order              ? { order:              a.order }              : {}),
        ...(a.batch_size         ? { batch_size:         Number(a.batch_size) } : {}),
        ...(a.search_after       ? { search_after:       a.search_after }       : {}),
        ...(a.resolve_references ? { resolve_references: a.resolve_references } : {}),
        ...(a.abridged           ? { abridged:           a.abridged }           : {}),
        ...(a.particularInterest ? { particularInterest: a.particularInterest } : {}),
        ...(a.withFileOfType     ? { withFileOfType:     a.withFileOfType }     : {}),
      });
    }

    case 'jd_export': {
      return callJudilibre('/export', {
        ...(a.type               ? { type:               a.type }               : {}),
        ...(a.chamber            ? { chamber:            a.chamber }            : {}),
        ...(a.jurisdiction       ? { jurisdiction:       a.jurisdiction }       : {}),
        ...(a.solution           ? { solution:           a.solution }           : {}),
        ...(a.date_start         ? { date_start:         a.date_start }         : {}),
        ...(a.date_end           ? { date_end:           a.date_end }           : {}),
        ...(a.date_type          ? { date_type:          a.date_type }          : {}),
        ...(a.order              ? { order:              a.order }              : {}),
        ...(a.batch_size         ? { batch_size:         Number(a.batch_size) } : {}),
        ...(a.batch              ? { batch:              Number(a.batch) }      : {}),
        ...(a.resolve_references ? { resolve_references: a.resolve_references } : {}),
        ...(a.abridged           ? { abridged:           a.abridged }           : {}),
        ...(a.withFileOfType     ? { withFileOfType:     a.withFileOfType }     : {}),
      });
    }

    case 'jd_stats': {
      return callJudilibre('/stats', {
        ...(a.jurisdiction       ? { jurisdiction:       a.jurisdiction }       : {}),
        ...(a.location           ? { location:           a.location }           : {}),
        ...(a.date_start         ? { date_start:         a.date_start }         : {}),
        ...(a.date_end           ? { date_end:           a.date_end }           : {}),
        ...(a.particularInterest ? { particularInterest: a.particularInterest } : {}),
        ...(a.keys               ? { keys:               a.keys }               : {}),
      });
    }

    case 'jd_transactional_history': {
      const date = normalizeWS(a.date || '');
      if (!date) throw new Error('date requis (YYYY-MM-DD)');
      return callJudilibre('/transactionalhistory', {
        date,
        ...(a.page_size ? { page_size: Number(a.page_size) } : {}),
        ...(a.from_id   ? { from_id:   a.from_id }           : {}),
      });
    }

    default:
      throw new Error('Tool inconnu : ' + name);
  }
}

module.exports = { TOOLS, handleTool, initConfig };
