// Whereru phone simulator.
//
// Pretends to be one more person's phone: starts at a center point and
// wanders around inside a bounded box, POSTing its position to the server
// on the same interval a real phone would (default 5 minutes).
//
// Example:
//
//	go run ./simulator -server http://localhost:3000 -token tok2 -name Wife
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math/rand"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	server := flag.String("server", "http://localhost:3000", "Whereru server URL")
	token := flag.String("token", "", "bearer token to authenticate as (required)")
	centerLat := flag.Float64("center-lat", 40.0, "center latitude of the wander box")
	centerLng := flag.Float64("center-lng", -105.25, "center longitude of the wander box")
	boxSize := flag.Float64("box", 0.5, "size in degrees of the (square) box to wander within, centered on -center-lat/-center-lng")
	interval := flag.Duration("interval", 5*time.Minute, "how often to send a location update")
	step := flag.Float64("step", 0.03, "max degrees to move (per axis) between updates")
	flag.Parse()

	if *token == "" {
		fmt.Fprintln(os.Stderr, "error: -token is required")
		flag.Usage()
		os.Exit(1)
	}

	half := *boxSize / 2
	minLat, maxLat := *centerLat-half, *centerLat+half
	minLng, maxLng := *centerLng-half, *centerLng+half

	lat, lng := *centerLat, *centerLng
	rng := rand.New(rand.NewSource(time.Now().UnixNano()))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	client := &http.Client{Timeout: 10 * time.Second}

	log.Printf("simulating a phone wandering within %.4f degrees of (%.4f, %.4f), reporting to %s every %s",
		*boxSize, *centerLat, *centerLng, *server, *interval)

	for {
		lat = bounce(lat+(rng.Float64()*2-1)*(*step), minLat, maxLat)
		lng = bounce(lng+(rng.Float64()*2-1)*(*step), minLng, maxLng)
		accuracy := 5 + rng.Float64()*15

		if err := postLocation(ctx, client, *server, *token, lat, lng, accuracy); err != nil {
			log.Printf("failed to post location: %v", err)
		} else {
			log.Printf("sent location: %.5f, %.5f (accuracy %.1fm)", lat, lng, accuracy)
		}

		select {
		case <-ctx.Done():
			log.Println("stopping")
			return
		case <-time.After(*interval):
		}
	}
}

// bounce reflects a value back into [min, max] instead of clamping, so a
// random walk doesn't get stuck pinned against an edge.
func bounce(v, min, max float64) float64 {
	for v < min || v > max {
		if v < min {
			v = min + (min - v)
		}
		if v > max {
			v = max - (v - max)
		}
	}
	return v
}

func postLocation(ctx context.Context, client *http.Client, server, token string, lat, lng, accuracy float64) error {
	body, err := json.Marshal(map[string]any{
		"lat":       lat,
		"lng":       lng,
		"accuracy":  accuracy,
		"timestamp": time.Now().UnixMilli(),
	})
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, server+"/api/location", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("server returned %s", resp.Status)
	}
	return nil
}
