#include <Wire.h>
const int CLK1=7, EN1=5, CW1=6, LIMIT1=52; // moteur 1 ; fin de course y
const int CLK2=4, EN2=2, CW2=3, LIMIT2=48; // moteur 2 ; fdc. x
const int CLK3=10, EN3=8, CW3=9, LIMIT3=50; // moteur selon Z

int   STEPS_PER_REV      = 200;
int   MM_PER_REV         = 40; // MOTEURS PLAN XY
int   MM_PER_REV_Z       = 8;  // MOTEUR Z
float MAX_TRAVEL_MM      = 250.0f; 
float MAX_TRAVEL_Z_MM    = 10000.0f;
float MAX_STEPS_Z        = 10000.0f;
int   HOMING_HALF_PERIOD = 500;
int   RELEASE_STEPS      = 200;
float ACCEL_RPM_PER_STEP = 0.2f;
const float MIN_RPM      = 0.0f;
const float MAX_RPM      = 1000.0f;
const bool  VERBOSE      = false;

// ATTENTION : CE CODE NE CONTIENT PAS LA GESTION DE VITESSE PAR PROFIL TRAPEZOIDAL
// ATTENTION : CE CODE NE CONTIENT PAS LA GESTION DE VITESSE PAR PROFIL TRAPEZOIDAL
// ATTENTION : CE CODE NE CONTIENT PAS LA GESTION DE VITESSE PAR PROFIL TRAPEZOIDAL

// NOTES :

// y+ >> 1: HIGH 2: LOW
// y- >> 1: LOW  2: HIGH

// x+ >> 1: LOW  2: LOW
// x- >> 1: HIGH 2: HIGH

float MM_PER_STEP;
float MM_PER_STEP_Z;
long  MAX_STEPS;
long  stepsX=0, stepsY=0, stepsZ=0;

void sendOk() { Serial.println(F("OK")); }
void sendErr() { Serial.println(F("ERR")); }
void sendLimit(const __FlashStringHelper* axis) {
  Serial.print(F("LIMIT "));
  Serial.println(axis);
}

void recalculerDerives() {
  MM_PER_STEP = MM_PER_REV / (float)STEPS_PER_REV;
  MM_PER_STEP_Z = MM_PER_REV_Z / (float)STEPS_PER_REV;
  MAX_STEPS   = (long)round(MAX_TRAVEL_MM / MM_PER_STEP);
}

// ═══════════════════════════════ UTILS ═══════════════════════════════
long          mmToSteps(float mm)        { return (long)round(mm / MM_PER_STEP); }
long          mmToStepsZ(float mm)        { return (long)round(mm / MM_PER_STEP_Z); }
unsigned long rpmToHP  (float rpm)       { return (unsigned long)(30000000.0f / (rpm * STEPS_PER_REV)); }

unsigned long rampedHP(long i, long total, float targetRpm) {
  float ramp = constrain((targetRpm - MIN_RPM) / ACCEL_RPM_PER_STEP, 1.0f, (float)(total/2));
  float rpm;
  if      (i < (long)ramp)            rpm = MIN_RPM + i * ACCEL_RPM_PER_STEP;
  else if (i >= total - (long)ramp)   rpm = MIN_RPM + (total-1-i) * ACCEL_RPM_PER_STEP;
  else                                rpm = targetRpm;
  return rpmToHP(max(rpm, MIN_RPM));
}

void stepMotors(byte mask, unsigned long hp) {
  if (mask & 0x01) digitalWrite(CLK1, HIGH);
  if (mask & 0x02) digitalWrite(CLK2, HIGH);
  if (mask & 0x04) digitalWrite(CLK3, HIGH); // L'axe Z (Bit 2)
  delayMicroseconds(hp);
  if (mask & 0x01) digitalWrite(CLK1, LOW);
  if (mask & 0x02) digitalWrite(CLK2, LOW);
  if (mask & 0x04) digitalWrite(CLK3, LOW);
  delayMicroseconds(hp);
}

void libererCapteur(int axe, unsigned long hp) {
  // axe 1: x
  // axe 2: y
  // axe 3: z
  int lim = (axe==1)?LIMIT1 : (axe==2)?LIMIT2 : LIMIT3;
  byte mask = (axe==3)? 0x04 : 0x03; // 0x04 pour Z, 0x03 pour M1+M2

  if (axe == 1)      { digitalWrite(CW1, LOW); digitalWrite(CW2, LOW); }
  else if (axe == 2) { digitalWrite(CW1, HIGH); digitalWrite(CW2, LOW);  }
  else if (axe == 3) { digitalWrite(CW3, HIGH); }
  int tentatives = 0;
  while (digitalRead(lim) == LOW && tentatives < 5) {
    Serial.print(F("Degagement axe ")); Serial.print(axe);
    Serial.print(F(" - Tentative ")); Serial.println(tentatives + 1);
    for (int j=0; j<RELEASE_STEPS && digitalRead(lim)==LOW; j++) {
      stepMotors(mask, hp); 
    }
    tentatives++;
    delay(50); 
  }
  if (digitalRead(lim) == LOW) {
    Serial.print(F("ATTENTION: Capteur ")); Serial.print(axe);
    Serial.println(F(" reste bloque ! Verifiez le systeme mécanique."));
  }
}

void afficherPosition() {
  Serial.print(F(">> X=")); Serial.print(stepsX*MM_PER_STEP,2);
  Serial.print(F("mm Y=")); Serial.print(stepsY*MM_PER_STEP,2);
  Serial.print(F("mm Z=")); Serial.print(stepsZ*MM_PER_STEP,2);
  Serial.print(F("mm  [0-")); Serial.print(MAX_TRAVEL_MM,0);
  Serial.print(F(" / 0-")); Serial.print(MAX_TRAVEL_Z_MM,0);
  Serial.println(F("mm]"));
  sendOk();
}

// ═══════════════════════════════ HOMING ══════════════════════════════

void homingXY() {
  Serial.println(F("--- Homing XY (Cartésien) ---"));
  // 1. AXE X
  libererCapteur(1, HOMING_HALF_PERIOD); // Dégage X si déjà appuyé
  digitalWrite(CW1, HIGH); 
  digitalWrite(CW2, HIGH); 
  long sX = 0;
  while (digitalRead(LIMIT1) == HIGH && sX < MAX_STEPS * 2) {
    stepMotors(0x03, HOMING_HALF_PERIOD);
    sX++;
  }
  if (sX >= MAX_STEPS * 2) { 
    sendLimit(F("X - NON TROUVE")); 
    return; // On arrête  si X échoue
  }
  libererCapteur(1, HOMING_HALF_PERIOD);
  // 2. AXE Y
  libererCapteur(2, HOMING_HALF_PERIOD); // Dégage Y si déjà appuyé
  digitalWrite(CW1, LOW); 
  digitalWrite(CW2, HIGH); 
  long sY = 0;
  while (digitalRead(LIMIT2) == HIGH && sY < MAX_STEPS * 2) {
    stepMotors(0x03, HOMING_HALF_PERIOD); 
    sY++;
  }
  if (sY >= MAX_STEPS * 2) { 
    sendLimit(F("Y - NON TROUVE")); 
    return; 
  }
  libererCapteur(2, HOMING_HALF_PERIOD);
  stepsX = 0; 
  stepsY = 0;
  Serial.println(F("Origine (0,0) trouvée !"));
  sendOk();
}
void homingZ() {
  Serial.println(F("--- Homing Z ---"));
  if (digitalRead(LIMIT3) == LOW) {
    Serial.println(F("Capteur Z déjà actif, libération..."));
    libererCapteur(3, HOMING_HALF_PERIOD);
  }
  Serial.println(F("DEBUT DE LA PROCEDURE"));
  Serial.println(F("MONTEE VERS LE HAUT"));
  digitalWrite(CW3, LOW);
  long sZ = 0;

  while (digitalRead(LIMIT3) == HIGH && sZ < MAX_STEPS_Z * 2) {
    Serial.println(F("MONTEE DU STYLET"));
    stepMotors(0x04, HOMING_HALF_PERIOD); 
    sZ++;
  }
  if (sZ >= MAX_STEPS_Z * 2) {sendLimit(F("Z - NON TROUVE"));return;}
  libererCapteur(3, HOMING_HALF_PERIOD);  
  if (digitalRead(LIMIT3) == LOW) {
    Serial.println(F("Erreur : capteur Z toujours actif après libération !"));
    return;
  }
  stepsZ = 0;
  Serial.println(F("Origine Z trouvée !"));
  sendOk();
}

// ═══════════════════════════════ MOVES ═══════════════════════════════
void deplacerXY(float dx, float dy, float rpm) {
    rpm = constrain(rpm, MIN_RPM, MAX_RPM);

    long clampX = constrain(stepsX+mmToSteps(dx), 0L, MAX_STEPS);
    long clampY = constrain(stepsY+mmToSteps(dy), 0L, MAX_STEPS);
    long realDX = clampX-stepsX,  realDY = clampY-stepsY;
    if (realDX==0 && realDY==0) { Serial.println(F("Deja en limite.")); afficherPosition(); return; }
    if (clampX != stepsX+mmToSteps(dx)) { Serial.print(F("Limite X: ")); Serial.print(clampX*MM_PER_STEP,1); Serial.println(F("mm")); }
    if (clampY != stepsY+mmToSteps(dy)) { Serial.print(F("Limite Y: ")); Serial.print(clampY*MM_PER_STEP,1); Serial.println(F("mm")); }

    long pasM1=-realDX+realDY,  pasM2=-realDX-realDY;
    bool dir1=(pasM1>=0),      dir2=(pasM2>=0);
    digitalWrite(CW1, dir1?HIGH:LOW);
    digitalWrite(CW2, dir2?HIGH:LOW);
    long absM1=abs(pasM1), absM2=abs(pasM2), total=max(absM1,absM2);

    Serial.print(F("XY ")); Serial.print(realDX*MM_PER_STEP,1);
    Serial.print(F(",")); Serial.print(realDY*MM_PER_STEP,1);
    Serial.print(F("mm @ ")); Serial.print(rpm); Serial.println(F(" RPM"));

    long dM1=0, dM2=0;
    long eM1=total/2, eM2=total/2;

    long currentHP = (300000 ) / (rpm * 200);

    for (long i=0; i<total; i++) {
        if (Serial.available() && (Serial.peek()=='a'||Serial.peek()=='A')) {
        Serial.read();
        long s1=dir1?dM1:-dM1, s2=dir2?dM2:-dM2;
        stepsX=constrain(stepsX+(s1+s2)/2, 0L,MAX_STEPS);
        stepsY=constrain(stepsY+(s1-s2)/2, 0L,MAX_STEPS);
        Serial.println(F("\n!!! ARRET XY !!!"));  afficherPosition(); return;
        }
        if (digitalRead(LIMIT1)==LOW || digitalRead(LIMIT2)==LOW) {
        long s1=dir1?dM1:-dM1, s2=dir2?dM2:-dM2;
        stepsX=constrain(stepsX+(s1+s2)/2, 0L,MAX_STEPS);
        stepsY=constrain(stepsY+(s1-s2)/2, 0L,MAX_STEPS);
        sendLimit(F("XY"));
        Serial.println(F("\n!!! FIN DE COURSE XY !!!")); afficherPosition(); return;
    }

    byte mask=0;
    eM1+=absM1; if(eM1>=total){mask|=0x01; eM1-=total; dM1++;}
    eM2+=absM2; if(eM2>=total){mask|=0x02; eM2-=total; dM2++;}

    if (mask) stepMotors(mask, currentHP);
    }
    stepsX=clampX; stepsY=clampY;
    Serial.println(F("\nTermine.")); afficherPosition();
    sendOk();
}

void deplacerZ(float dz, float rpm) {
  rpm = constrain(rpm, MIN_RPM, MAX_RPM);
  
  long maxStepsZ = (long)round(MAX_TRAVEL_Z_MM/MM_PER_STEP);
  long clampZ    = constrain(stepsZ+mmToStepsZ(dz), 0L, maxStepsZ);
  long realDZ    = clampZ-stepsZ;
  if (realDZ==0) { Serial.println(F("Deja en limite Z.")); afficherPosition(); return; }
  if (clampZ != stepsZ+mmToStepsZ(dz)) { Serial.print(F("Limite Z: ")); Serial.print(clampZ*MM_PER_STEP,1); Serial.println(F("mm")); }

  bool dirZ=(realDZ>=0);
  digitalWrite(CW3, dirZ?HIGH:LOW);
  long absZ=abs(realDZ), dZ=0;

  Serial.print(F("Z ")); Serial.print(realDZ*MM_PER_STEP,1);
  Serial.print(F("mm @ ")); Serial.print(rpm); Serial.println(F(" RPM"));

  for (long i=0; i<absZ; i++) {
    if (Serial.available() && (Serial.peek()=='a'||Serial.peek()=='A')) {
      Serial.read();
      stepsZ=constrain(stepsZ+(dirZ?dZ:-dZ), 0L,maxStepsZ);
      Serial.println(F("\n!!! ARRET Z !!!")); afficherPosition(); return;
    }
    if (digitalRead(LIMIT3)==LOW) {
      stepsZ=constrain(stepsZ+(dirZ?dZ:-dZ), 0L,maxStepsZ);
      sendLimit(F("Z"));
      Serial.println(F("\n!!! FIN DE COURSE Z !!!")); afficherPosition(); return;
    }
    unsigned long hp= (300000 ) / (rpm * 200);
    digitalWrite(CLK3,HIGH); delayMicroseconds(hp);
    digitalWrite(CLK3,LOW);  delayMicroseconds(hp);
    dZ++;
  }
  stepsZ=clampZ;
  Serial.println(F("\nTermine.")); afficherPosition();
  sendOk();
}

// ═══════════════════════════════ PARAM EDITOR ════════════════════════
void editerParametres() {
  Serial.println(F("\n=== PARAMETRES ==="));
  Serial.print(F("1)STEPS_PER_REV=")); Serial.println(STEPS_PER_REV);
  Serial.print(F("2)MM_PER_REV="));    Serial.println(MM_PER_REV,4);
  Serial.print(F("3)MAX_TRAVEL_MM=")); Serial.println(MAX_TRAVEL_MM,1);
  Serial.print(F("4)HOMING_HP="));     Serial.println(HOMING_HALF_PERIOD);
  Serial.print(F("5)RELEASE_STEPS=")); Serial.println(RELEASE_STEPS);
  Serial.print(F("6)ACCEL_RPM/STEP=")); Serial.println(ACCEL_RPM_PER_STEP,4);
  Serial.println(F("0)Annuler"));

  auto waitSerial = [](unsigned long ms) -> bool {
    unsigned long t=millis();
    while(!Serial.available()) { if(millis()-t>ms){ Serial.println(F("Timeout.")); return false; } }
    return true;
  };

  if (!waitSerial(10000)) return;
  int num = Serial.readStringUntil('\n').toInt();
  if (num==0||num<1||num>6) { Serial.println(F("Annule.")); return; }

  Serial.print(F("Nouvelle valeur: "));
  if (!waitSerial(10000)) return;
  float val = Serial.readStringUntil('\n').toFloat();

  float oldMPS = MM_PER_STEP;
  switch(num) {
    case 1: if(val<1)   {Serial.println(F("Invalide.")); return;} STEPS_PER_REV=(int)val; break;
    case 2: if(val<=0)  {Serial.println(F("Invalide.")); return;} MM_PER_REV=val;         break;
    case 3: if(val<=0)  {Serial.println(F("Invalide.")); return;} MAX_TRAVEL_MM=val;      break;
    case 4: if(val<100) {Serial.println(F("Invalide.")); return;} HOMING_HALF_PERIOD=(int)val; break;
    case 5: if(val<0)   {Serial.println(F("Invalide.")); return;} RELEASE_STEPS=(int)val; break;
    case 6: if(val<=0)  {Serial.println(F("Invalide.")); return;} ACCEL_RPM_PER_STEP=val; break;
  }
  recalculerDerives();
  stepsX=mmToSteps(constrain(stepsX*oldMPS, 0.0f, MAX_TRAVEL_MM));
  stepsY=mmToSteps(constrain(stepsY*oldMPS, 0.0f, MAX_TRAVEL_MM));
  stepsZ=mmToStepsZ(constrain(stepsZ*oldMPS, 0.0f, MAX_TRAVEL_Z_MM));
  Serial.println(F("OK. Homing recommande si STEPS ou MM_REV changes."));
  afficherPosition();
  sendOk();
}

void experimentStart() {
  Serial.println(F("temps_ms,accel_x")); // En-tête du fichier CSV pour Tera Term

  unsigned long hp = rpmToHP(MAX_RPM); // Demi-période pour 120 RPM
  
  // Définition de la direction (Mouvement pur selon l'axe X)
  digitalWrite(CW1, HIGH);
  digitalWrite(CW2, HIGH);

  unsigned long currentMicros = micros();
  unsigned long nextSampleMicros = currentMicros;
  unsigned long nextStepMicros = currentMicros;
  unsigned long startTime = millis();
  bool stepState = false;

  // ════════ PHASE 1 : MOUVEMENT ET ENREGISTREMENT (1 Seconde) ════════
  while (millis() - startTime < 1000) {
    currentMicros = micros();

    // Tâche d'échantillonnage de l'accéléromètre (Cadencée à 1000 Hz)
    if (currentMicros >= nextSampleMicros) {
      nextSampleMicros += 1000;
      
      // Lecture directe du registre Accel_X (0x3B et 0x3C)
      Wire.beginTransmission(0x68);
      Wire.write(0x3B);
      Wire.endTransmission(false);
      Wire.requestFrom(0x68, 2);
      int16_t ax = (Wire.read() << 8) | Wire.read();

      // Envoi brut minimaliste pour préserver la bande passante série
      Serial.print(millis() - startTime);
      Serial.print(',');
      Serial.println(ax);
    }

    // Tâche de commande des moteurs à vitesse constante (120 RPM)
    if (currentMicros >= nextStepMicros) {
      nextStepMicros += hp;
      stepState = !stepState;
      digitalWrite(CLK1, stepState);
      digitalWrite(CLK2, stepState);
    }

    // Sécurité : Butee d'arrêt d'urgence active pendant la translation
    if (digitalRead(LIMIT1) == LOW || digitalRead(LIMIT2) == LOW) {
      break;
    }
  }

  // ════════ ARRÊT BRUSQUE (Coupure instantanée des signaux de commande) ════════
  digitalWrite(CLK1, LOW);
  digitalWrite(CLK2, LOW);

  // ════════ PHASE 2 : ENREGISTREMENT DE L'OSCILLATION LIBRE (4 Secondes) ════════
  unsigned long stopTime = millis();
  while (millis() - stopTime < 4000) {
    currentMicros = micros();

    if (currentMicros >= nextSampleMicros) {
      nextSampleMicros += 1000;

      Wire.beginTransmission(0x68);
      Wire.write(0x3B);
      Wire.endTransmission(false);
      Wire.requestFrom(0x68, 2);
      int16_t ax = (Wire.read() << 8) | Wire.read();

      Serial.print(millis() - startTime);
      Serial.print(',');
      Serial.println(ax);
    }
  }
  
  // Notification de fin de protocole lue par l'utilisateur
  Serial.println(F("# FIN_EXPERIENCE")); 
}

// ═══════════════════════════════ SETUP / LOOP ════════════════════════
void setup() {
  Serial.begin(115200);
  
  // Initialisation I2C et passage en mode Fast (400 kHz) 
  // UNIQUEMENT POUR L'EXPERIENCE
  Wire.begin();
  Wire.setClock(400000);
  
  // Réveil du MPU6050 (Registre 0x6B à 0)
  Wire.beginTransmission(0x68);
  Wire.write(0x6B);
  Wire.write(0);
  Wire.endTransmission();

  recalculerDerives();
  for (int p : (int[]){CLK1,EN1,CW1,CLK2,EN2,CW2,CLK3,EN3,CW3}) pinMode(p,OUTPUT);
  for (int p : (int[]){LIMIT1,LIMIT2,LIMIT3}) pinMode(p,INPUT_PULLUP);
  digitalWrite(EN1,LOW); digitalWrite(EN2,LOW); digitalWrite(EN3,LOW);
  
  Serial.println(F("=== G14 - TRACEUR ==="));
  Serial.println(F("ATTENTION : TESTS UNITAIRES - PAS DE PROFIL TRAPEZOIDAL DE VITESSE"));
  Serial.println(F("x<mm>v<rpm> | y<mm>v<rpm> | x<mm>y<mm>v<rpm> | z<mm>v<rpm>"));
  Serial.println(F("s=position  i=homingXY  k=homingZ  p=params  e=EXPERIENCE  a=STOP"));
}

void loop() {
  if (!Serial.available()) return;
  if (Serial.peek()=='a'||Serial.peek()=='A') {
    Serial.read(); Serial.println(F("!!! ARRET !!!")); afficherPosition();
    while(Serial.available()) Serial.read(); return;
  }
  String inp = Serial.readStringUntil('\n'); inp.trim();
  if (inp.length()==0) return;
  char cmd = tolower(inp.charAt(0));
  if (cmd=='s') { afficherPosition(); return; }
  if (cmd=='i') { homingXY();           return; }
  if (cmd=='k') { homingZ();          return; }
  if (cmd=='e') { experimentStart();  return; }
  if (cmd=='p') { editerParametres(); return; }
  if (cmd=='a') { Serial.println(F("!!! ARRET !!!")); afficherPosition(); return; }

  if (cmd=='z') {
    int v=inp.indexOf('v');
    if (v==-1){Serial.println(F("Ex: z30v60")); sendErr(); return;}
    float dz=inp.substring(1,v).toFloat(), rpm=inp.substring(v+1).toFloat();
    deplacerZ(dz,rpm); return;
  }

  int xi=inp.indexOf('x'), yi=inp.indexOf('y'), vi=inp.indexOf('v');
  if (vi==-1||(xi==-1&&yi==-1)){Serial.println(F("Ex: x50v60 | y-30v40 | x50y50v60")); sendErr(); return;}
  float dx=0,dy=0;
  if (xi!=-1) dx=inp.substring(xi+1,(yi!=-1&&yi>xi)?yi:vi).toFloat();
  if (yi!=-1) dy=inp.substring(yi+1,vi).toFloat();
  float rpm=inp.substring(vi+1).toFloat();
  if(dx==0&&dy==0){Serial.println(F("Valeur invalide.")); sendErr(); return;}
  deplacerXY(dx,dy,rpm);
}