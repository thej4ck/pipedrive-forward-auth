# Forward Auth Server for Pipedrive

Questo repository contiene il codice sorgente per il **Forward Auth Server** utilizzato per autenticare e gestire token OAuth con Pipedrive.

## Struttura del Progetto

- `app.js`: Codice principale dell'applicazione Express.
- `package.json`: Configurazione del progetto Node.js.
- `Dockerfile`: Configurazione Docker per l'applicazione.
- `docker-compose.yml`: Configurazione Docker Compose per eseguire l'applicazione e i relativi servizi.
- `.gitignore`: Specifica i file e le cartelle da escludere dal repository.
- `.env.example`: Esempio di file di variabili d'ambiente. Crea un file `.env` con le tue variabili.

## Prerequisiti

- [Docker](https://www.docker.com/get-started)
- [Docker Compose](https://docs.docker.com/compose/install/)
- [Node.js](https://nodejs.org/en/download/)
- [GitHub CLI (opzionale)](https://cli.github.com/)

## Come Usare

### 1. Clona il Repository

```bash
git clone https://github.com/thej4ck/pipedrive-forward-auth.git
cd pipedrive-forward-auth
```

### 2. Configura le Variabili d'Ambiente

Copia il file `.env.example` in `.env` e sostituisci i placeholder con i tuoi valori reali:

```bash
cp .env.example .env
```

Apri il file `.env` e inserisci le tue variabili:

```env
PIPEDRIVE_CLIENT_ID=your_pipedrive_client_id
PIPEDRIVE_CLIENT_SECRET=your_pipedrive_client_secret
SESSION_SECRET=your_session_secret
BASE_URL=https://lxp.scao.it
SECURE_COOKIE=true
TRUST_PROXY=2
BASE_PATH=/pipedrive-oauth
```

### 3. Costruisci e Avvia i Container Docker

```bash
docker-compose up -d --build
```

Questo comando costruirà l'immagine Docker e avvierà il container in modalità detached.

### 4. Verifica il Funzionamento

Visita `https://lxp.scao.it/pipedrive-oauth/` nel tuo browser per avviare il flusso OAuth.

## Gestione dei Token

I token OAuth vengono salvati nel volume Docker `forward-auth-data` per garantire la persistenza tra i riavvii dei container.

## Contribuire

Se desideri contribuire a questo progetto, sentiti libero di aprire issue o pull request.

## Licenza

Questo progetto è sotto licenza MIT.
