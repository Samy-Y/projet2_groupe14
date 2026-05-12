# Installation locale

## Serveur local
Pour héberger le projet localement, vous pouvez utiliser un serveur HTTP simple. Voici deux méthodes recommandées :
### Option A (recommandée) : Live Server (Extension VS Code)
1. Ouvrez le projet dans Visual Studio Code.
2. Ouvrez `index.html` dans VS Code.
3. Cliquez sur "Go Live" en bas à droite (Live Server).
4. Rendez-vous sur `http://localhost:5500` (ou le port indiqué) pour accéder à l'interface.
### Option B : Python HTTP Server
1. Ouvrez un terminal dans le dossier du projet.
2. Exécutez la commande suivante pour lancer un serveur HTTP local :
```bash
python -m http.server 8000
```
3. Rendez-vous sur `http://localhost:8000` dans votre navigateur.

## Documentation MkDocs locale
Si vous souhaitez consulter la documentation MkDocs localement, vous pouvez également utiliser MkDocs pour servir les fichiers :
1. Assurez-vous d'avoir Python et MkDocs installés.
```bash
pip install mkdocs mkdocs-material
```
2. Dans le terminal, naviguez jusqu'au dossier du projet et exécutez :
```bash
mkdocs serve
```
3. Rendez-vous sur `http://localhost:8000` pour accéder à la documentation.