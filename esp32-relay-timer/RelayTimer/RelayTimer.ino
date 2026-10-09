/*
 * RelayTimer — 7-day, 2-channel Wi-Fi timer switch for ESP32-C3 relay modules.
 *
 * The board hosts its own web app. Open it from any phone browser:
 *   1. Join the Wi-Fi network "RelayTimer-XXXX" (password below), then
 *      browse to http://192.168.4.1 (most phones pop the page up on their own).
 *   2. Optionally enter your home Wi-Fi under Settings; the timer then also
 *      joins it, gets the time from the internet, and is reachable at
 *      http://relaytimer.local (or the IP shown in Settings).
 *
 * Board:   "ESP32C3 Dev Module" (Arduino core for ESP32 v3.x)
 * Library: ArduinoJson v7 (Library Manager)
 */

#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <time.h>
#include <sys/time.h>
#include "index_html.h"

// ---------------------------------------------------------------- config ---
// Check the silkscreen / listing of your module for the relay GPIOs.
static const uint8_t RELAY_PINS[2] = {0, 1};
static const bool RELAY_ACTIVE_HIGH = true;   // false if relays click on LOW
static const int STATUS_LED_PIN = -1;         // e.g. 8 for the on-board LED, -1 = none

static const char *AP_SSID_PREFIX = "RelayTimer-";
static const char *AP_DEFAULT_PASS = "relay1234";  // min. 8 characters
static const char *MDNS_NAME = "relaytimer";
static const char *DEFAULT_TZ = "EST5EDT,M3.2.0,M11.1.0";

// ----------------------------------------------------------------- model ---
static const uint8_t NUM_RELAYS = 2;
static const uint8_t MAX_SLOTS = 8;      // on/off periods per relay per day
static const uint8_t SCHED_VERSION = 1;

enum Mode : uint8_t { MODE_AUTO = 0, MODE_ON = 1, MODE_OFF = 2 };

struct Slot { uint16_t on, off; };        // minutes since midnight, 0..1439
struct Day { uint8_t count; Slot slot[MAX_SLOTS]; };
struct Schedule { Day day[NUM_RELAYS][7]; }; // day index: 0 = Sunday (tm_wday)

static Schedule sched;
static Mode modes[NUM_RELAYS] = {MODE_AUTO, MODE_AUTO};
static bool relayOn[NUM_RELAYS] = {false, false};
static String relayNames[NUM_RELAYS] = {"Relay 1", "Relay 2"};
static String tzString = DEFAULT_TZ;
static String staSsid, staPass, apPass = AP_DEFAULT_PASS, apSsid;

static WebServer server(80);
static DNSServer dns;
static Preferences prefs;

// ----------------------------------------------------------- persistence ---
static void loadAll() {
  prefs.begin("relaytimer", true);
  memset(&sched, 0, sizeof(sched));
  if (prefs.getUChar("sver", 0) == SCHED_VERSION &&
      prefs.getBytesLength("sched") == sizeof(sched)) {
    prefs.getBytes("sched", &sched, sizeof(sched));
  }
  for (uint8_t r = 0; r < NUM_RELAYS; r++) {
    char key[8];
    snprintf(key, sizeof(key), "mode%u", (unsigned)r);
    modes[r] = (Mode)prefs.getUChar(key, MODE_AUTO);
    if (modes[r] > MODE_OFF) modes[r] = MODE_AUTO;
    snprintf(key, sizeof(key), "name%u", (unsigned)r);
    relayNames[r] = prefs.getString(key, relayNames[r]);
  }
  tzString = prefs.getString("tz", DEFAULT_TZ);
  staSsid = prefs.getString("ssid", "");
  staPass = prefs.getString("pass", "");
  apPass = prefs.getString("appass", AP_DEFAULT_PASS);
  prefs.end();

  // Sanitise anything that came out of flash.
  for (uint8_t r = 0; r < NUM_RELAYS; r++)
    for (uint8_t d = 0; d < 7; d++) {
      Day &dy = sched.day[r][d];
      if (dy.count > MAX_SLOTS) dy.count = 0;
      for (uint8_t i = 0; i < dy.count; i++)
        if (dy.slot[i].on > 1439 || dy.slot[i].off > 1439) dy.count = 0;
    }
}

static void saveSchedule() {
  prefs.begin("relaytimer", false);
  prefs.putBytes("sched", &sched, sizeof(sched));
  prefs.putUChar("sver", SCHED_VERSION);
  prefs.end();
}

static void saveModes() {
  prefs.begin("relaytimer", false);
  for (uint8_t r = 0; r < NUM_RELAYS; r++) {
    char key[8];
    snprintf(key, sizeof(key), "mode%u", (unsigned)r);
    prefs.putUChar(key, modes[r]);
  }
  prefs.end();
}

// ------------------------------------------------------------------ time ---
static bool timeValid() { return time(nullptr) > 1700000000; }  // after Nov 2023

static void applyTimezone() {
  setenv("TZ", tzString.c_str(), 1);
  tzset();
}

// ---------------------------------------------------------------- relays ---
static void writeRelay(uint8_t r, bool on) {
  relayOn[r] = on;
  digitalWrite(RELAY_PINS[r], (on == RELAY_ACTIVE_HIGH) ? HIGH : LOW);
}

// Is relay r scheduled ON at minute m of weekday d?  A slot whose off time is
// earlier than its on time runs past midnight into the following day.
static bool scheduledOn(uint8_t r, uint8_t d, uint16_t m) {
  const Day &today = sched.day[r][d];
  for (uint8_t i = 0; i < today.count; i++) {
    const Slot &s = today.slot[i];
    if (s.on < s.off) { if (m >= s.on && m < s.off) return true; }
    else if (s.on > s.off) { if (m >= s.on) return true; }
  }
  const Day &yday = sched.day[r][(d + 6) % 7];
  for (uint8_t i = 0; i < yday.count; i++) {
    const Slot &s = yday.slot[i];
    if (s.on > s.off && m < s.off) return true;
  }
  return false;
}

static void updateRelays() {
  struct tm t = {};
  bool haveTime = timeValid();
  if (haveTime) {
    time_t now = time(nullptr);
    localtime_r(&now, &t);
  }
  for (uint8_t r = 0; r < NUM_RELAYS; r++) {
    bool want;
    switch (modes[r]) {
      case MODE_ON: want = true; break;
      case MODE_OFF: want = false; break;
      default:  // without a valid clock the schedule can't run: stay off
        want = haveTime && scheduledOn(r, t.tm_wday, t.tm_hour * 60 + t.tm_min);
    }
    if (want != relayOn[r]) writeRelay(r, want);
  }
}

// ------------------------------------------------------------------- web ---
static const char *modeName(Mode m) {
  return m == MODE_ON ? "on" : m == MODE_OFF ? "off" : "auto";
}

static void sendJson(JsonDocument &doc, int code = 200) {
  String out;
  serializeJson(doc, out);
  server.send(code, "application/json", out);
}

static void sendError(const char *msg, int code = 400) {
  JsonDocument doc;
  doc["error"] = msg;
  sendJson(doc, code);
}

static bool parseBody(JsonDocument &doc) {
  if (deserializeJson(doc, server.arg("plain"))) {
    sendError("invalid JSON");
    return false;
  }
  return true;
}

static void handleState() {
  JsonDocument doc;
  doc["timeValid"] = timeValid();
  time_t now = time(nullptr);
  doc["epoch"] = (uint32_t)now;
  if (timeValid()) {
    struct tm t;
    localtime_r(&now, &t);
    doc["wday"] = t.tm_wday;
    doc["minute"] = t.tm_hour * 60 + t.tm_min;
    doc["second"] = t.tm_sec;
    char buf[24];
    strftime(buf, sizeof(buf), "%Y-%m-%d", &t);
    doc["date"] = buf;
  }
  JsonArray relays = doc["relays"].to<JsonArray>();
  for (uint8_t r = 0; r < NUM_RELAYS; r++) {
    JsonObject o = relays.add<JsonObject>();
    o["name"] = relayNames[r];
    o["mode"] = modeName(modes[r]);
    o["on"] = relayOn[r];
  }
  doc["uptime"] = millis() / 1000;
  sendJson(doc);
}

static void handleGetSchedule() {
  JsonDocument doc;
  doc["maxSlots"] = MAX_SLOTS;
  JsonArray relays = doc["relays"].to<JsonArray>();
  for (uint8_t r = 0; r < NUM_RELAYS; r++) {
    JsonArray days = relays.add<JsonArray>();
    for (uint8_t d = 0; d < 7; d++) {
      JsonArray slots = days.add<JsonArray>();
      for (uint8_t i = 0; i < sched.day[r][d].count; i++) {
        JsonArray s = slots.add<JsonArray>();
        s.add(sched.day[r][d].slot[i].on);
        s.add(sched.day[r][d].slot[i].off);
      }
    }
  }
  sendJson(doc);
}

// Body: {"relays": [ [ [[on,off],...] x7 days ] x2 relays ]}  (minutes)
static void handlePostSchedule() {
  JsonDocument doc;
  if (!parseBody(doc)) return;
  JsonArray relays = doc["relays"];
  if (relays.size() != NUM_RELAYS) return sendError("expected 2 relays");
  Schedule next;
  memset(&next, 0, sizeof(next));
  for (uint8_t r = 0; r < NUM_RELAYS; r++) {
    JsonArray days = relays[r];
    if (days.size() != 7) return sendError("expected 7 days");
    for (uint8_t d = 0; d < 7; d++) {
      JsonArray slots = days[d];
      if (slots.size() > MAX_SLOTS) return sendError("too many periods in a day");
      for (JsonArray s : slots) {
        int on = s[0] | -1, off = s[1] | -1;
        if (on < 0 || on > 1439 || off < 0 || off > 1439)
          return sendError("time out of range");
        if (on == off) continue;
        Day &dy = next.day[r][d];
        dy.slot[dy.count++] = {(uint16_t)on, (uint16_t)off};
      }
    }
  }
  sched = next;
  saveSchedule();
  updateRelays();
  handleGetSchedule();
}

// Body: {"relay": 0, "mode": "auto"|"on"|"off"}
static void handleRelay() {
  JsonDocument doc;
  if (!parseBody(doc)) return;
  int r = doc["relay"] | -1;
  const char *m = doc["mode"] | "";
  if (r < 0 || r >= NUM_RELAYS) return sendError("bad relay");
  if (!strcmp(m, "on")) modes[r] = MODE_ON;
  else if (!strcmp(m, "off")) modes[r] = MODE_OFF;
  else if (!strcmp(m, "auto")) modes[r] = MODE_AUTO;
  else return sendError("bad mode");
  saveModes();
  updateRelays();
  handleState();
}

// Body: {"epoch": 1712345678} — lets the phone set the clock when the timer
// has no internet connection.
static void handleTime() {
  JsonDocument doc;
  if (!parseBody(doc)) return;
  uint32_t epoch = doc["epoch"] | 0;
  if (epoch < 1700000000) return sendError("bad time");
  struct timeval tv = {(time_t)epoch, 0};
  settimeofday(&tv, nullptr);
  updateRelays();
  handleState();
}

static void handleGetSettings() {
  JsonDocument doc;
  doc["tz"] = tzString;
  doc["ssid"] = staSsid;
  doc["hasPass"] = staPass.length() > 0;
  doc["apSsid"] = apSsid;
  doc["apIp"] = WiFi.softAPIP().toString();
  doc["staConnected"] = WiFi.status() == WL_CONNECTED;
  doc["staIp"] = WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString() : "";
  doc["rssi"] = WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0;
  doc["host"] = String(MDNS_NAME) + ".local";
  JsonArray names = doc["names"].to<JsonArray>();
  for (uint8_t r = 0; r < NUM_RELAYS; r++) names.add(relayNames[r]);
  sendJson(doc);
}

static void connectStation() {
  if (staSsid.length()) WiFi.begin(staSsid.c_str(), staPass.c_str());
  else WiFi.disconnect();
}

// Body (all optional): {"names":[..], "tz":"...", "ssid":"...", "pass":"...", "apPass":"..."}
static void handlePostSettings() {
  JsonDocument doc;
  if (!parseBody(doc)) return;
  bool reconnect = false, restartAp = false;
  prefs.begin("relaytimer", false);
  if (doc["names"].is<JsonArray>()) {
    for (uint8_t r = 0; r < NUM_RELAYS; r++) {
      String n = doc["names"][r] | relayNames[r];
      n.trim();
      if (n.length() == 0 || n.length() > 24) continue;
      relayNames[r] = n;
      char key[8];
      snprintf(key, sizeof(key), "name%u", (unsigned)r);
      prefs.putString(key, n);
    }
  }
  if (doc["tz"].is<const char *>()) {
    tzString = doc["tz"].as<String>();
    prefs.putString("tz", tzString);
    applyTimezone();
  }
  if (doc["ssid"].is<const char *>()) {
    staSsid = doc["ssid"].as<String>();
    prefs.putString("ssid", staSsid);
    if (doc["pass"].is<const char *>()) {
      staPass = doc["pass"].as<String>();
      prefs.putString("pass", staPass);
    }
    reconnect = true;
  }
  if (doc["apPass"].is<const char *>()) {
    String p = doc["apPass"].as<String>();
    if (p.length() < 8) { prefs.end(); return sendError("hotspot password needs 8+ characters"); }
    apPass = p;
    prefs.putString("appass", apPass);
    restartAp = true;
  }
  prefs.end();
  handleGetSettings();
  if (reconnect) connectStation();
  if (restartAp) { delay(300); WiFi.softAP(apSsid.c_str(), apPass.c_str()); }
  updateRelays();
}

static void handleScan() {
  int n = WiFi.scanNetworks();
  JsonDocument doc;
  JsonArray arr = doc["networks"].to<JsonArray>();
  for (int i = 0; i < n && i < 20; i++) {
    JsonObject o = arr.add<JsonObject>();
    o["ssid"] = WiFi.SSID(i);
    o["rssi"] = WiFi.RSSI(i);
    o["secure"] = WiFi.encryptionType(i) != WIFI_AUTH_OPEN;
  }
  WiFi.scanDelete();
  sendJson(doc);
}

static void handleIndex() {
  server.sendHeader("Cache-Control", "no-cache");
  server.send_P(200, "text/html", INDEX_HTML);
}

// Anything unknown (captive-portal probes from phones) gets the app.
static void handleNotFound() {
  bool viaHotspot = server.client().localIP() == WiFi.softAPIP();
  if (server.uri().startsWith("/api/") || !viaHotspot) return sendError("not found", 404);
  server.sendHeader("Location", String("http://") + WiFi.softAPIP().toString() + "/", true);
  server.send(302, "text/plain", "");
}

// ----------------------------------------------------------------- setup ---
void setup() {
  Serial.begin(115200);
  for (uint8_t r = 0; r < NUM_RELAYS; r++) {
    pinMode(RELAY_PINS[r], OUTPUT);
    writeRelay(r, false);
  }
  if (STATUS_LED_PIN >= 0) pinMode(STATUS_LED_PIN, OUTPUT);

  loadAll();
  applyTimezone();

  WiFi.mode(WIFI_AP_STA);  // start Wi-Fi first so the MAC reads correctly
  uint8_t mac[6];
  WiFi.macAddress(mac);
  char suffix[5];
  snprintf(suffix, sizeof(suffix), "%02X%02X", mac[4], mac[5]);
  apSsid = String(AP_SSID_PREFIX) + suffix;

  WiFi.setHostname(MDNS_NAME);
  WiFi.softAP(apSsid.c_str(), apPass.c_str());
  connectStation();
  configTzTime(tzString.c_str(), "pool.ntp.org", "time.google.com");

  dns.start(53, "*", WiFi.softAPIP());
  MDNS.begin(MDNS_NAME);
  MDNS.addService("http", "tcp", 80);

  server.on("/", HTTP_GET, handleIndex);
  server.on("/api/state", HTTP_GET, handleState);
  server.on("/api/schedule", HTTP_GET, handleGetSchedule);
  server.on("/api/schedule", HTTP_POST, handlePostSchedule);
  server.on("/api/relay", HTTP_POST, handleRelay);
  server.on("/api/time", HTTP_POST, handleTime);
  server.on("/api/settings", HTTP_GET, handleGetSettings);
  server.on("/api/settings", HTTP_POST, handlePostSettings);
  server.on("/api/scan", HTTP_GET, handleScan);
  server.onNotFound(handleNotFound);
  server.begin();

  Serial.printf("RelayTimer ready: join \"%s\" (pass \"%s\") and open http://%s\n",
                apSsid.c_str(), apPass.c_str(), WiFi.softAPIP().toString().c_str());
  updateRelays();
}

void loop() {
  dns.processNextRequest();
  server.handleClient();

  static uint32_t lastTick = 0;
  if (millis() - lastTick >= 1000) {
    lastTick = millis();
    updateRelays();
    if (STATUS_LED_PIN >= 0)  // blink while the clock is unset, solid when OK
      digitalWrite(STATUS_LED_PIN, timeValid() ? HIGH : (millis() / 1000) & 1);
  }
}
