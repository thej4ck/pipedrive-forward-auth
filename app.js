const express = require('express');
const session = require('express-session');
const axios = require('axios');
const { URLSearchParams } = require('url');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Variabili di ambiente
const {
  PIPEDRIVE_CLIENT_ID,
  PIPEDRIVE_CLIENT_SECRET,
  BASE_URL,
  BASE_PATH = '', // Default a '' se non specificato
  SESSION_SECRET,
  SECURE_COOKIE,
  TRUST_PROXY
} = process.env;

// Configurazione delle variabili
const secureCookie = SECURE_COOKIE === 'true';
const trustProxyValue = parseInt(TRUST_PROXY, 10) || 0;
const TOKEN_FILE = path.join('/data', 'tokens.json');
let tokens = {};

// Funzione per caricare i token da file
function loadTokens() {
  if (fs.existsSync(TOKEN_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      tokens = data;
      console.log("Tokens caricati da file.");
    } catch (err) {
      console.error("Impossibile leggere i token da file:", err);
      tokens = {};
    }
  } else {
    tokens = {};
  }
}

// Funzione per salvare i token su file
function saveTokens() {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
  console.log("Tokens salvati su file.");
}

// Carica i token all'avvio
loadTokens();

console.log("=== Forward Auth Server con state, Basic Auth, persist token ===");
console.log("PIPEDRIVE_CLIENT_ID:", PIPEDRIVE_CLIENT_ID ? "SET" : "NOT SET");
console.log("PIPEDRIVE_CLIENT_SECRET:", PIPEDRIVE_CLIENT_SECRET ? "SET" : "NOT SET");
console.log("BASE_URL:", BASE_URL);
console.log("BASE_PATH:", BASE_PATH || "/");
console.log("SESSION_SECRET:", SESSION_SECRET ? "SET" : "NOT SET");
console.log("SECURE_COOKIE:", secureCookie);
console.log("TRUST_PROXY:", trustProxyValue);

// Genera REDIRECT_URI dinamicamente
const redirect_uri = `${BASE_URL}${BASE_PATH}/oauth/callback`;

// Genera installation_url dinamicamente
const installation_url = `https://oauth.pipedrive.com/oauth/authorize?client_id=${PIPEDRIVE_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirect_uri)}&response_type=code`;

// Inizializza l'app Express principale
const app = express();

// Imposta il numero di proxy di cui fidarsi
app.set('trust proxy', trustProxyValue);

// Middleware di log per verificare gli headers e req.secure
app.use((req, res, next) => {
  console.log('--- Inizio Headers ---');
  console.log('X-Forwarded-Proto:', req.headers['x-forwarded-proto']);
  console.log('X-Forwarded-For:', req.headers['x-forwarded-for']);
  console.log('Host:', req.headers['host']);
  console.log('Secure:', req.secure);
  console.log('Protocol:', req.protocol);
  console.log('Referer:', req.headers['referer']);
  console.log('--- Fine Headers ---');
  next();
});

// Configurazione della sessione
const sessionOptions = {
  secret: SESSION_SECRET || 'change_me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: secureCookie,        // Imposta il cookie come sicuro o no
    sameSite: 'none',            // Consente cookie cross-site
    httpOnly: true,              // Cookie non accessibile via JavaScript
    path: BASE_PATH || '/'       // Imposta il path del cookie su BASE_PATH
  }
};

app.use(session(sessionOptions));

// Log richieste
app.use((req, res, next) => {
  const sessionStatus = (req.session && req.session.user_key && tokens[req.session.user_key]) ? 'AUTHED' : 'NOT AUTHED';
  const storedToken = (req.session && req.session.user_key && tokens[req.session.user_key]) ? 'YES' : 'NO';
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} - Session: ${sessionStatus} - StoredToken: ${storedToken}`);
  next();
});

// Funzione per generare una stringa casuale
function generateRandomString(length = 20) {
  return crypto.randomBytes(length).toString('hex');
}

// Funzione per verificare se la richiesta proviene da Pipedrive
function isRequestFromPipedrive(req) {
  const referer = req.get('Referer') || '';
  return referer.includes('pipedrive.com');
}

// Funzione per rinnovare l'access token usando il refresh token
async function refreshAccessToken(userKey) {
  const tokenData = tokens[userKey];
  if (!tokenData || !tokenData.refresh_token) {
    throw new Error("No refresh_token available");
  }

  console.log("Rinnovo access_token utilizzando refresh_token:", tokenData.refresh_token);

  // Preparazione dell'header Basic Auth
  const credentials = Buffer.from(`${PIPEDRIVE_CLIENT_ID}:${PIPEDRIVE_CLIENT_SECRET}`).toString('base64');

  const refreshParams = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokenData.refresh_token
  }).toString();

  try {
    const tokenResponse = await axios.post('https://oauth.pipedrive.com/oauth/token', refreshParams, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${credentials}`
      }
    });

    console.log("Token response data:", tokenResponse.data);

    const { access_token, refresh_token, expires_in, scope, api_domain } = tokenResponse.data;

    if (!access_token) {
      throw new Error("No access_token in response");
    }

    // Aggiorna i token e l'expires_at
    tokens[userKey] = {
      access_token,
      refresh_token,
      expires_in,
      scope,
      api_domain,
      expires_at: Math.floor(Date.now() / 1000) + expires_in
    };

    saveTokens();
    console.log("Access token rinnovato e salvato.");

  } catch (err) {
    console.error("Errore nel rinnovo del token:", err.response ? err.response.data : err.message);
    throw err;
  }
}

// Middleware di autenticazione per le route protette
async function authenticationMiddleware(req, res, next) {
  // Se l'utente ha già un token memorizzato nella sessione, passa
  if (req.session && req.session.user_key && tokens[req.session.user_key] && tokens[req.session.user_key].access_token) {
    // Controlla se il token è scaduto o sta per scadere entro 5 minuti
    const tokenData = tokens[req.session.user_key];
    const currentTime = Math.floor(Date.now() / 1000);
    if (tokenData.expires_at && (currentTime >= tokenData.expires_at || (tokenData.expires_at - currentTime) <= 300)) {
      console.log("Access token scaduto o sta per scadere, avvio il refresh del token.");
      try {
        await refreshAccessToken(req.session.user_key);
        next();
      } catch (err) {
        console.error("Errore nel refresh del token:", err);
        // Rimuovi il token non valido
        delete tokens[req.session.user_key];
        saveTokens();
        // Avvia nuovamente il flusso OAuth
        initiateOAuth(req, res);
      }
      return;
    }

    console.log("Token presente e valido per l'utente in sessione, skip autorizzazione.");
    return next();
  }

  // Utente non autenticato, inizia il flusso OAuth
  console.log("Utente non autenticato, genero state e reindirizzo a Pipedrive per il login");
  initiateOAuth(req, res);
}

// Funzione per avviare il flusso OAuth
function initiateOAuth(req, res) {
  const state = generateRandomString();
  if (req.session) {
    req.session.oauth_state = state;
  }

  const authorizeUrl = `https://oauth.pipedrive.com/oauth/authorize?client_id=${PIPEDRIVE_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirect_uri)}&response_type=code&state=${state}`;
  console.log("Redirecting to:", authorizeUrl);
  res.redirect(authorizeUrl);
}

// Definisci le route

// GET /oauth/login
app.get(`${BASE_PATH}/oauth/login`, (req, res) => {
  initiateOAuth(req, res);
});

// Gestione della callback OAuth2
app.get(`${BASE_PATH}/oauth/callback`, async (req, res) => {
  const { code, state, error } = req.query;
  console.log("Ricevuto callback da Pipedrive. Code:", code, "State:", state, "Error:", error);

  // Se l'utente ha negato l'autorizzazione
  if (error === 'user_denied') {
    console.error("L'utente ha negato l'installazione dell'app.");
    return res.status(400).send("L'utente ha negato l'autorizzazione.");
  }

  // Se la richiesta proviene da Pipedrive, ignorare il controllo dello state
  if (!state && isRequestFromPipedrive(req)) {
    console.warn("State mancante ma richiesta proveniente da Pipedrive. Procedo senza validazione dello state.");
  } else {
    const sessionState = req.session && req.session.oauth_state;
    if (!state || state !== sessionState) {
      console.error("State non corrispondente! Possibile CSRF.");
      return res.status(400).send("State does not match!");
    }
    // Se lo state corrisponde, puoi cancellarlo dalla sessione
    if (req.session) {
      delete req.session.oauth_state;
    }
  }

  if (!code) {
    console.error("Nessun code presente nel callback");
    return res.status(400).send("Code missing");
  }

  console.log("Scambio code con access_token e refresh_token tramite Basic Auth...");

  // Preparazione dell'header Basic Auth
  const credentials = Buffer.from(`${PIPEDRIVE_CLIENT_ID}:${PIPEDRIVE_CLIENT_SECRET}`).toString('base64');

  try {
    const tokenResponse = await axios.post('https://oauth.pipedrive.com/oauth/token', new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri
    }).toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${credentials}`
      }
    });

    console.log("tokenResponse.data:", tokenResponse.data);
    const { access_token, refresh_token, expires_in, scope, api_domain } = tokenResponse.data;
    console.log("Access token ricevuto:", access_token ? "OK" : "NO TOKEN");

    if (!access_token) {
      console.error("Nessun access_token nella risposta");
      return res.status(500).send("Errore nell'ottenere l'access token");
    }

    // Estrarre company_id e user_id dal refresh_token
    const refreshTokenParts = refresh_token.split(':');
    if (refreshTokenParts.length < 2) {
      console.error("Refresh token non contiene company_id e user_id");
      return res.status(500).send("Invalid refresh token format");
    }

    const company_id = refreshTokenParts[0];
    const user_id = refreshTokenParts[1];
    const userKey = `${company_id}_${user_id}`;

    // Salva i token sotto la chiave unica
    tokens[userKey] = {
      access_token,
      refresh_token,
      expires_in,
      scope,
      api_domain,
      expires_at: Math.floor(Date.now() / 1000) + expires_in
    };
    saveTokens();

    // Salva l'utente nella sessione
    if (req.session) {
      req.session.user_key = userKey;
      req.session.access_token = access_token;
    }

    req.session.save(err => {
      if (err) {
        console.error("Errore nel salvataggio della sessione:", err);
        return res.status(500).send("Errore nel salvataggio della sessione");
      }
      console.log("Sessione aggiornata, token salvato, redirect a BASE_URL:", BASE_URL);
      res.redirect(BASE_URL);
    });
  } catch (err) {
    console.error("Errore nello scambio del token:", err.response ? err.response.data : err.message || err);
    res.status(500).send("Errore nello scambio del token");
  }
});

// Gestione del webhook di Uninstall da Pipedrive
app.delete(`${BASE_PATH}/oauth/callback`, express.json(), async (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  const expectedAuth = 'Basic ' + Buffer.from(`${PIPEDRIVE_CLIENT_ID}:${PIPEDRIVE_CLIENT_SECRET}`).toString('base64');

  if (authHeader !== expectedAuth) {
    console.error("Invalid Authorization header");
    return res.status(401).send("Unauthorized");
  }

  const { client_id, company_id, user_id, timestamp } = req.body;

  if (client_id !== PIPEDRIVE_CLIENT_ID) {
    console.error("Invalid client_id in uninstall webhook");
    return res.status(400).send("Invalid client_id");
  }

  console.log(`Received uninstall webhook from Pipedrive for company_id: ${company_id}, user_id: ${user_id} at ${timestamp}`);

  const userKey = `${company_id}_${user_id}`;
  if (!tokens[userKey]) {
    console.warn("No tokens found for this user/company to revoke");
    return res.status(200).send("No tokens to revoke");
  }

  const { refresh_token } = tokens[userKey];

  if (!refresh_token) {
    console.warn("No refresh_token found to revoke");
    return res.status(200).send("No refresh_token to revoke");
  }

  // Revoca il refresh_token
  const revokeParams = new URLSearchParams({
    token: refresh_token,
    token_type_hint: 'refresh_token'
  }).toString();

  const credentials = Buffer.from(`${PIPEDRIVE_CLIENT_ID}:${PIPEDRIVE_CLIENT_SECRET}`).toString('base64');

  try {
    const revokeResponse = await axios.post('https://oauth.pipedrive.com/oauth/revoke', revokeParams, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${credentials}`
      }
    });

    console.log("Refresh token revoked:", revokeResponse.status);

    // Elimina il token dal file e dall'oggetto
    delete tokens[userKey];
    saveTokens();

    res.status(200).send("Uninstalled and tokens revoked");
  } catch (error) {
    console.error("Error revoking token:", error.response ? error.response.data : error.message);
    res.status(500).send("Error revoking token");
  }
});

// Route di test per verificare req.secure
app.get(`${BASE_PATH}/test-secure`, (req, res) => {
  res.send(`Secure: ${req.secure}, Protocol: ${req.protocol}`);
});

// Route di test per verificare l'impostazione dei cookie
app.get(`${BASE_PATH}/test-cookie`, (req, res) => {
  res.cookie('testcookie', 'testvalue', { secure: secureCookie, sameSite: 'none', path: BASE_PATH || '/' });
  res.send('Cookie di test impostato.');
});

// Route per la home
app.get(`${BASE_PATH}/`, (req, res) => {
  if (req.session && req.session.user_key && tokens[req.session.user_key] && tokens[req.session.user_key].access_token) {
    res.send('ok');
  } else {
    res.redirect(`${BASE_PATH}/oauth/login`);
  }
});

// Route protette (esempio)
app.get(`${BASE_PATH}/protected/dashboard`, authenticationMiddleware, (req, res) => {
  res.send('Benvenuto nel dashboard protetto!');
});

// 404 handler
app.use((req, res, next) => {
  res.status(404).send('Not Found');
});

// Log all the necessary URLs at start
console.log(`Callback URL to set in Pipedrive: ${redirect_uri}`);
console.log(`Installation URL to set in Pipedrive: ${installation_url}`);

// Avvia il server principale
app.listen(3000, () => console.log('Forward Auth server avviato sulla porta 3000'));

// ===============================
// Nuovo Servizio per Fornire Token
// ===============================

// Configura una nuova porta per il servizio dei token
const TOKEN_SERVICE_PORT = 4000;

// Inizializza una nuova app Express per il servizio dei token
const tokenApp = express();

// Middleware per log delle richieste al servizio dei token
tokenApp.use((req, res, next) => {
  console.log(`[Token Service] ${req.method} ${req.url}`);
  next();
});

// Definisci la route GET /token/:userId/:companyId
tokenApp.get('/token/:userId/:companyId', async (req, res) => {
  const { userId, companyId } = req.params;
  const userKey = `${companyId}_${userId}`;

  if (!tokens[userKey] || !tokens[userKey].access_token) {
    console.error(`[Token Service] Token non trovato per userKey: ${userKey}`);
    return res.status(404).json({ error: "Token not found" });
  }

  const tokenData = tokens[userKey];
  const currentTime = Math.floor(Date.now() / 1000);

  // Verifica se il token è scaduto o sta per scadere entro 5 minuti (300 secondi)
  if (tokenData.expires_at && (currentTime >= tokenData.expires_at || (tokenData.expires_at - currentTime) <= 300)) {
    console.log(`[Token Service] Token per userKey ${userKey} è scaduto o sta per scadere. Rinnovo in corso...`);
    try {
      await refreshAccessToken(userKey);
    } catch (err) {
      console.error(`[Token Service] Errore nel rinnovo del token per userKey ${userKey}:`, err.message);
      return res.status(500).json({ error: "Failed to refresh token" });
    }
  }

  // Restituisci il token aggiornato
  res.json({
    access_token: tokens[userKey].access_token,
    api_domain: tokens[userKey].api_domain,
    expires_at: tokens[userKey].expires_at
  });
});

// Avvia il servizio dei token su TOKEN_SERVICE_PORT
tokenApp.listen(TOKEN_SERVICE_PORT, () => {
  console.log(`Token Service avviato sulla porta ${TOKEN_SERVICE_PORT}`);
});
