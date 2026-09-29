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
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type location struct {
	Name      string   `json:"name"`
	Lat       float64  `json:"lat"`
	Lng       float64  `json:"lng"`
	Accuracy  *float64 `json:"accuracy"`
	Timestamp int64    `json:"timestamp"`
	UpdatedAt int64    `json:"updatedAt"`
}

type locationPost struct {
	Lat       *float64 `json:"lat"`
	Lng       *float64 `json:"lng"`
	Accuracy  *float64 `json:"accuracy"`
	Timestamp *int64   `json:"timestamp"`
}

// loadDotEnv sets environment variables from a simple KEY=VALUE file,
// without overriding anything already set in the real environment. Missing
// file is not an error -- systemd deployments set env vars directly via
// EnvironmentFile= and won't have a .env to load.
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
		if _, alreadySet := os.LookupEnv(key); !alreadySet {
			os.Setenv(key, value)
		}
	}
}

func parseUsers(raw string) map[string]string {
	tokenToName := make(map[string]string)
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
		tokenToName[token] = name
	}
	return tokenToName
}

type server struct {
	db          *sql.DB
	tokenToName map[string]string
}

func (s *server) authenticate(r *http.Request) (string, bool) {
	header := r.Header.Get("Authorization")
	token, ok := strings.CutPrefix(header, "Bearer ")
	if !ok {
		return "", false
	}
	name, ok := s.tokenToName[token]
	return name, ok
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func (s *server) withAuth(handler func(w http.ResponseWriter, r *http.Request, userName string)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		userName, ok := s.authenticate(r)
		if !ok {
			writeError(w, http.StatusUnauthorized, "invalid or missing token")
			return
		}
		handler(w, r, userName)
	}
}

func (s *server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *server) handlePostLocation(w http.ResponseWriter, r *http.Request, userName string) {
	var body locationPost
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if body.Lat == nil || body.Lng == nil {
		writeError(w, http.StatusBadRequest, "lat and lng (numbers) are required")
		return
	}

	now := time.Now().UnixMilli()
	timestamp := now
	if body.Timestamp != nil {
		timestamp = *body.Timestamp
	}

	_, err := s.db.Exec(`
		INSERT INTO locations (name, lat, lng, accuracy, timestamp, updated_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(name) DO UPDATE SET
			lat = excluded.lat,
			lng = excluded.lng,
			accuracy = excluded.accuracy,
			timestamp = excluded.timestamp,
			updated_at = excluded.updated_at
	`, userName, *body.Lat, *body.Lng, body.Accuracy, timestamp, now)
	if err != nil {
		log.Printf("failed to upsert location: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to store location")
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
			continue
		}
		if loc.Name == userName {
			you = &loc
		} else {
			others = append(others, loc)
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{"you": you, "others": others})
}

func openDB(dbPath string) (*sql.DB, error) {
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, err
	}
	if _, err := db.Exec(`PRAGMA journal_mode = WAL`); err != nil {
		return nil, err
	}
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
		return nil, err
	}
	return db, nil
}

func main() {
	loadDotEnv(".env")

	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}

	dbPath := os.Getenv("DB_PATH")
	if dbPath == "" {
		dbPath = filepath.Join("data", "whereru.db")
	}

	tokenToName := parseUsers(os.Getenv("USERS"))
	if len(tokenToName) == 0 {
		log.Println(`WARNING: no USERS configured. Set a USERS env var like "token1:Josh,token2:Wife" or requests will all be rejected.`)
	}

	db, err := openDB(dbPath)
	if err != nil {
		log.Fatalf("failed to open database: %v", err)
	}
	defer db.Close()

	s := &server{db: db, tokenToName: tokenToName}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.handleHealth)
	mux.HandleFunc("POST /api/location", s.withAuth(s.handlePostLocation))
	mux.HandleFunc("GET /api/locations", s.withAuth(s.handleGetLocations))

	names := make([]string, 0, len(tokenToName))
	for _, name := range tokenToName {
		names = append(names, name)
	}

	addr := ":" + port
	log.Printf("Whereru server listening on %s", addr)
	log.Printf("Database: %s", dbPath)
	log.Printf("Configured users: %s", strings.Join(names, ", "))

	if err := http.ListenAndServe(addr, mux); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("server error: %v", err)
	}
}
