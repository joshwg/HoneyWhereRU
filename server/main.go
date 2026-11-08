// Whereru location relay server.
//
// Deliberately minimal: a handful of people (up to ~6), each with a bearer
// token, and a SQLite table holding everyone's last known position. A
// person's phone POSTs its coordinates every 5 minutes; any phone can GET
// the latest known position of everyone else. A second table keeps each
// stored post for historyRetention, then prunes it.
//
// Configure users via the USERS env var (see .env.example), e.g.:
//
//	USERS=abc123:Josh,def456:Wife,111aaa:Mom
package main

import (
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"math"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// The version lives in ../VERSION (shared with the app) and is stamped in by
// build.sh via -ldflags. "dev" means the binary was built with plain go build.
// Reported by /health and logged at startup, alongside the git commit.
var version = "dev"

// buildCommit returns the short git commit the binary was built from, with
// "-dirty" appended if the working tree had uncommitted changes, or "" when
// that info isn't available (e.g. built outside a git checkout).
func buildCommit() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return ""
	}
	var rev, modified string
	for _, s := range info.Settings {
		switch s.Key {
		case "vcs.revision":
			rev = s.Value
		case "vcs.modified":
			modified = s.Value
		}
	}
	if len(rev) > 7 {
		rev = rev[:7]
	}
	if rev != "" && modified == "true" {
		rev += "-dirty"
	}
	return rev
}

// Tokens must be between these lengths; entries outside the range are skipped.
// The app enforces the same range in src/config.ts.
const (
	minTokenLen = 12
	maxTokenLen = 48
)

// Largest request body we'll read. A location POST is well under 200 bytes.
const maxBodyBytes = 4096

// A post that lands within this long of the same person's previous one is
// acknowledged but not stored. Phones are meant to post every 5 minutes; this
// is a backstop against an app build that posts far more often (older iOS
// builds did every few seconds). Kept well under 5 minutes so a deliberate
// "Send my location now" still gets through.
const minPostGap = 60 * time.Second

// How long rows in location_history are kept. Pruned on every stored post
// and by a background ticker (historyPruneEvery), so a trail still expires
// when nobody is posting. Measured against updated_at (server clock), not the
// phone's timestamp, so a phone with a wrong clock can't keep rows alive.
const (
	historyRetention  = 4 * time.Hour
	historyPruneEvery = 10 * time.Minute
)

// Speed is an EWMA of the per-segment speeds between each person's last
// speedPoints history rows (so up to speedPoints-1 segments), oldest to
// newest, with the usual N-period weight alpha = 2/(N+1). It's not the
// phone's instantaneous GPS speed, which iOS often omits in the background.
//
// Per segment:
//   - closer than speedMinGap apart in time: skipped (too short to measure),
//   - further than speedMaxGap apart: the run is broken there and everything
//     older is discarded, so a trip from before a long stop doesn't leak in,
//   - above speedMaxMph: skipped as a bad fix, not real movement,
//   - a move smaller than the two fixes' combined accuracy counts as 0 (GPS
//     jitter, not movement).
//
// If the newest usable segment is 0 (no movement beyond GPS jitter), the
// result is 0 rather than the EWMA: otherwise someone who just parked would
// show a decaying speed (~16 mph after 15 min stopped from 30 mph) for half
// an hour. The EWMA itself isn't reset, so a single stop at a red light
// doesn't throw away the smoothing once they move again.
//
// The result is null when the latest post is older than speedMaxAge (they may
// have stopped since) or no usable segment is left.
const (
	speedPoints     = 10
	speedAlpha      = 2.0 / (speedPoints + 1)
	speedMaxAge     = 15 * time.Minute
	speedMinGap     = 30 * time.Second
	speedMaxGap     = 20 * time.Minute
	speedMaxMph     = 700.0
	defaultAccuracy = 20.0 // metres, assumed when a fix has no accuracy
	metresPerMile   = 1609.344
	earthRadiusM    = 6371000.0
)

type location struct {
	Name      string   `json:"name"`
	Lat       float64  `json:"lat"`
	Lng       float64  `json:"lng"`
	Accuracy  *float64 `json:"accuracy"`
	Timestamp int64    `json:"timestamp"`
	UpdatedAt int64    `json:"updatedAt"`
	SpeedMph  *float64 `json:"speedMph"`
}

// haversineMetres is the great-circle distance between two points.
func haversineMetres(lat1, lng1, lat2, lng2 float64) float64 {
	toRad := math.Pi / 180
	dLat := (lat2 - lat1) * toRad
	dLng := (lng2 - lng1) * toRad
	a := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(lat1*toRad)*math.Cos(lat2*toRad)*math.Sin(dLng/2)*math.Sin(dLng/2)
	return 2 * earthRadiusM * math.Asin(math.Min(1, math.Sqrt(a)))
}

// segmentMph is the speed in mph from prev to cur. ok is false when the
// segment should be skipped; brk is true when the gap is long enough that
// everything before it should be dropped.
func segmentMph(prev, cur location) (mph float64, ok, brk bool) {
	// Fix times from the same phone, so any clock offset cancels out.
	dtMs := cur.Timestamp - prev.Timestamp
	if dtMs > speedMaxGap.Milliseconds() {
		return 0, false, true
	}
	if dtMs < speedMinGap.Milliseconds() {
		return 0, false, false
	}
	acc := func(a *float64) float64 {
		if a == nil {
			return defaultAccuracy
		}
		return *a
	}
	dist := haversineMetres(prev.Lat, prev.Lng, cur.Lat, cur.Lng)
	if dist > acc(prev.Accuracy)+acc(cur.Accuracy) {
		mph = dist / (float64(dtMs) / 1000) / metresPerMile * 3600
	}
	if mph > speedMaxMph {
		return 0, false, false
	}
	return mph, true, false
}

// ewmaSpeed returns the smoothed speed in mph over points (oldest first), or
// nil if it can't be trusted (see the rules above speedPoints). nowMs is the
// server clock, compared with updated_at (also server clock).
func ewmaSpeed(points []location, nowMs int64) *float64 {
	if len(points) < 2 || nowMs-points[len(points)-1].UpdatedAt > speedMaxAge.Milliseconds() {
		return nil
	}
	var ewma, newest float64
	have := false
	for i := 1; i < len(points); i++ {
		mph, ok, brk := segmentMph(points[i-1], points[i])
		if brk {
			have = false
			continue
		}
		if !ok {
			continue
		}
		newest = mph
		if !have {
			ewma, have = mph, true
		} else {
			ewma = speedAlpha*mph + (1-speedAlpha)*ewma
		}
	}
	if !have {
		return nil
	}
	if newest == 0 {
		ewma = 0
	}
	return &ewma
}

// recentSpeeds returns each person's smoothed speed (by name) from their last
// speedPoints history rows; people without a trustworthy speed are absent.
func (s *server) recentSpeeds(nowMs int64) (map[string]float64, error) {
	rows, err := s.db.Query(`
		SELECT name, lat, lng, accuracy, timestamp, updated_at FROM (
			SELECT *, ROW_NUMBER() OVER (PARTITION BY name ORDER BY updated_at DESC, id DESC) AS rn
			FROM location_history
		) WHERE rn <= ?
		ORDER BY name, rn DESC
	`, speedPoints)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	// rn DESC: each person's rows arrive oldest first.
	byName := map[string][]location{}
	for rows.Next() {
		var loc location
		if err := rows.Scan(&loc.Name, &loc.Lat, &loc.Lng, &loc.Accuracy, &loc.Timestamp, &loc.UpdatedAt); err != nil {
			return nil, err
		}
		byName[loc.Name] = append(byName[loc.Name], loc)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	speeds := map[string]float64{}
	for name, points := range byName {
		if mph := ewmaSpeed(points, nowMs); mph != nil {
			speeds[name] = *mph
		}
	}
	return speeds, nil
}

type locationPost struct {
	Lat      *float64 `json:"lat"`
	Lng      *float64 `json:"lng"`
	Accuracy *float64 `json:"accuracy"`
	// float64, not int64: iOS sends milliseconds with a fractional part
	// (e.g. 1793990414242.857), which Go refuses to decode into an integer.
	Timestamp *float64 `json:"timestamp"`
}

// validate returns a human-readable problem with the posted coordinates, or
// "" if they're usable. It also normalises accuracy: iOS reports a negative
// value when it doesn't trust the fix, which is "unknown", not an error.
func (p *locationPost) validate() string {
	switch {
	case p.Lat == nil || p.Lng == nil:
		return "lat and lng (numbers) are required"
	case math.IsNaN(*p.Lat) || math.IsInf(*p.Lat, 0) || *p.Lat < -90 || *p.Lat > 90:
		return "lat must be between -90 and 90"
	case math.IsNaN(*p.Lng) || math.IsInf(*p.Lng, 0) || *p.Lng < -180 || *p.Lng > 180:
		return "lng must be between -180 and 180"
	}
	if p.Accuracy != nil && (math.IsNaN(*p.Accuracy) || math.IsInf(*p.Accuracy, 0) || *p.Accuracy < 0) {
		p.Accuracy = nil
	}
	return ""
}

// loadDotEnv sets environment variables from a simple KEY=VALUE file,
// without overriding anything already set in the real environment. Missing
// file is not an error -- systemd deployments may set env vars directly via
// EnvironmentFile= and won't have a .env to load.
//
// Surrounding single or double quotes on a value are stripped, matching what
// systemd's EnvironmentFile= does, so the same file works under either loader.
func loadDotEnv(path string) {
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if n := len(value); n >= 2 {
			if (value[0] == '"' && value[n-1] == '"') || (value[0] == '\'' && value[n-1] == '\'') {
				value = value[1 : n-1]
			}
		}
		if _, alreadySet := os.LookupEnv(key); !alreadySet {
			os.Setenv(key, value)
		}
	}
}

type user struct {
	token []byte
	name  string
}

func parseUsers(raw string) []user {
	var users []user
	for _, entry := range strings.Split(raw, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		token, name, ok := strings.Cut(entry, ":")
		token, name = strings.TrimSpace(token), strings.TrimSpace(name)
		if !ok || token == "" || name == "" {
			continue
		}
		if len(token) < minTokenLen || len(token) > maxTokenLen {
			log.Printf("WARNING: skipping user %q: token must be %d-%d characters (got %d)", name, minTokenLen, maxTokenLen, len(token))
			continue
		}
		users = append(users, user{token: []byte(token), name: name})
	}
	return users
}

type server struct {
	db     *sql.DB
	users  []user // read-only after startup, so safe to share across requests
	commit string // from buildCommit(), computed once at startup
}

// authenticate compares the bearer token against every configured user in
// constant time, so response timing doesn't leak how much of a token matched.
func (s *server) authenticate(r *http.Request) (string, bool) {
	header := r.Header.Get("Authorization")
	token, ok := strings.CutPrefix(header, "Bearer ")
	if !ok {
		return "", false
	}
	presented := []byte(token)
	matched := ""
	for _, u := range s.users {
		if subtle.ConstantTimeCompare(presented, u.token) == 1 {
			matched = u.name
		}
	}
	return matched, matched != ""
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		log.Printf("failed to write response: %v", err)
	}
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func (s *server) withAuth(handler func(w http.ResponseWriter, r *http.Request, userName string)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userName, ok := s.authenticate(r)
		if !ok {
			// Logged so a mistyped token on a phone shows up in journalctl.
			log.Printf("rejected %s %s: invalid or missing token", r.Method, r.URL.Path)
			writeError(w, http.StatusUnauthorized, "invalid or missing token")
			return
		}
		handler(w, r, userName)
	}
}

func (s *server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "version": version, "commit": s.commit})
}

func (s *server) handlePostLocation(w http.ResponseWriter, r *http.Request, userName string) {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)

	var body locationPost
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			log.Printf("rejected location from %s: body too large", userName)
			writeError(w, http.StatusRequestEntityTooLarge, "request body too large")
			return
		}
		log.Printf("rejected location from %s: invalid JSON: %v", userName, err)
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if problem := body.validate(); problem != "" {
		log.Printf("rejected location from %s: %s", userName, problem)
		writeError(w, http.StatusBadRequest, problem)
		return
	}

	now := time.Now().UnixMilli()
	timestamp := now
	if body.Timestamp != nil && !math.IsNaN(*body.Timestamp) && !math.IsInf(*body.Timestamp, 0) && *body.Timestamp > 0 {
		timestamp = int64(*body.Timestamp)
	}

	// The WHERE on DO UPDATE makes the rate limit atomic: the row is only
	// touched if the previous write is old enough, and RowsAffected tells us
	// which way it went. No separate read, so two near-simultaneous posts
	// can't both slip through.
	tx, err := s.db.Begin()
	if err != nil {
		log.Printf("failed to begin location transaction: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to store location")
		return
	}
	defer tx.Rollback() // no-op once committed

	res, err := tx.Exec(`
		INSERT INTO locations (name, lat, lng, accuracy, timestamp, updated_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(name) DO UPDATE SET
			lat = excluded.lat,
			lng = excluded.lng,
			accuracy = excluded.accuracy,
			timestamp = excluded.timestamp,
			updated_at = excluded.updated_at
		WHERE excluded.updated_at - locations.updated_at >= ?
	`, userName, *body.Lat, *body.Lng, body.Accuracy, timestamp, now, minPostGap.Milliseconds())
	if err != nil {
		log.Printf("failed to upsert location: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to store location")
		return
	}
	if n, err := res.RowsAffected(); err == nil && n == 0 {
		// Too soon after this person's last post: acknowledged, not stored,
		// so an over-eager phone doesn't get an error and keep retrying.
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true, "throttled": true})
		return
	}

	// Only posts that passed the rate limit reach the history, so it gets
	// the same at-most-once-a-minute rhythm as the latest-position table.
	if _, err := tx.Exec(`
		INSERT INTO location_history (name, lat, lng, accuracy, timestamp, updated_at)
		VALUES (?, ?, ?, ?, ?, ?)
	`, userName, *body.Lat, *body.Lng, body.Accuracy, timestamp, now); err != nil {
		log.Printf("failed to insert location history: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to store location")
		return
	}
	if _, err := tx.Exec(`DELETE FROM location_history WHERE updated_at < ?`,
		now-historyRetention.Milliseconds()); err != nil {
		log.Printf("failed to prune location history: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to store location")
		return
	}
	if err := tx.Commit(); err != nil {
		log.Printf("failed to commit location: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to store location")
		return
	}

	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *server) handleGetLocations(w http.ResponseWriter, r *http.Request, userName string) {
	// Speed is a nice-to-have: if it fails, still return the positions. Run
	// before the main query: the pool has one connection, so a second query
	// while those rows are open would wait forever.
	speeds, err := s.recentSpeeds(time.Now().UnixMilli())
	if err != nil {
		log.Printf("failed to compute speeds: %v", err)
	}

	rows, err := s.db.Query(`SELECT name, lat, lng, accuracy, timestamp, updated_at FROM locations`)
	if err != nil {
		log.Printf("failed to query locations: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to load locations")
		return
	}
	defer rows.Close()

	var you *location
	others := []location{}
	for rows.Next() {
		var loc location
		if err := rows.Scan(&loc.Name, &loc.Lat, &loc.Lng, &loc.Accuracy, &loc.Timestamp, &loc.UpdatedAt); err != nil {
			log.Printf("failed to scan location row: %v", err)
			writeError(w, http.StatusInternalServerError, "failed to load locations")
			return
		}
		if mph, ok := speeds[loc.Name]; ok {
			loc.SpeedMph = &mph
		}
		if loc.Name == userName {
			you = &loc
		} else {
			others = append(others, loc)
		}
	}
	if err := rows.Err(); err != nil {
		log.Printf("failed to read location rows: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to load locations")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"you": you, "others": others})
}

func openDB(dbPath string) (*sql.DB, error) {
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		return nil, err
	}
	// busy_timeout makes a writer wait (rather than fail with SQLITE_BUSY)
	// if another connection holds the write lock.
	db, err := sql.Open("sqlite", "file:"+dbPath+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)")
	if err != nil {
		return nil, err
	}
	// SQLite allows one writer at a time anyway, and this server's load is a
	// handful of requests per minute: a single connection removes any chance
	// of two pooled connections contending for the write lock.
	db.SetMaxOpenConns(1)

	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS locations (
			name TEXT PRIMARY KEY,
			lat REAL NOT NULL,
			lng REAL NOT NULL,
			accuracy REAL,
			timestamp INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS location_history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL,
			lat REAL NOT NULL,
			lng REAL NOT NULL,
			accuracy REAL,
			timestamp INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS location_history_updated_at ON location_history (updated_at);
		CREATE INDEX IF NOT EXISTS location_history_name_updated_at ON location_history (name, updated_at);
	`)
	if err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

// pruneHistory deletes history rows older than historyRetention.
func pruneHistory(db *sql.DB) {
	cutoff := time.Now().Add(-historyRetention).UnixMilli()
	res, err := db.Exec(`DELETE FROM location_history WHERE updated_at < ?`, cutoff)
	if err != nil {
		log.Printf("failed to prune location history: %v", err)
		return
	}
	if n, err := res.RowsAffected(); err == nil && n > 0 {
		log.Printf("pruned %d location history rows", n)
	}
}

// pruneHistoryLoop runs pruneHistory at startup and then every
// historyPruneEvery, so history expires even when no posts arrive.
func pruneHistoryLoop(db *sql.DB) {
	pruneHistory(db)
	for range time.Tick(historyPruneEvery) {
		pruneHistory(db)
	}
}

func main() {
	loadDotEnv(".env")

	// Default to loopback: the reverse proxy (Apache) is the only thing that
	// should reach this port. Set BIND_ADDR=0.0.0.0 to expose it directly.
	bindAddr := os.Getenv("BIND_ADDR")
	if bindAddr == "" {
		bindAddr = "127.0.0.1"
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}

	dbPath := os.Getenv("DB_PATH")
	if dbPath == "" {
		dbPath = filepath.Join("data", "whereru.db")
	}

	users := parseUsers(os.Getenv("USERS"))
	if len(users) == 0 {
		log.Println(`WARNING: no USERS configured. Set a USERS env var like "token1:Josh,token2:Wife" or requests will all be rejected.`)
	}

	db, err := openDB(dbPath)
	if err != nil {
		log.Fatalf("failed to open database: %v", err)
	}
	defer db.Close()

	s := &server{db: db, users: users, commit: buildCommit()}
	go pruneHistoryLoop(db)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.handleHealth)
	mux.HandleFunc("POST /api/location", s.withAuth(s.handlePostLocation))
	mux.HandleFunc("GET /api/locations", s.withAuth(s.handleGetLocations))

	names := make([]string, 0, len(users))
	for _, u := range users {
		names = append(names, u.name)
	}

	addr := net.JoinHostPort(bindAddr, port)
	log.Printf("Whereru server %s (%s) listening on %s", version, s.commit, addr)
	log.Printf("Database: %s", dbPath)
	log.Printf("Configured users: %s", strings.Join(names, ", "))

	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("server error: %v", err)
	}
}
