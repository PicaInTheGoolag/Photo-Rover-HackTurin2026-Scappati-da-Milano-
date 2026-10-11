#include "Modulino.h"
#include <Servo.h>
#include <Adafruit_INA219.h>
#include <Wire.h>
#include <Arduino_RouterBridge.h>
#include "rgb_lcd.h"

// -------------------------------------------------------
// HARDWARE
// -------------------------------------------------------
Adafruit_INA219 ina219(0x40);
ModulinoMovement movement;
Servo panServo;
Servo tiltServo;

rgb_lcd lcd;

const int sensorPin = A0;

// -------------------------------------------------------
// CONFIGURAZIONE PANNELLO
// -------------------------------------------------------
const int PAN_MIN  = 0;
const int PAN_MAX  = 180;
const int TILT_MIN = 30;
const int TILT_MAX = 150;
const int STEP     = 30;

const int PAN_STEPS  = (PAN_MAX - PAN_MIN) / STEP + 1;
const int TILT_STEPS = (TILT_MAX - TILT_MIN) / STEP + 1;

// -------------------------------------------------------
// SOGLIE STABILITÀ
// -------------------------------------------------------
const float STABILITY_THRESHOLD = 0.3;
const float CARRIAGE_THRESHOLD  = 0.03;
const int STABILITY_SAMPLES = 5;
const int SAFETY_DELAY_MS = 1000;

// -------------------------------------------------------
// MAPPE PANNELLO
// -------------------------------------------------------
int lightMap[PAN_STEPS][TILT_STEPS];
int prevLightMap[PAN_STEPS][TILT_STEPS];
float voltageMap[PAN_STEPS][TILT_STEPS];
float currentMap[PAN_STEPS][TILT_STEPS];
float powerMap[PAN_STEPS][TILT_STEPS];
float prevPowerMap[PAN_STEPS][TILT_STEPS];
bool hasPreviousScan = false;

// --- Offset calibrazione accelerometro ---
float offsetX = 0.0;
float offsetY = 0.0;

void calibrateIMU(int samples = 20) {
  Serial.println("Calibrazione IMU — tieni il carrello fermo...");
  
  float sumX = 0, sumY = 0;
  for (int i = 0; i < samples; i++) {
    movement.update();
    sumX += movement.getX();
    sumY += movement.getY();
    delay(20);
  }
  offsetX = sumX / samples;
  offsetY = sumY / samples;
  Serial.print("Offset calibrato -> X: ");
  Serial.print(offsetX, 4);
  Serial.print("g  Y: ");
  Serial.println(offsetY, 4);
  Serial.print("g");
}

struct PanelReading {
  float voltage_V;
  float current_mA;
  float power_mW;
};

// -------------------------------------------------------
// MAPPA POSIZIONE CARRELLO
// -------------------------------------------------------
const int MAX_POINTS = 50;

struct MapPoint {
  float x, y;
  float roll, pitch;
  float bestPower_mW;
  int bestPan;
  int bestTilt;
};

MapPoint mapPoints[MAX_POINTS];
int mapPointCount = 0;

// --- Stato cinematico carrello ---
float posX = 0.0, posY = 0.0;
float velX = 0.0, velY = 0.0;
unsigned long lastDeadReckonTime = 0;

// -------------------------------------------------------
// AGGIUNTO LCD: ultimo risultato completato
// -------------------------------------------------------
float lcdResultX = 0.0;
float lcdResultY = 0.0;
float lcdResultPower_mW = 0.0;
bool lcdHasResult = false;

// Il display viene aggiornato SOLO al termine di una scansione completa.
void showScanResultLCD() {

  lcd.setCursor(0, 0);
  lcd.print("                ");

  lcd.setCursor(0, 1);
  lcd.print("                ");

  if (!lcdHasResult) {
    lcd.setCursor(0, 0);
    lcd.print("Attesa scansione");

    lcd.setCursor(0, 1);
    lcd.print("Pmax: --");
    return;
  }

  // Prima riga: coordinate del carrello
  lcd.setCursor(0, 0);
  lcd.print("X:");
  lcd.print(lcdResultX, 2);
  lcd.print(" Y:");
  lcd.print(lcdResultY, 2);

  // Seconda riga: potenza massima della scansione
  lcd.setCursor(0, 1);
  lcd.print("Pmax:");
  lcd.print(lcdResultPower_mW, 1);
  lcd.print("mW");
}

// -------------------------------------------------------
// Lettura INA219
// -------------------------------------------------------
PanelReading readPanel(int samples = 5) {
  float sumV = 0, sumI = 0;

  for (int i = 0; i < samples; i++) {
    sumV += ina219.getBusVoltage_V();
    sumI += ina219.getCurrent_mA();
    delay(10);
  }

  float avgV = sumV / samples;
  float avgI = sumI / samples;

  return { avgV, avgI, avgV * avgI };
}

// -------------------------------------------------------
// Lettura luce
// -------------------------------------------------------
int readLight(int samples = 5) {
  long sum = 0;

  for (int i = 0; i < samples; i++) {
    sum += analogRead(A0);
    delay(10);
  }

  return sum / samples;
}

// -------------------------------------------------------
// Stabilità per scansione pannello
// -------------------------------------------------------
bool isStable() {
  movement.update();

  float prevX = movement.getX();
  float prevY = movement.getY();
  float prevZ = movement.getZ();

  for (int i = 0; i < STABILITY_SAMPLES; i++) {
    delay(80);
    movement.update();

    float ax = movement.getX();
    float ay = movement.getY();
    float az = movement.getZ();

    float delta = abs(ax - prevX)
                + abs(ay - prevY)
                + abs(az - prevZ);

    if (delta > STABILITY_THRESHOLD) return false;

    prevX = ax;
    prevY = ay;
    prevZ = az;
  }

  return true;
}

void waitForStability() {
  while (!isStable()) {
    Serial.println("Movimento rilevato. Scansione in pausa...");
    delay(500);
  }

  Serial.println("Dispositivo fermo. Attesa di sicurezza...");

  unsigned long safetyStart = millis();

  while (millis() - safetyStart < SAFETY_DELAY_MS) {
    if (!isStable()) {
      Serial.println("Mosso durante l'attesa. Riavvio controllo stabilità.");
      waitForStability();
      return;
    }

    delay(200);
  }
}

// -------------------------------------------------------
// Dead reckoning: aggiorna posizione carrello
// -------------------------------------------------------
void updatePosition() {
  unsigned long now = millis();
  float dt = (now - lastDeadReckonTime) / 1000.0;

  if (dt < 0.02) return;

  lastDeadReckonTime = now;

  movement.update();

  float ax_g = movement.getX() - offsetX;
  float ay_g = movement.getY() - offsetY;

  // Azzera sotto soglia rumore
  if (abs(ax_g) < CARRIAGE_THRESHOLD) {
    ax_g = 0;
    velX = 0;
  }

  if (abs(ay_g) < CARRIAGE_THRESHOLD) {
    ay_g = 0;
    velY = 0;
  }

  float ax = ax_g * 9.81;
  float ay = ay_g * 9.81;

  velX += ax * dt;
  velY += ay * dt;

  velX *= 0.98;
  velY *= 0.98;

  posX += velX * dt;
  posY += velY * dt;
}

// -------------------------------------------------------
// Registra punto sulla mappa del carrello
// -------------------------------------------------------
void recordMapPoint(float bestPower, int bestPan, int bestTilt) {

  if (mapPointCount >= MAX_POINTS) {
    Serial.println("ATTENZIONE: mappa piena.");
    return;
  }

  movement.update();

  mapPoints[mapPointCount] = {
    posX, posY,
    movement.getRoll(),
    movement.getPitch(),
    bestPower,
    bestPan, bestTilt
  };

  mapPointCount++;

  Serial.print("PUNTO #");
  Serial.print(mapPointCount);

  Serial.print(" -> X: ");
  Serial.print(posX, 2);

  Serial.print("m  Y: ");
  Serial.print(posY, 2);

  Serial.print("m  Roll: ");
  Serial.print(movement.getRoll(), 1);

  Serial.print("°  Pitch: ");
  Serial.print(movement.getPitch(), 1);

  Serial.print("°  Potenza: ");
  Serial.print(bestPower, 1);

  Serial.println("mW");
}

// -------------------------------------------------------
// Stampa mappa carrello in CSV
// -------------------------------------------------------
void printMapCSV() {
  Serial.println("\n=== MAPPA CARRELLO CSV ===");
  Serial.println("punto,x_m,y_m,roll_deg,pitch_deg,potenza_mW,bestPan,bestTilt");

  for (int i = 0; i < mapPointCount; i++) {
    Serial.print(i + 1);
    Serial.print(",");

    Serial.print(mapPoints[i].x, 3);
    Serial.print(",");

    Serial.print(mapPoints[i].y, 3);
    Serial.print(",");

    Serial.print(mapPoints[i].roll, 1);
    Serial.print(",");

    Serial.print(mapPoints[i].pitch, 1);
    Serial.print(",");

    Serial.print(mapPoints[i].bestPower_mW, 2);
    Serial.print(",");

    Serial.print(mapPoints[i].bestPan);
    Serial.print(",");

    Serial.println(mapPoints[i].bestTilt);
  }

  Serial.println("=== FINE MAPPA ===\n");
}

// -------------------------------------------------------
// Salva mappe precedenti
// -------------------------------------------------------
void savePreviousMap() {
  for (int p = 0; p < PAN_STEPS; p++) {
    for (int t = 0; t < TILT_STEPS; t++) {
      prevLightMap[p][t] = lightMap[p][t];
      prevPowerMap[p][t] = powerMap[p][t];
    }
  }
}

// -------------------------------------------------------
// Stampa mappa luce
// -------------------------------------------------------
void printLightMap() {
  Serial.println("\n--- MAPPA LUCE ---");
  Serial.print("Pan\\Tilt");

  for (int t = TILT_MIN; t <= TILT_MAX; t += STEP) {
    Serial.print("\t");
    Serial.print(t);
  }

  Serial.println();

  for (int pan = PAN_MIN; pan <= PAN_MAX; pan += STEP) {
    Serial.print(pan);

    int pi = (pan - PAN_MIN) / STEP;

    for (int tilt = TILT_MIN; tilt <= TILT_MAX; tilt += STEP) {
      Serial.print("\t");
      Serial.print(lightMap[pi][(tilt - TILT_MIN) / STEP]);
    }

    Serial.println();
  }

  Serial.println();
}

// -------------------------------------------------------
// Stampa mappa potenza
// -------------------------------------------------------
void printPowerMap() {
  Serial.println("\n--- MAPPA POTENZA (mW) ---");
  Serial.print("Pan\\Tilt");

  for (int t = TILT_MIN; t <= TILT_MAX; t += STEP) {
    Serial.print("\t");
    Serial.print(t);
  }

  Serial.println();

  for (int pan = PAN_MIN; pan <= PAN_MAX; pan += STEP) {
    Serial.print(pan);

    int pi = (pan - PAN_MIN) / STEP;

    for (int tilt = TILT_MIN; tilt <= TILT_MAX; tilt += STEP) {
      Serial.print("\t");
      Serial.print(powerMap[pi][(tilt - TILT_MIN) / STEP], 1);
    }

    Serial.println();
  }

  Serial.println();
}

// -------------------------------------------------------
// Confronto variazioni di potenza
// -------------------------------------------------------
void printDiffMap() {
  if (!hasPreviousScan) {
    Serial.println("(Prima scansione, nessun confronto)");
    return;
  }

  Serial.println("\n--- VARIAZIONE POTENZA ---");
  Serial.print("Pan\\Tilt");

  for (int t = TILT_MIN; t <= TILT_MAX; t += STEP) {
    Serial.print("\t");
    Serial.print(t);
  }

  Serial.println();

  for (int pan = PAN_MIN; pan <= PAN_MAX; pan += STEP) {
    Serial.print(pan);

    int p = (pan - PAN_MIN) / STEP;

    for (int tilt = TILT_MIN; tilt <= TILT_MAX; tilt += STEP) {
      int t = (tilt - TILT_MIN) / STEP;

      float diff = powerMap[p][t] - prevPowerMap[p][t];

      Serial.print("\t");

      if (diff > 0) Serial.print("+");

      Serial.print(diff, 1);
    }

    Serial.println();
  }

  Serial.println();
}

// -------------------------------------------------------
// Movimento servomotori
// -------------------------------------------------------
void moveServo(Servo &servo, int angle, int settleMs = 350) {
  servo.write(angle);
  delay(settleMs);
}

// -------------------------------------------------------
// Scansione pannello
// -------------------------------------------------------
void Scan(int &bestPan, int &bestTilt, float &maxPower) {

  Serial.println("--- SCANSIONE ---");
  maxPower = 0;

  for (int pan = PAN_MIN; pan <= PAN_MAX; pan += STEP) {
    moveServo(panServo, pan);

    int pi = (pan - PAN_MIN) / STEP;

    for (int tilt = TILT_MIN; tilt <= TILT_MAX; tilt += STEP) {
      moveServo(tiltServo, tilt);

      int ti = (tilt - TILT_MIN) / STEP;

      int light = readLight();
      PanelReading panel = readPanel();

      lightMap[pi][ti] = light;
      voltageMap[pi][ti] = panel.voltage_V;
      currentMap[pi][ti] = panel.current_mA;
      powerMap[pi][ti] = panel.power_mW;

      Serial.print("Pan: ");
      Serial.print(pan);

      Serial.print(" | Tilt: ");
      Serial.print(tilt);

      Serial.print(" | Luce: ");
      Serial.print(light);

      Serial.print(" | V: ");
      Serial.print(panel.voltage_V, 2);

      Serial.print("V | I: ");
      Serial.print(panel.current_mA, 1);

      Serial.print("mA | P: ");
      Serial.print(panel.power_mW, 1);

      Serial.println("mW");

      if (panel.power_mW > maxPower) {
        maxPower = panel.power_mW;
        bestPan = pan;
        bestTilt = tilt;
      }
    }
  }

  printLightMap();
  printPowerMap();
}

// -------------------------------------------------------
// Invio dati con Arduino RouterBridge
// -------------------------------------------------------
void sendPositionAndPower() {
  String json = "{";
  json += "\"x\":" + String(posX, 3) + ",";
  json += "\"y\":" + String(posY, 3) + ",";
  json += "\"power\":[";

  for (int p = 0; p < PAN_STEPS; p++) {
    json += "[";

    for (int t = 0; t < TILT_STEPS; t++) {
      json += String(powerMap[p][t], 1);

      if (t < TILT_STEPS - 1) json += ",";
    }

    json += "]";

    if (p < PAN_STEPS - 1) json += ",";
  }

  json += "]}";

  Bridge.notify("solar_data", json);
  Serial.println("JSON inviato: " + json);
}

// -------------------------------------------------------
// SETUP
// -------------------------------------------------------
void setup() {
  Serial.begin(9600);
  delay(3000);
  Serial.println("START");

  Bridge.begin();
  Serial.println("BRIDGE OK");
    
  Wire.begin();
  Serial.println("WIRE OK");

  // AGGIUNTO LCD
  lcd.begin(16, 2);
  Serial.println("LCD OK");
  showScanResultLCD();

  if (!ina219.begin(&Wire)) {
    Serial.println("ERRORE: INA219 non trovato.");
    while (true) delay(1000);
  }

  Serial.println("INA219 OK");

  Modulino.begin();
  movement.begin();
  Serial.println("Movement OK");
  delay(1000);
  calibrateIMU(20);

  panServo.attach(9);
  tiltServo.attach(10);

  panServo.write(90);
  tiltServo.write(90);

  delay(2000);

  lastDeadReckonTime = millis();

  Serial.println("Sistema pronto.");
  Serial.println("Muovi il carrello. Ad ogni fermata viene fatta la scansione.");
}

// -------------------------------------------------------
// LOOP
// -------------------------------------------------------
void loop() {

  // Aggiorna la posizione stimata del carrello
  updatePosition();

  // Aspetta che il carrello si fermi
  if (!isStable()) return;

  Serial.println("Carrello fermo. Avvio scansione pannello...");
  waitForStability();

  // Reset velocità alla fermata
  velX = 0;
  velY = 0;

  savePreviousMap();

  int bestPan = 90;
  int bestTilt = 90;
  float maxPower = 0;

  // Esegue tutta la scansione senza aggiornare il display
  Scan(bestPan, bestTilt, maxPower);
  printDiffMap();

  hasPreviousScan = true;

  // Posiziona il pannello nella direzione migliore
  moveServo(panServo, bestPan);
  moveServo(tiltServo, bestTilt);

  Serial.println("\n--- RISULTATO ---");
  Serial.print("Pan: ");
  Serial.print(bestPan);
  Serial.print(" | Tilt: ");
  Serial.print(bestTilt);
  Serial.print(" | Potenza: ");
  Serial.print(maxPower, 1);
  Serial.println(" mW");

  // Registra il punto sulla mappa del carrello
  recordMapPoint(maxPower, bestPan, bestTilt);

  // Salva e visualizza il nuovo risultato migliore
  lcdResultX = posX;
  lcdResultY = posY;
  lcdResultPower_mW = maxPower;
  lcdHasResult = true;

  showScanResultLCD();

  // Funzioni originali mantenute
  printMapCSV();
  sendPositionAndPower();

  // Aspetta che il carrello si rimetta in moto
  Serial.println("Sposta il carrello per registrare il prossimo punto.");

  while (isStable()) {
    updatePosition();
    delay(50);
  }
  
  Serial.println("Movimento rilevato. Aggiornamento posizione...");
}