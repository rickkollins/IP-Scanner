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
 * Board:   "ESP32C3 Dev Module" (Arduino core for ESP32 v3.x), with a
 *          partition scheme that has a SPIFFS/LittleFS area (the default does)
 * Library: ArduinoJson v7 (Library Manager)
 */

#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include <LittleFS.h>
#include <ArduinoJson.h>
#include <vector>
#include <algorithm>
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
static const uint16_t MAX_SLOTS = 50;    // on/off periods per relay per day

enum Mode : uint8_t { MODE_AUTO = 0, MODE_ON = 1, MODE_OFF = 2 };

struct Slot { uint16_t on, off; };        // minutes since midnight, 0..1439
// Periods are kept per relay and weekday (0 = Sunday, as tm_wday) and stored
// on flash as one small text file each: "on-off,on-off,..."
static std::vector<Slot> sched[NUM_RELAYS][7];

static Mode modes[NUM_RELAYS] = {MODE_AUTO, MODE_AUTO};
static bool relayOn[NUM_RELAYS] = {false, false};
static String relayNames[NUM_RELAYS] = {"Front Door", "Back Door"};
static String tzString = DEFAULT_TZ;
static String staSsid, staPass, apPass = AP_DEFAULT_PASS, apSsid;
static bool fsOk = false;

static WebServer server(80);
static DNSServer dns;
static Preferences prefs;

// ----------------------------------------------------------- persistence ---
static String dayPath(uint8_t r, uint8_t d) {
  return String("/sched/r") + r + "d" + d + ".txt";
}

// Parse "on-off,on-off,..." into a sorted list. Returns false on bad input.
static bool parseSlots(const String &text, std::vector<Slot> &out) {
  out.clear();
  const char *p = text.c_str();
  while (*p) {
    while (*p == ',' || *p == ' ' || *p == '\n' || *p == '\r') p++;
    if (!*p) break;
    char *end;
    long on = strtol(p, &end, 10);
    if (end == p || *end != '-') return false;
    p = end + 1;
    long off = strtol(p, &end, 10);
    if (end == p) return false;
    p = end;
    if (on < 0 || on > 1439 || off < 0 || off > 1439) return false;
    if (on == off) continue;                       // zero-length: ignore
    if (out.size() >= MAX_SLOTS) return false;
    out.push_back({(uint16_t)on, (uint16_t)off});
  }
  std::sort(out.begin(), out.end(), [](const Slot &a, const Slot &b) {
    return a.on != b.on ? a.on < b.on : a.off < b.off;
  });
  return true;
}

static String formatSlots(const std::vector<Slot> &v) {
  String s;
  s.reserve(v.size() * 10);
  for (size_t i = 0; i < v.size(); i++) {
    if (i) s += ',';
    s += v[i].on; s += '-'; s += v[i].off;
  }
  return s;
}

static bool saveDay(uint8_t r, uint8_t d) {
  if (!fsOk) return false;
  File f = LittleFS.open(dayPath(r, d), "w");
  if (!f) return false;
  String text = formatSlots(sched[r][d]);
  bool ok = f.print(text) == text.length();
  f.close();
  return ok;
}

static void loadAll() {
  fsOk = LittleFS.begin(true);   // formats the data partition on first boot
  if (fsOk) {
    LittleFS.mkdir("/sched");
    for (uint8_t r = 0; r < NUM_RELAYS; r++)
      for (uint8_t d = 0; d < 7; d++) {
        File f = LittleFS.open(dayPath(r, d), "r");
        if (!f) continue;
        if (!parseSlots(f.readString(), sched[r][d])) sched[r][d].clear();
        f.close();
      }
  } else {
    Serial.println("LittleFS failed: check the partition scheme; schedule won't persist");
  }

  prefs.begin("relaytimer", true);
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
  for (const Slot &s : sched[r][d]) {
    if (s.on < s.off) { if (m >= s.on && m < s.off) return true; }
    else if (m >= s.on) return true;
  }
  for (const Slot &s : sched[r][(d + 6) % 7])
    if (s.on > s.off && m < s.off) return true;
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

// {"maxSlots":50,"relays":[["on-off,on-off,...", x7 days], x2 relays]}
// Streamed one day at a time so the whole week never sits in one buffer.
static void handleGetSchedule() {
  server.setContentLength(CONTENT_LENGTH_UNKNOWN);
  server.send(200, "application/json", "");
  server.sendContent(String("{\"maxSlots\":") + MAX_SLOTS + ",\"relays\":[");
  for (uint8_t r = 0; r < NUM_RELAYS; r++) {
    server.sendContent(r ? ",[" : "[");
    for (uint8_t d = 0; d < 7; d++)
      server.sendContent(String(d ? ",\"" : "\"") + formatSlots(sched[r][d]) + "\"");
    server.sendContent("]");
  }
  server.sendContent("]}");
  server.sendContent("");  // end of chunked response
}

// POST /api/day?relay=0&day=1  body: "on-off,on-off,..." (minutes, 0 = Sunday)
// Replaces one day's periods for one relay.
static void handlePostDay() {
  int r = server.hasArg("relay") ? server.arg("relay").toInt() : -1;
  int d = server.hasArg("day") ? server.arg("day").toInt() : -1;
  if (r < 0 || r >= NUM_RELAYS || d < 0 || d > 6) return sendError("bad relay or day");
  std::vector<Slot> next;
  if (!parseSlots(server.arg("plain"), next))
    return sendError("bad periods (max 50 per day, times 0-1439)");
  sched[r][d].swap(next);
  if (!saveDay(r, d)) return sendError("could not save to flash", 500);
  updateRelays();
  JsonDocument doc;
  doc["relay"] = r;
  doc["day"] = d;
  doc["slots"] = formatSlots(sched[r][d]);
  sendJson(doc);
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
  server.on("/api/day", HTTP_POST, handlePostDay);
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
