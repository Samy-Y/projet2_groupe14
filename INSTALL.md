# Guide d'Installation et Déploiement

## 1. Exécution Locale
Puisque le projet est "Vanilla" (HTML, CSS, JS basique), aucun framework lourd (ex: React, npm) n'est nécessaire pour l'interface de base. Cependant, l'utilisation de Web Workers (`worker.js`) requiert l'exécution via un serveur local (pour des raisons de sécurité CORS). Si l'utilisation de l'interface se fait via le site hébergé sur GitHub Pages, cette étape n'est pas nécessaire, et les Web Workers fonctionnent côté client.

**Option A (recommandée) : Live Server (Extension VS Code)**

**Option B : Python HTTP Server**
```bash
cd path/to/project
python -m http.server 8000
```
