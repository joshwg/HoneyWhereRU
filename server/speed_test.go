package main

import (
	"math"
	"math/rand"
	"testing"
	"time"
)

// Fake phones for the speed tests. A leg is a stretch at one speed; the
// phone gets a fix every fixEvery and posts according to the same rules the
// app uses (src/locationTask.ts shouldSendFix and src/config.ts):
//   - normal: one post per 5-minute window;
//   - quick: at least 5 s apart, as soon as it has moved 10 m since the
//     last post, and anyway once 17 s have passed.
//
// Each fix gets random noise of up to jitter metres in both axes, so
// "standing still" looks like a real phone (wandering around within its
// accuracy) rather than identical coordinates.

type leg struct {
	mph float64
	dur time.Duration
}

type phone struct {
	quick    bool
	accuracy float64 // metres, reported with every fix
	jitter   float64 // metres of noise per axis
	fixEvery time.Duration
	seed     int64 // noise pattern
}

const (
	testStartLat = 40.0
	testStartLng = -105.25
	testStartMs  = int64(1_800_000_000_000)
)

// metresToDeg converts metres north/east at testStartLat to degrees.
func metresToDeg(north, east float64) (dLat, dLng float64) {
	dLat = north / earthRadiusM * 180 / math.Pi
	dLng = east / (earthRadiusM * math.Cos(testStartLat*math.Pi/180)) * 180 / math.Pi
	return
}

// drive runs the phone over legs (heading east) and returns the posts the
// server would have stored, oldest first, plus the time the trip ended.
func (p phone) drive(legs []leg) ([]location, int64) {
	rng := rand.New(rand.NewSource(p.seed))
	var posts []location
	var east float64 // true position, metres east of the start
	t := testStartMs
	step := p.fixEvery.Milliseconds()
	acc := p.accuracy

	for _, l := range legs {
		end := t + l.dur.Milliseconds()
		for ; t < end; t += step {
			east += l.mph * metresPerMile / 3600 * float64(step) / 1000
			nLat, nLng := metresToDeg((rng.Float64()*2-1)*p.jitter, east+(rng.Float64()*2-1)*p.jitter)
			fix := location{
				Name:      "test",
				Lat:       testStartLat + nLat,
				Lng:       testStartLng + nLng,
				Accuracy:  &acc,
				Timestamp: t,
				UpdatedAt: t + 300, // network delay
				Quick:     p.quick,
			}
			if p.shouldPost(posts, fix) {
				posts = append(posts, fix)
			}
		}
	}
	return posts, t
}

func (p phone) shouldPost(posts []location, fix location) bool {
	if len(posts) == 0 {
		return true
	}
	last := posts[len(posts)-1]
	gap := fix.Timestamp - last.Timestamp
	if !p.quick {
		return gap >= (5*time.Minute - 2*time.Second).Milliseconds()
	}
	if gap < (5 * time.Second).Milliseconds() {
		return false
	}
	if gap >= (17 * time.Second).Milliseconds() {
		return true
	}
	return haversineMetres(last.Lat, last.Lng, fix.Lat, fix.Lng) >= 10
}

// Typical phones: normal mode uses the cheaper wifi/cell fix (iOS Balanced
// reports ~65 m), quick mode uses GPS (~5-10 m).
var (
	normalPhone = phone{quick: false, accuracy: 65, jitter: 25, fixEvery: time.Second}
	quickPhone  = phone{quick: true, accuracy: 10, jitter: 3, fixEvery: time.Second}
)

func TestSpeed(t *testing.T) {
	tests := []struct {
		name   string
		phone  phone
		legs   []leg
		want   float64 // mph
		within float64 // allowed error, mph
	}{
		// Normal updates (a post every 5 minutes).
		{"normal/driving 30", normalPhone, []leg{{30, time.Hour}}, 30, 3},
		{"normal/highway 65", normalPhone, []leg{{65, time.Hour}}, 65, 5},
		{"normal/walking 3", normalPhone, []leg{{3, time.Hour}}, 3, 1},
		{"normal/stationary", normalPhone, []leg{{0, time.Hour}}, 0, 0.5},
		{"normal/drove then parked", normalPhone, []leg{{30, 40 * time.Minute}, {0, 11 * time.Minute}}, 0, 0.5},
		{"normal/drove then walking", normalPhone, []leg{{30, 40 * time.Minute}, {3, 11 * time.Minute}}, 3, 1.5},
		{"normal/walked then driving", normalPhone, []leg{{3, 40 * time.Minute}, {30, 11 * time.Minute}}, 30, 5},
		{"normal/highway then town", normalPhone, []leg{{65, 40 * time.Minute}, {25, 11 * time.Minute}}, 25, 5},

		// Quick updates (a post every 5-17 seconds).
		{"quick/driving 30", quickPhone, []leg{{30, 10 * time.Minute}}, 30, 3},
		{"quick/highway 65", quickPhone, []leg{{65, 10 * time.Minute}}, 65, 5},
		{"quick/walking 3", quickPhone, []leg{{3, 10 * time.Minute}}, 3, 1},
		{"quick/slow walk 2", quickPhone, []leg{{2, 10 * time.Minute}}, 2, 1},
		{"quick/stationary", quickPhone, []leg{{0, 10 * time.Minute}}, 0, 0.5},
		{"quick/red light", quickPhone, []leg{{30, 5 * time.Minute}, {0, 40 * time.Second}}, 0, 0.5},
		{"quick/away from light", quickPhone, []leg{{30, 5 * time.Minute}, {0, 40 * time.Second}, {30, time.Minute}}, 30, 4},
		{"quick/drove then walking", quickPhone, []leg{{30, 5 * time.Minute}, {3, time.Minute}}, 3, 1.5},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			// Several noise patterns, so a pass isn't down to one lucky draw.
			for seed := int64(1); seed <= 20; seed++ {
				ph := tc.phone
				ph.seed = seed
				posts, end := ph.drive(tc.legs)
				got := ewmaSpeed(posts, end)
				if got == nil {
					t.Fatalf("seed %d: speed = nil, want %.1f mph (%d posts)", seed, tc.want, len(posts))
				}
				if math.Abs(*got-tc.want) > tc.within {
					t.Errorf("seed %d: speed = %.1f mph, want %.1f ± %.1f (%d posts)", seed, *got, tc.want, tc.within, len(posts))
				}
			}
		})
	}
}

// A heartbeat that couldn't get a fresh fix resends an older one with its
// own timestamp. That must neither break the speed nor read as movement.
func TestSpeedStaleHeartbeat(t *testing.T) {
	posts, end := normalPhone.drive([]leg{{30, 30 * time.Minute}})
	stale := posts[len(posts)-1]
	stale.UpdatedAt += (5 * time.Minute).Milliseconds()
	posts = append(posts, stale)
	got := ewmaSpeed(posts, end+(5*time.Minute).Milliseconds())
	if got == nil || math.Abs(*got-30) > 3 {
		t.Fatalf("speed = %v, want ~30 mph", got)
	}
}

func TestSpeedTooOld(t *testing.T) {
	posts, end := normalPhone.drive([]leg{{30, 30 * time.Minute}})
	if got := ewmaSpeed(posts, end+(16*time.Minute).Milliseconds()); got != nil {
		t.Fatalf("speed = %.1f, want nil once the latest post is over 15 minutes old", *got)
	}
}
