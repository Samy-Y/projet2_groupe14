# Guide d'Installation et Déploiement

## 1. Exécution Locale
Puisque le projet est "Vanilla" (HTML, CSS, JS basique), aucun framework lourd (ex: React, npm) n'est nécessaire pour l'interface de base.
Cependant, l'utilisation de Web Workers (`worker.js`) requiert l'exécution via un serveur local (pour des raisons de sécurité CORS).

**Option A : Live Server (Extension VS Code)**
1. Ouvrez `index.html` dans VS Code.
2. Cliquez sur "Go Live" en bas à droite (Live Server).

**Option B : Python HTTP Server**
1. Ouvrez un terminal dans ce dossier.
2. Exécutez `python -m http.server 8000`.
3. Naviguez sur `http://localhost:8000`.

## 2. Déploiement sur GitHub Pages (incluant MkDocs)
Ce dépôt inclut MkDocs pour la documentation avancée étudiante.

### Étape 1 : Préparation de GitHub Actions
Créez un fichier `.github/workflows/deploy.yml` avec le contenu standard pour MkDocs. 
L'interface (index.html) sera copiée à côté de la documentation.
> Note : Le fichier est déjà présent dans ce dépôt.

### Étape 2 : Dépendances d'environnement
Afin de générer la doc localement avant le push :
```bash
pip install mkdocs mkdocs-material
mkdocs serve
```

### Étape 3 : Compatibilité WebSerial
Notez que le WebSerial nécessite un contexte sécurisé (HTTPS). GitHub Pages gère le HTTPS nativement, permettant de driver la machine cartésienne directement depuis votre site `https://votre-repo.github.io/`.
