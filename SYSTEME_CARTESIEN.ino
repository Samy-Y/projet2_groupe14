const int CLK1=8, EN1=6, CW1=7, LIMIT1=50;
const int CLK2=5, EN2=3, CW2=4, LIMIT2=52;
const int CLK3=11, EN3=9, CW3=10, LIMIT3=48;

int   STEPS_PER_REV      = 200;
int   MM_PER_REV         = 40;
float MAX_TRAVEL_MM      = 400.0f;
float MAX_TRAVEL_Z_MM    = 100.0f;
int   HOMING_HALF_PERIOD = 2000;
int   RELEASE_STEPS      = 30;
float ACCEL_RPM_PER_STEP = 0.2f;
const float MIN_RPM      = 45.0f;
const float MAX_RPM      = 120.0f;
const bool  VERBOSE      = false;

float MM_PER_STEP;
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
  MAX_STEPS   = (long)round(MAX_TRAVEL_MM / MM_PER_STEP);
}

// ═══════════════════════════════ UTILS ═══════════════════════════════
long          mmToSteps(float mm)        { return (long)round(mm / MM_PER_STEP); }
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
  if (mask&0x01) digitalWrite(CLK1, HIGH);
  if (mask&0x02) digitalWrite(CLK2, HIGH);
  delayMicroseconds(hp);
  if (mask&0x01) digitalWrite(CLK1, LOW);
  if (mask&0x02) digitalWrite(CLK2, LOW);
  delayMicroseconds(hp);
}

void libererCapteur(int m, unsigned long hp) {
  int clk = (m==1)?CLK1:(m==2)?CLK2:CLK3;
  int cw  = (m==1)?CW1 :(m==2)?CW2 :CW3;
  int lim = (m==1)?LIMIT1:(m==2)?LIMIT2:LIMIT3;
  digitalWrite(cw, HIGH);
  for (int j=0; j<RELEASE_STEPS && digitalRead(lim)==LOW; j++) {
    digitalWrite(clk,HIGH); delayMicroseconds(hp);
    digitalWrite(clk,LOW);  delayMicroseconds(hp);
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
bool homingRectiligne(int limPin, int dirM1, int dirM2, long safetyLimit) {
  if (digitalRead(limPin) == LOW) {
    digitalWrite(CW1, !dirM1);
    digitalWrite(CW2, !dirM2);
    for(int i = 0; i < RELEASE_STEPS; i++) {
      digitalWrite(CLK1, HIGH); digitalWrite(CLK2, HIGH);
      delayMicroseconds(HOMING_HALF_PERIOD);
      digitalWrite(CLK1, LOW);  digitalWrite(CLK2, LOW);
      delayMicroseconds(HOMING_HALF_PERIOD);
    }
  }

  digitalWrite(CW1, dirM1);
  digitalWrite(CW2, dirM2);
  long s = 0;
  while (digitalRead(limPin) == HIGH && s < safetyLimit) {
    digitalWrite(CLK1, HIGH); digitalWrite(CLK2, HIGH);
    delayMicroseconds(HOMING_HALF_PERIOD);
    digitalWrite(CLK1, LOW);  digitalWrite(CLK2, LOW);
    delayMicroseconds(HOMING_HALF_PERIOD);
    s++;
  }
  
  return (s < safetyLimit);
}

void homing() {
  Serial.println(F("--- Homing XY ---"));
  
  if (!homingRectiligne(LIMIT1, LOW, LOW, MAX_STEPS * 2)) { 
    sendLimit(F("X")); 
    Serial.println(F("ERREUR: butee X inaccessible !")); 
    return; 
  }
  Serial.println(F("Axe X zero."));
  
  if (!homingRectiligne(LIMIT2, LOW, HIGH, MAX_STEPS * 2)) { 
    sendLimit(F("Y")); 
    Serial.println(F("ERREUR: butee Y inaccessible !")); 
    return; 
  }
  Serial.println(F("Axe Y zero."));
  
  stepsX = 0; 
  stepsY = 0;
  Serial.println(F("Origine XY ok."));
  sendOk();
}

void homingZ() {
  Serial.println(F("--- Homing Z ---"));
  long maxStepsZ = (long)round(MAX_TRAVEL_Z_MM/MM_PER_STEP);
  
  if (digitalRead(LIMIT3) == LOW) {
    digitalWrite(CW3, HIGH);
    for(int i = 0; i < RELEASE_STEPS; i++) {
      digitalWrite(CLK3, HIGH); delayMicroseconds(HOMING_HALF_PERIOD);
      digitalWrite(CLK3, LOW);  delayMicroseconds(HOMING_HALF_PERIOD);
    }
  }

  digitalWrite(CW3, LOW);
  long s = 0;
  while (digitalRead(LIMIT3) == HIGH && s < maxStepsZ * 2) {
    digitalWrite(CLK3, HIGH); delayMicroseconds(HOMING_HALF_PERIOD);
    digitalWrite(CLK3, LOW);  delayMicroseconds(HOMING_HALF_PERIOD);
    s++;
  }
  
  if (s >= maxStepsZ * 2) { 
    sendLimit(F("Z")); 
    Serial.println(F("ERREUR: capteur Z !")); 
    return; 
  }
  
  stepsZ=0;
  Serial.println(F("Origine Z ok."));
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

  long pasM1=realDX+realDY,  pasM2=realDX-realDY;
  bool dir1=(pasM1>=0),      dir2=(pasM2>=0);
  digitalWrite(CW1, dir1?HIGH:LOW);
  digitalWrite(CW2, dir2?HIGH:LOW);
  long absM1=abs(pasM1), absM2=abs(pasM2), total=max(absM1,absM2);

  Serial.print(F("XY ")); Serial.print(realDX*MM_PER_STEP,1);
  Serial.print(F(",")); Serial.print(realDY*MM_PER_STEP,1);
  Serial.print(F("mm @ ")); Serial.print(rpm); Serial.println(F(" RPM"));

  long dM1=0, dM2=0;
  long eM1=total/2, eM2=total/2;

  long rampSteps = (long)constrain((rpm - MIN_RPM) / ACCEL_RPM_PER_STEP, 1.0f, (float)(total / 2));
  unsigned long minDelay = (unsigned long)(30000000.0f / (rpm * STEPS_PER_REV));
  unsigned long maxDelay = (unsigned long)(30000000.0f / (MIN_RPM * STEPS_PER_REV));
  unsigned long delayRange = maxDelay - minDelay;

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

    unsigned long currentHP;
    if (i < rampSteps) {
      currentHP = maxDelay - ((delayRange * i) / rampSteps);
    } 
    else if (i >= total - rampSteps) {
      long decelStep = i - (total - rampSteps);
      currentHP = minDelay + ((delayRange * decelStep) / rampSteps);
    } 
    else {
      currentHP = minDelay;
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
  long clampZ    = constrain(stepsZ+mmToSteps(dz), 0L, maxStepsZ);
  long realDZ    = clampZ-stepsZ;
  if (realDZ==0) { Serial.println(F("Deja en limite Z.")); afficherPosition(); return; }
  if (clampZ != stepsZ+mmToSteps(dz)) { Serial.print(F("Limite Z: ")); Serial.print(clampZ*MM_PER_STEP,1); Serial.println(F("mm")); }

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
    unsigned long hp=rampedHP(i,absZ,rpm);
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
  stepsZ=mmToSteps(constrain(stepsZ*oldMPS, 0.0f, MAX_TRAVEL_Z_MM));
  Serial.println(F("OK. Homing recommande si STEPS ou MM_REV changes."));
  afficherPosition();
  sendOk();
}

// ═══════════════════════════════ SETUP / LOOP ════════════════════════
void setup() {
  Serial.begin(115200);
  recalculerDerives();
  for (int p : (int[]){CLK1,EN1,CW1,CLK2,EN2,CW2,CLK3,EN3,CW3}) pinMode(p,OUTPUT);
  for (int p : (int[]){LIMIT1,LIMIT2,LIMIT3}) pinMode(p,INPUT_PULLUP);
  digitalWrite(EN1,LOW); digitalWrite(EN2,LOW); digitalWrite(EN3,LOW);
  Serial.println(F("=== G14 - TRACEUR ==="));
  Serial.println(F("x<mm>v<rpm> | y<mm>v<rpm> | x<mm>y<mm>v<rpm> | z<mm>v<rpm>"));
  Serial.println(F("s=position  i=homingXY  k=homingZ  p=params  a=STOP"));
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
  if (cmd=='i') { homing();           return; }
  if (cmd=='k') { homingZ();          return; }
  if (cmd=='p') { editerParametres(); return; }
  if (cmd=='a') { Serial.println(F("!!! ARRET !!!")); afficherPosition(); return; }

  if (cmd=='z') {
    int v=inp.indexOf('v');
    if (v==-1){Serial.println(F("Ex: z30v60")); sendErr(); return;}
    float dz=inp.substring(1,v).toFloat(), rpm=inp.substring(v+1).toFloat();
    if(dz==0){Serial.println(F("Valeur invalide.")); sendErr(); return;}
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