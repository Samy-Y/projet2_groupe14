# Architecture de l'Interface Graphique

Ce document décrit **uniquement** l'architecture de l'interface web (UI), ses modules, ses flux internes et les choix techniques qui garantissent une expérience fluide, robuste et compréhensible.

## Objectifs UI

- Réagir instantanément aux actions utilisateur (chargement SVG, déplacement, scale, démarrage). 
- Offrir une prévisualisation fidèle et rapide, sans bloquer le fil principal.
- Garder l'interface simple côté utilisateur, tout en exposant des réglages précis.
- Isoler le rendu, la logique d'état et l'analyse SVG dans des composants clairs.

## Empilement technologique

L'interface utilise un empilement **Vanilla** (HTML5, CSS3, JS) sans framework pour :
- réduire le poids initial,
- conserver un contrôle total sur le rendu,
- éviter les contraintes d'outillage (build, bundlers),
- faciliter la compréhension pour un contexte pédagogique.

## Découpage logique (fichiers)

- `index.html` : structure de l'interface, zones, contrôles, modales.
- `styles.css` : identité visuelle et layout (grille, boutons, couleurs, états UI).
- `app.js` : logique centrale de l'UI, gestion des états et actions utilisateur.
- `worker.js` : parsing SVG et discretisation hors UI thread.

## Boucle d'état de l'UI

L'interface repose sur un mini-state machine pour gérer les transitions sans ambiguïté :

- **IDLE** : aucun fichier chargé, interface prête.
- **READY** : fichier SVG chargé, prévisualisation disponible.
- **RUNNING** : envoi séquentiel des segments.
- **PAUSED** : transmission stoppée, état conservé.
- **ERROR** : état d'échec (perte de connexion, parsing, etc.).

Ce modèle réduit les erreurs d'interaction (ex: démarrer avant chargement) et facilite l'affichage d'états visuels cohérents.

## Architecture de Conversion SVG et Discrétisation

Le traitement d'un fichier SVG vers un système matériel requiert une transformation d'un format vectoriel descriptif complexe vers de simples déplacements linaires (polylignes). Pour ne pas geler le navigateur (à 60fps), cette tâche lourde de calcul géométrique est isolée dans un thread parallèle via Web Worker (`worker.js`).

### 1. Extraction et Parsing
Le script parcourt et extrait toutes les primitives géométriques (`<path>`, `<line>`, `<rect>`, `<polygon>`, `<polyline>`). 
L'axe Y peut être mathématiquement inversé lors de l'extraction (`invertY`) pour respecter le sens de fonctionnement réel du portique CoreXY.

### 2. Discrétisation des courbes (Flattening)
Le microcontrôleur Arduino utilise un algorithme DDA pour tracer des lignes strictes. L'UI doit alors s'occuper "d'aplatir" les courbes (Bézier Cubique : `C`, `c` dans le SVG).
L'algorithme utilise une évaluation paramétrique discrète :
$$ P(t) = (1-t)^3 P_0 + 3(1-t)^2 t P_1 + 3(1-t) t^2 P_2 + t^3 P_3 $$
avec $t \in [0, 1]$. La courbe est fragmentée en sous-segments linéaires d'une résolution suffisante (`numSegments`) pour être lue fluidement physiquement.

### 3. Optimisation Graphe (Nearest Neighbor)
Générer et envoyer la trajectoire brute d'un fichier `.svg` provoque souvent des allers-retours frénétiques dans les airs (stylo levé), usant la mécanique. 
À travers la fonction `optimizePathOrder()`, le Worker implémente une approximation du "Voyageur de commerce" (TSP) en *Nearest Neighbor* (plus proche voisin) :
- On part d'un point initial en `[0, 0]`.
- On calcule la distance euclidienne euclidienne ($\sqrt{\Delta x^2 + \Delta y^2}$) vers tous les points finaux et initiaux de toutes les polylignes non visitées.
- La polyligne est insérée dans la queue finale (et le tableau est inversé en mémoire si son point de sortie était plus proche que son point d'entrée de la position de notre tête virtuelle).
- Le cycle se répète jusqu'à l'assèchement local complet du tracé.

### 4. Scaling UI et Calcul des Deltas
En fin de session, des structures de points (`Array<{x, y}>`) arrivent sur le fil principal JS.
De là, l'interface prend le contrôle en temps réel lors du rendu ou de l'envoi :
1. Application d'une matrice affine (Scale/Offset).
2. Conversion de l'absolue en Deltas (`curX - startX`) avant acheminement à l'Arduino au format respecté de l'API (ex: `x100y-5v50`).

## Rendu d'aperçu

L'aperçu est rendu sur un canvas dédié, calculé en coordonnées **physiques** (mm) converties en pixels. 
L'UI applique une transformation unique (scale + offset) avant la projection :

- `scaleFactor` : ratio d'échelle (ex: 0.80 pour 80%).
- `offsetX` / `offsetY` : translation du dessin.

Cette architecture permet d'obtenir un rendu fidèle à la position finale, sans recalculer la géométrie brute.

## Contrôles de placement

Les réglages de placement se trouvent dans un bloc dédié (Support) :

- **Scale (%)** : ajuste uniformément le dessin.
- **Offset X / Y (mm)** : translation physique du tracé.
- **Format papier** : A4/A3 ou custom (limites visuelles).

Chaque contrôle déclenche un **redraw** immédiat du canvas, garantissant un feedback visuel instantané.

## Erreurs et feedback UI

Le canvas change de style (bord rouge) si un segment dépasse la zone définie. Cette alerte visuelle évite les sorties de course avant même le lancement.

Le système privilégie le **feedback immédiat** plutôt que les avertissements bloquants, pour conserver un flux utilisateur fluide.

## Principes de lisibilité

L'architecture est volontairement explicite :
- fonctions nommées clairement (`drawPreviewCanvas`, `handleSvgUpload`),
- séparation strict UI vs parsing,
- aucun framework imposant un modèle de structure.

L'objectif est de conserver une base modifiable et compréhensible.