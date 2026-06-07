// --- Définition de vos broches ---
const int CLK1 = 8, EN1 = 6, CW1 = 7, LIMIT1 = 50;
const int CLK2 = 5, EN2 = 3, CW2 = 4, LIMIT2 = 52;
const int CLK3 = 11, EN3 = 9, CW3 = 10, LIMIT3 = 48;

// --- Constantes du test ---
const int STEPS_PER_REV = 200;
const int START_RPM = 10;
const int END_RPM = 120;
const int STEP_RPM = 5;       // Incrément de vitesse
const int TIME_PER_STEP = 5;  // Durée de chaque palier en secondes

void setup() {
  Serial.begin(115200);
  
  // Initialisation des broches en sortie
  int outputs[] = {CLK1, EN1, CW1, CLK2, EN2, CW2, CLK3, EN3, CW3};
  for (int pin : outputs) {
    pinMode(pin, OUTPUT);
  }

  // Désactivation des drivers (HIGH = désactivé sur la plupart des TB6560)
  // Modifier en LOW si vos drivers s'activent à l'état HAUT.
  digitalWrite(EN1, HIGH);
  digitalWrite(EN2, HIGH);
  digitalWrite(EN3, HIGH);

  Serial.println(F("=== PROGRAMME DE TEST DE RESONANCE ==="));
}

void loop() {
  // Exécution séquentielle pour les 3 moteurs
  testerMoteur(CLK1, CW1, EN1, "M1 (Axe X/Y - Gauche)");
  testerMoteur(CLK2, CW2, EN2, "M2 (Axe X/Y - Droit)");
  testerMoteur(CLK3, CW3, EN3, "M3 (Axe Z)");
  
  Serial.println(F("=== TOUS LES TESTS SONT TERMINES ==="));
  while (true); // Stoppe le programme
}

void testerMoteur(int clkPin, int cwPin, int enPin, String nomMoteur) {
  Serial.print(F("\n--- PREPARATION DU MOTEUR : "));
  Serial.print(nomMoteur);
  Serial.println(F(" ---"));
  Serial.println(F("1. Fixez le smartphone fermement sur le moteur."));
  Serial.println(F("2. Lancez l'enregistrement de l'accelerometre."));
  Serial.println(F("3. Tapez 'go' (puis Entree) dans le moniteur serie pour commencer le balayage."));

  // Attente de la commande "go"
  while (true) {
    if (Serial.available()) {
      String input = Serial.readStringUntil('\n');
      input.trim();
      if (input.equalsIgnoreCase("go")) {
        break;
      }
    }
  }

  Serial.println(F("Debut du test..."));
  
  // Activation du driver et définition du sens de rotation
  digitalWrite(enPin, LOW); 
  digitalWrite(cwPin, HIGH);

  // Balayage des vitesses
  for (int rpm = START_RPM; rpm <= END_RPM; rpm += STEP_RPM) {
    Serial.print(F("Palier en cours : "));
    Serial.print(rpm);
    Serial.println(F(" RPM"));

    // Calculs de la dynamique temporelle
    // (60 000 000 microsecondes par minute) / (200 pas * 2 etats(H/L) * RPM)
    unsigned long halfPeriodUS = 30000000UL / ((unsigned long)STEPS_PER_REV * rpm);
    
    // Calcul du nombre de pas nécessaires pour maintenir la vitesse pendant TIME_PER_STEP secondes
    long stepsToRun = ((long)rpm * STEPS_PER_REV * TIME_PER_STEP) / 60;

    // Exécution du palier
    for (long i = 0; i < stepsToRun; i++) {
      digitalWrite(clkPin, HIGH);
      delayMicroseconds(halfPeriodUS);
      digitalWrite(clkPin, LOW);
      delayMicroseconds(halfPeriodUS);
    }
  }

  // Désactivation du driver pour éviter la surchauffe pendant la manipulation du téléphone
  digitalWrite(enPin, HIGH);
  Serial.println(F("Fin du balayage pour ce moteur. Mettez l'enregistrement en pause."));
}