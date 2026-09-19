# Bid Battle

A real-time silent-auction bidding game for a live town hall event. One host screen (projected)
runs the auction; team members bid from their phones. Built with Node.js, Express, and Socket.io —
no database, no build step. State lives in memory and resets if the server restarts, which is fine
for a one-time event.

## How it works

- **Team screen** (`/`): join with a team name, see the current item and leaderboard, place bids.
- **Host screen** (`/host`): password-protected. Start rounds, close bidding, reveal the actual
  price, advance to the next item, and show final results.
- The actual price of each item is never sent to team devices (not in the page, not over the
  socket) until the host clicks **Reveal Price** for that item.

## Run locally

1. Install dependencies:

   ```bash
   npm install
   ```

2. Set a host password (optional but recommended — otherwise it defaults to `changeme`):

   ```bash
   copy .env.example .env
   ```

   Then edit `.env` and set `HOST_PASSWORD` to whatever you want. Node doesn't load `.env`
   automatically, so either use a tool like `cross-env`/`dotenv`, or just set the variable
   directly when starting the server:

   **Windows (PowerShell):**
   ```powershell
   $env:HOST_PASSWORD="yourpassword"; npm start
   ```

   **Mac/Linux:**
   ```bash
   HOST_PASSWORD=yourpassword npm start
   ```

3. Open the host screen at `http://localhost:3000/host` and log in with your password.

## Letting phones on the same wifi join

Phones need your laptop's local IP address, not `localhost`.

**Find your local IP:**

- **Windows:** open PowerShell and run `ipconfig`, look for "IPv4 Address" under your active
  wifi adapter (usually something like `192.168.1.42`).
- **Mac:** System Settings → Wi-Fi → Details, or run `ipconfig getifaddr en0` in Terminal.

Make sure your laptop and all phones are on the **same wifi network**, then have teams go to:

```
http://<your-local-ip>:3000/
```

for example `http://192.168.1.42:3000/`. Keep the host screen open on your laptop (or a projector
connected to it) at `http://<your-local-ip>:3000/host` or `http://localhost:3000/host`.

If phones can't connect, check that your laptop's firewall allows inbound connections on port 3000.

## Deploy to Render / Railway / Fly.io

This is a single Express + Socket.io process on one port, so it deploys like any standard Node web
service — no separate socket server needed.

**Render:**
1. Push this folder to a GitHub repo.
2. Create a new "Web Service" on Render, point it at the repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Add an environment variable `HOST_PASSWORD` with your chosen password.
5. Deploy. Share the resulting URL with teams; use `<url>/host` for the host screen.

**Railway:**
1. Push to GitHub, create a new project from the repo in Railway.
2. Railway auto-detects Node and runs `npm install && npm start`.
3. Add the `HOST_PASSWORD` environment variable in the project settings.
4. Deploy and use the generated domain the same way as above.

**Fly.io:**
1. Run `fly launch` in this folder (accept the Node defaults).
2. Set the secret: `fly secrets set HOST_PASSWORD=yourpassword`.
3. `fly deploy`.

## Adding or changing items

Edit `data/items.json`. Each entry needs:

```json
{ "id": 4, "name": "New Item", "image": "/images/new-item.png", "actualPrice": 250 }
```

Drop the matching image file into `public/images/` (the `image` path should start with
`/images/...` to match). Restart the server to pick up changes — item data is read from disk once
at startup.

## Game flow recap

1. Host clicks **Start Round** — item and image broadcast to all team screens, bidding opens.
2. Teams bid; every bid must beat the current highest bid by at least 10 points. Bids update
   everyone's screen instantly.
3. Host clicks **Close Bidding** — no more bids accepted, highest bidder (earliest bid wins ties)
   is declared the winner. Actual price is still hidden.
4. Host clicks **Reveal Price** — the actual price is now shown to everyone, next to the winning
   bid.
5. Host clicks **Next Item** to repeat, or after the last item, the **Results** table (item,
   winning team, winning bid, actual price) appears on both host and team screens.

## Basic validation included

- Team names must be unique (case-sensitive) among currently registered teams.
- Bids are rejected if bidding isn't open, or if they don't beat the current highest bid by at
  least 10 points.
- Host actions (`Start Round`, `Close Bidding`, `Reveal Price`, `Next Item`) are rejected if
  called out of order (e.g. revealing before closing).
