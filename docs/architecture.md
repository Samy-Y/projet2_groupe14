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

## Pipeline SVG (UI)

1. L'utilisateur charge un fichier `.svg`.
2. `app.js` lit le fichier, l'envoie au `worker.js`.
3. Le worker parse les nœuds graphiques et transforme chaque courbe en polylignes.
4. Le worker renvoie un tableau de polylignes sérialisées.
5. `app.js` met à jour l'aperçu et le compteur de segments.

Ce découplage évite les gels du navigateur quand des SVG complexes sont chargés.

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

## Concurrence d'exécution

La logique lourde (parsing SVG) est isolée dans un Web Worker. Les messages échangés sont réduits au strict nécessaire :

- In : texte SVG brut.
- Out : polylignes compactes (tableaux de points).

Cette stratégie limite les échanges volumineux et garantit un rendu stable, même pour des SVG volumineux.

## Principes de lisibilité

L'architecture est volontairement explicite :
- fonctions nommées clairement (`drawPreviewCanvas`, `handleSvgUpload`),
- séparation strict UI vs parsing,
- aucun framework imposant un modèle de structure.

L'objectif est de conserver une base modifiable et compréhensible.