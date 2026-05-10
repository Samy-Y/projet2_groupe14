# Système Cartésien - Interface WebSerial

Ce dépôt contient le code source de l'interface de pilotage hautes performances développée par le **Groupe 14 - Class2030 (UM6P-EMINES)** pour un traceur de plans cartésien CoreXY (H-Bot) avec compliance Z.

L'interface est entièrement construite en HTML5, CSS3, et Vanilla JS. Elle communique avec le micrologiciel Arduino Mega 2560 natif via l'API WebSerial, sans intergiciels (pas de serveur Node.js ou Python entre le navigateur et la carte).

## Structure du Dépôt Principal

- `index.html` : L'interface principale (Vue, Commande, Logs).
- `styles.css` : Styles responsive et dark/light mode setup (flat design).
- `app.js` : Logique de la machine à états (IDLE, HOMING, RUNNING, ERROR), communication série.
- `worker.js` : Web Worker pour la discrétisation des fichiers SVG lourds en arrière-plan.
- `mkdocs.yml` / `docs/` : Documentation (MkDocs Material).
- `INSTALL.md` : Guide d'installation et de déploiement GitHub Pages.
- `assets/` : Ressources graphiques (logotypes, illustrations).
- `SYSTEME_CARTESIEN.ino` : Micrologiciel Arduino Mega fourni.

## Équipe d'Ingénierie
- Samy Youssoufine
- Soufiane Bourghel
- Riham Boughrara
- Rita Tamma

*Projet P2 - Première année cycle préparatoire intégré (CPI-1A).*