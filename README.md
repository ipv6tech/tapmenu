# 🍺 Taproom — Self-Hosted Digital Draft List

A beautiful, self-hosted digital menu for your home taproom, bar, or kegerator setup. Features a full-screen display view, mobile-friendly menu, and an admin panel to manage everything.

---

## Features

- **📺 Display View** — Full-screen menu for a TV or monitor behind the bar
- **📱 Mobile Menu** — Tap-friendly menu guests can scan via QR
- **⚙️ Admin Panel** — Add, edit, delete taps with a clean drawer UI
- **🍺 All Beverage Types** — Beer, craft, IPA, stout, mead, cider, seltzer, wine, cocktails, spirits, kombucha, cold brew, and more
- **📊 Keg Level Tracking** — Visual keg gauges with color indicators
- **🔗 Untappd Links** — Link any tap directly to its Untappd page
- **📱 QR Codes** — Auto-generated per tap; scan to see full tasting notes
- **🔌 Brewing Software Fields** — Fields for Brewfather, Brewer's Friend, and Grainfather batch IDs (API integration coming)
- **🎨 Customizable** — Taproom name, tagline, accent color, toggle fields on/off
- **🔒 Auth** — Simple password-protected admin panel

---

## Quick Start (Docker)

### 1. Clone / download this project

```bash
git clone <your-repo> taproom
cd taproom
```

### 2. Edit the session secret

Open `docker-compose.yml` and change:
```yaml
SESSION_SECRET=change-me-to-a-long-random-string
```
to something random and secure.

### 3. Start it up

```bash
docker compose up -d
```

### 4. Open the app

- **Display / Menu:** http://localhost:3000
- **Admin panel:** http://localhost:3000/admin

On first visit to `/admin`, you'll be prompted to create your admin account.

---

## Ports & Networking

By default the app runs on port **3000**. To change it, edit `docker-compose.yml`:

```yaml
ports:
  - "8080:3000"   # access on port 8080 instead
```

### Behind a Reverse Proxy (Traefik / Nginx / Caddy)

The app runs on HTTP. Put your TLS termination at the reverse proxy level. Example Traefik label:

```yaml
labels:
  - "traefik.http.routers.taproom.rule=Host(`taps.yourdomain.com`)"
  - "traefik.http.services.taproom.loadbalancer.server.port=3000"
```

---

## Data Persistence

All data is stored in a SQLite database at `/data/taproom.db` inside the container, mapped to a Docker named volume (`taproom-data`). Your data persists across container restarts and updates.

To back up:
```bash
docker cp taproom:/data/taproom.db ./taproom-backup.db
```

To restore:
```bash
docker cp ./taproom-backup.db taproom:/data/taproom.db
docker restart taproom
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `SESSION_SECRET` | `taproom-secret-...` | **Change this!** Cookie signing secret |
| `DB_PATH` | `/data/taproom.db` | SQLite database path |

---

## Updating

```bash
docker compose pull   # if using a registry
docker compose build  # if building locally
docker compose up -d  # restarts with new image, data preserved
```

---

## URL Structure

| Path | Description |
|---|---|
| `/` | Full-screen display view |
| `/menu` | Mobile-optimized menu |
| `/admin` | Admin panel |
| `/tap/:id` | Individual tap detail (linked from QR codes) |

---

## Brewing Software Integration (Roadmap)

The fields for Brewfather, Brewer's Friend, and Grainfather batch/recipe IDs are already in the database and admin form. Full API integration (auto-fetch recipe name, ABV, IBU, description from your brewing software) is planned for a future version. PRs welcome!

---

## Development

```bash
npm install
npm run dev   # uses nodemon for hot reload
```

App runs at http://localhost:3000

---

## Tech Stack

- **Backend:** Node.js + Express
- **Database:** SQLite (via better-sqlite3)
- **Frontend:** Vanilla JS SPA (no build step)
- **Fonts:** Bebas Neue + DM Sans
- **QR:** qrcode npm package
- **Auth:** express-session + bcryptjs
