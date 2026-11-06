// Whereru location relay server.
//
// Deliberately minimal: a handful of people (up to ~6), each with a bearer
// token, and a SQLite table holding everyone's last known position. A
// person's phone POSTs its coordinates every 5 minutes; any phone can GET
// the latest known position of everyone else.
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

type location struct {
	Name      string   `json:"name"`
	Lat       float64  `json:"lat"`
	Lng       float64  `json:"lng"`
	Accuracy  *float64 `json:"accuracy"`
	Timestamp int64    `json:"timestamp"`
	UpdatedAt int64    `json:"updatedAt"`
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
	res, err := s.db.Exec(`
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

	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *server) handleGetLocations(w http.ResponseWriter, r *http.Request, userName string) {
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
		)
	`)
	if err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
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
