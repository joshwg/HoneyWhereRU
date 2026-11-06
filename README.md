# Whereru

A small group location sharer (built for family use, up to ~6 people): an
Expo app that reports each phone's location roughly every 5 minutes to a
self-hosted server, and shows everyone else's last known spot.

- `app/` — the Expo (React Native/TypeScript) app, installed on each
  person's phone (Android and iOS both supported).
- `server/` — a small Go server backed by SQLite. Compiles to a single
  static binary — no runtime, no npm install, no Docker needed on the
  server.

Because true background location tracking is not supported in Expo Go, this
needs a standalone build via [EAS Build](https://docs.expo.dev/build/introduction/),
which is why an Apple Developer account is required for the iPhone side.

## How it works

1. Each phone runs the app configured with your server's URL and a secret
   token.
2. Every ~5 minutes, the OS wakes the app in the background, it grabs a GPS
   fix, and POSTs it to `/api/location`.
3. Any phone can GET `/api/locations` to see everyone else's last reported
   position and when it was last updated.
4. Tapping a person's card opens their location in Google Maps.

## 1. Deploy the server (EC2 Ubuntu, no Docker)

The server needs to be reachable over **HTTPS** from the public internet
(phones will be on cellular data, not your home wifi) — iOS also blocks
plain-HTTP background network requests by default.

### Generate tokens

Pick a random secret per person (up to ~6 people). Tokens must be 12–48
characters; this makes a 12-character one with no look-alike characters:

```bash
tr -dc 'abcdefghjkmnpqrstuvwxyz23456789' </dev/urandom | head -c 12; echo   # run once per person
```

### Build the binary

The SQLite driver used (`modernc.org/sqlite`) is pure Go — no CGO, no
system SQLite library needed. Easiest path: build it wherever you have Go
installed and copy the binary over; you don't need Go installed on the EC2
instance at all.

```bash
cd server
GOOS=linux GOARCH=amd64 go build -o whereru-server .   # amd64 EC2 instance
# GOOS=linux GOARCH=arm64 go build -o whereru-server . # Graviton (arm64) instance — check `uname -m` on the instance
```

### Set up the instance

```bash
# On your machine: copy the binary and config over
scp whereru-server .env.example ubuntu@<your-ec2-host>:/tmp/

# On the EC2 instance:
sudo useradd --system --home /opt/whereru --create-home whereru
sudo mkdir -p /opt/whereru/data
sudo mv /tmp/whereru-server /opt/whereru/
sudo mv /tmp/.env.example /opt/whereru/.env
sudo chmod +x /opt/whereru/whereru-server
sudo chown -R whereru:whereru /opt/whereru

# Edit /opt/whereru/.env: set USERS=<token1>:Josh,<token2>:Wife,<token3>:Mom,...
sudo nano /opt/whereru/.env

# The file holds everyone's tokens -- make sure only the service user can read it
sudo chmod 600 /opt/whereru/.env
```

### Run it as a systemd service

```bash
scp server/whereru.service ubuntu@<your-ec2-host>:/tmp/
ssh ubuntu@<your-ec2-host>
sudo mv /tmp/whereru.service /etc/systemd/system/whereru.service
sudo systemctl daemon-reload
sudo systemctl enable --now whereru
sudo systemctl status whereru   # should show "active (running)"
```

The service reads its config from `/opt/whereru/.env` (both the binary and
the systemd unit point at that file) and listens on `127.0.0.1:3000` only —
a reverse proxy handles the public HTTPS side. Set `BIND_ADDR=0.0.0.0` in
`.env` if you ever need it reachable directly.

### Put Apache2 in front for HTTPS

Since you're already running Apache2 on this instance, Whereru just needs
one more vhost proxying to the Go server's local port, plus Certbot for
the TLS certificate.

Point a domain (or subdomain) at your EC2 instance's public IP first —
Certbot needs it resolvable to issue a certificate.

```bash
# On your machine: copy the vhost template over
scp server/whereru-apache.conf ubuntu@<your-ec2-host>:/tmp/

# On the EC2 instance:
sudo a2enmod proxy proxy_http
sudo mv /tmp/whereru-apache.conf /etc/apache2/sites-available/whereru.conf
sudo nano /etc/apache2/sites-available/whereru.conf   # set your real ServerName
sudo a2ensite whereru
sudo systemctl reload apache2
```

Then get a certificate with Certbot (installs itself as a plugin that
edits the vhost in place to add HTTPS and an http→https redirect):

```bash
sudo apt install -y certbot python3-certbot-apache
sudo certbot --apache -d whereru.yourdomain.com
```

Follow the prompts (email address, agree to terms, choose "redirect" when
asked about HTTP). Certbot also sets up automatic renewal via a systemd
timer or cron job — nothing further to do.

Make sure your EC2 security group allows inbound TCP on ports 80 and 443
(and 22 for SSH, which you presumably already have). Since Whereru is one
vhost among possibly several on this Apache instance, this doesn't affect
any other sites it's already serving.

### Verify it's up

```bash
curl https://whereru.yourdomain.com/health
# {"ok":true}
```

### Redeploying after a code change

```bash
GOOS=linux GOARCH=amd64 go build -o whereru-server .
scp whereru-server ubuntu@<your-ec2-host>:/tmp/
ssh ubuntu@<your-ec2-host> '
  sudo systemctl stop whereru
  sudo mv /tmp/whereru-server /opt/whereru/whereru-server
  sudo chown whereru:whereru /opt/whereru/whereru-server
  sudo systemctl start whereru
'
```

## 2. Build the app with EAS

```bash
cd app
npx eas login
npx eas build:configure   # links this project to your Expo/EAS account
```

### Android

```bash
npx eas build --platform android --profile preview
```

This produces a downloadable APK link when it finishes. Open the link on
the Android phone and install it directly (you may need to allow "install
unknown apps" for the browser once).

### iOS

Ad-hoc distribution requires each iPhone to be registered to your Apple
Developer account first:

```bash
npx eas device:create
```

This gives you a link — have that person open it **on their iPhone** to
register the device, then build:

```bash
npx eas build --platform ios --profile preview
```

When it finishes, EAS gives you an install link/QR code. Open it on the
iPhone to install. The first time it's opened, go to **Settings → General →
VPN & Device Management** and trust your developer certificate.

## 3. First-run setup, on each phone

1. Open the app.
2. Enter the server URL (e.g. `https://whereru.yourdomain.com`; it must be
   `https://`) and that phone's token.
3. Toggle **Share my location** on. Grant location permission, then when
   prompted for background access, choose **Always Allow** (or go to
   Settings afterward if the OS didn't ask directly — see below).
4. Optionally tap **Send my location now** to confirm it's working
   end-to-end before waiting for the first automatic update.

### Changing the server URL or token later

Tap **Change server URL or token** at the bottom of the main screen. The
fields come pre-filled; edit, then **Save** (the app checks the new values
against the server first). Sharing keeps running — the background task
picks up the new settings on its next update. The same screen has a
**Forget this phone** option that stops sharing and clears everything.

### How the map frames people

With exactly one other person (a two-person group) the map keeps that
person centred and re-centres whenever their position changes; your zoom
level is left alone. With more people it frames everyone once, then stays
wherever you pan; the ⌖ button re-frames everyone on demand.

### Getting "Always" location permission

- **iOS**: The system dialog usually offers "Allow Once" / "Allow While
  Using App" first, and only asks about "Always" after the app has
  requested background permission. If it doesn't prompt for "Always"
  directly, go to **Settings → Privacy & Security → Location Services →
  Whereru** and set it to **Always**.
- **Android**: Android will show a persistent notification while sharing
  is on — this is required by the OS for background location (a
  "foreground service") and can't be hidden. Some manufacturers
  (Samsung, Xiaomi, Huawei, OnePlus, etc.) aggressively kill background
  apps to save battery; if updates stop arriving, look for a
  battery-optimization exemption setting for the app (often under
  **Settings → Battery → App battery usage**).

## Caveats

- **iOS update cadence is best-effort, not exact.** Android honors the
  5-minute timer precisely. iOS ignores the timer and hands the app a
  location whenever it has one -- every few seconds when moving. The app
  enforces the 5-minute spacing itself: it will not post twice within 5
  minutes, whatever the OS delivers (a manual "Send my location now" also
  starts a new 5-minute window). So the server sees the same cadence from
  both platforms. If an iPhone sits still for a long time iOS may deliver fewer
  updates; that doesn't cost you anything in practice, because the last
  reported location is still accurate.
- **Tokens are the only security.** Anyone with a token can see (and spoof)
  that person's location. Keep them secret; don't commit `.env` or paste
  tokens anywhere public.
- **This is not encrypted end-to-end** beyond standard HTTPS transport —
  the server operator can see everyone's location in the SQLite file.
  That's expected for a self-hosted tool for a small trusted group, just
  worth naming.
- **Not built for large groups.** Comma-separated `USERS` and an
  every-client-sees-everyone response are fine for a handful of people;
  this wasn't designed to scale past that.
