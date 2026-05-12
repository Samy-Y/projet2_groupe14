# API & Communication WebSerial

Le traceur communique avec le navigateur via le protocole UART (115200 bauds), encodé en texte brut. L'architecture d'envoi fonctionne de type « Stop-and-wait » (Ping/Pong) pour éviter la saturation du buffer de la carte.

## Format des trames (Protocole Custom)

Le système n'utilise **pas** le G-Code standard. Les trames sont formattées avec des symboles minuscules suivis de leurs valeurs numériques.

**Commandes de mouvement :**
- `x<mm>y<mm>v<rpm>` : Déplacement simultané **relatif** (Deltas), à la vitesse `v` (en RPM).
- `x<mm>v<rpm>` : Déplacement relatif uniquement sur l'axe X.
- `y<mm>v<rpm>` : Déplacement relatif uniquement sur l'axe Y.
- `z<mm>v<rpm>` : Déplacement relatif du stylo sur l'axe Z (descendre avec -z, monter avec +z).

**Commandes système :**
- `i` : Homing XY (Auto-Origine).
- `k` : Homing Z.
- `s` : Retourne la position absolue actuelle (`>> X=...`).
- `p` : Lance l'édition des paramètres dynamiques via la série (Attention: interface de sous-menu bloquant).
- `a` ou `A`: Arrêt d'urgence (Interrompt instanément, même scrutté de manière asynchrone).

**Exemple de flux :**
1. PC -> Arduino: `i` (Ordre de Homing)
2. Arduino -> PC: `OK`
3. PC -> Arduino: `x10.5y20.0v100` (Se DÉPLACER de +10.5mm en X et +20mm en Y à 100 RPM)
4. Arduino -> PC: `OK`
5. PC -> Arduino: `z-5v10` (Baisser le stylo de -5mm à 10 RPM)
6. Arduino -> PC: `OK`

## Implémentation DDA Arduino
Côté Arduino, les algorithmes de mouvement planifient un profil de vitesse trapézoïdal pour réaliser des lignes droites physiques, traduisant les distances (Deltas X, Y) en un nombre total de pas à effectuer et proportionnellement pour les moteurs Alpha et Beta.

L'Arduino s'attend de manière critique à recevoir une validation de type "`OK`", "`ERR`" ou "`LIMIT X/Y`" en retour. Il est primordial que la boucle JS patiente (Handshake strict) avant le prochain envoi.

> Plus de détails dans le rapport technique de la soutenance 3.