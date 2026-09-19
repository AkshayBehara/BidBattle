const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const HOST_PASSWORD = process.env.HOST_PASSWORD || 'changeme';
const PORT = process.env.PORT || 3000;
const MIN_INCREMENT = 10;

const items = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'items.json'), 'utf8'));

// ---- In-memory game state ----
// status per item: 'not_started' | 'open' | 'closed' | 'revealed'
const game = {
  currentIndex: -1, // -1 = not started
  itemStatus: items.map(() => 'not_started'),
  bids: items.map(() => ({})), // itemId index -> { teamName: { amount, time } }
  winners: items.map(() => null), // { teamName, amount } once closed
  teams: new Set(),
  teamSockets: new Map(), // teamName -> socket.id of the currently connected owner
};

function currentItem() {
  if (game.currentIndex < 0 || game.currentIndex >= items.length) return null;
  return items[game.currentIndex];
}

function getHighestBid(index) {
  const bids = game.bids[index] || {};
  let best = null;
  for (const [teamName, bid] of Object.entries(bids)) {
    if (!best || bid.amount > best.amount || (bid.amount === best.amount && bid.time < best.time)) {
      best = { teamName, amount: bid.amount, time: bid.time };
    }
  }
  return best;
}

// State sent to TEAM clients: never includes actualPrice unless revealed.
function buildTeamState() {
  const index = game.currentIndex;
  const item = currentItem();
  const status = index >= 0 ? game.itemStatus[index] : 'not_started';
  const highest = index >= 0 ? getHighestBid(index) : null;
  const winner = index >= 0 ? game.winners[index] : null;

  let publicItem = null;
  if (item) {
    publicItem = { id: item.id, name: item.name, image: item.image };
    if (status === 'revealed') {
      publicItem.actualPrice = item.actualPrice;
    }
  }

  return {
    currentIndex: index,
    totalItems: items.length,
    status,
    item: publicItem,
    highestBid: highest,
    winner,
    teams: Array.from(game.teams),
    gameOver: index >= items.length - 1 && status === 'revealed' && index === items.length - 1 ? false : undefined,
  };
}

// State sent to HOST client: full detail including actualPrice always (host is trusted/authenticated).
function buildHostState() {
  const index = game.currentIndex;
  return {
    currentIndex: index,
    totalItems: items.length,
    items: items.map((it, i) => ({
      ...it,
      status: game.itemStatus[i],
      bids: game.bids[i],
      winner: game.winners[i],
    })),
    teams: Array.from(game.teams),
  };
}

function buildResults() {
  return items.map((it, i) => ({
    id: it.id,
    name: it.name,
    winningTeam: game.winners[i] ? game.winners[i].teamName : null,
    winningBid: game.winners[i] ? game.winners[i].amount : null,
    actualPrice: game.itemStatus[i] === 'revealed' ? it.actualPrice : null,
  }));
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/host', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'host.html'));
});

const server = http.createServer(app);
const io = new Server(server);

function broadcastTeamState() {
  io.to('teams').emit('state', buildTeamState());
}

function broadcastHostState() {
  io.to('hosts').emit('hostState', buildHostState());
}

function broadcastAll() {
  broadcastTeamState();
  broadcastHostState();
}

io.on('connection', (socket) => {
  socket.isHost = false;
  socket.teamName = null;

  // ---- Team join ----
  socket.on('join', (data, ack) => {
    const teamName = (data && data.teamName || '').trim();
    if (!teamName) {
      return ack && ack({ ok: false, error: 'Team name required.' });
    }
    const existingSocketId = game.teamSockets.get(teamName);
    const isReconnect = game.teams.has(teamName) && (!existingSocketId || !io.sockets.sockets.get(existingSocketId));
    if (game.teams.has(teamName) && !isReconnect) {
      return ack && ack({ ok: false, error: 'That team name is already taken.' });
    }
    game.teams.add(teamName);
    game.teamSockets.set(teamName, socket.id);
    socket.teamName = teamName;
    socket.join('teams');
    ack && ack({ ok: true, teamName });
    socket.emit('state', buildTeamState());
    broadcastAll();
  });

  socket.on('placeBid', (data, ack) => {
    if (!socket.teamName) {
      return ack && ack({ ok: false, error: 'You must join with a team name first.' });
    }
    const index = game.currentIndex;
    if (index < 0 || game.itemStatus[index] !== 'open') {
      return ack && ack({ ok: false, error: 'Bidding is not open right now.' });
    }
    const amount = Number(data && data.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return ack && ack({ ok: false, error: 'Invalid bid amount.' });
    }
    const highest = getHighestBid(index);
    const minAllowed = highest ? highest.amount + MIN_INCREMENT : MIN_INCREMENT;
    if (amount < minAllowed) {
      return ack && ack({ ok: false, error: `Bid must be at least ${minAllowed}.` });
    }
    game.bids[index][socket.teamName] = { amount, time: Date.now() };
    ack && ack({ ok: true });
    broadcastAll();
  });

  // ---- Host auth ----
  socket.on('hostLogin', (data, ack) => {
    const password = data && data.password;
    if (password === HOST_PASSWORD) {
      socket.isHost = true;
      socket.join('hosts');
      ack && ack({ ok: true });
      socket.emit('hostState', buildHostState());
    } else {
      ack && ack({ ok: false, error: 'Incorrect password.' });
    }
  });

  function requireHost(ack) {
    if (!socket.isHost) {
      ack && ack({ ok: false, error: 'Not authenticated as host.' });
      return false;
    }
    return true;
  }

  socket.on('hostStartRound', (data, ack) => {
    if (!requireHost(ack)) return;
    if (game.currentIndex === -1) {
      game.currentIndex = 0;
    } else if (game.itemStatus[game.currentIndex] === 'revealed') {
      return ack && ack({ ok: false, error: 'Use Next Item to advance.' });
    }
    game.itemStatus[game.currentIndex] = 'open';
    ack && ack({ ok: true });
    broadcastAll();
  });

  socket.on('hostCloseBidding', (data, ack) => {
    if (!requireHost(ack)) return;
    const index = game.currentIndex;
    if (index < 0 || game.itemStatus[index] !== 'open') {
      return ack && ack({ ok: false, error: 'No open round to close.' });
    }
    game.itemStatus[index] = 'closed';
    const highest = getHighestBid(index);
    game.winners[index] = highest ? { teamName: highest.teamName, amount: highest.amount } : null;
    ack && ack({ ok: true });
    broadcastAll();
  });

  socket.on('hostRevealPrice', (data, ack) => {
    if (!requireHost(ack)) return;
    const index = game.currentIndex;
    if (index < 0 || game.itemStatus[index] !== 'closed') {
      return ack && ack({ ok: false, error: 'Close bidding before revealing.' });
    }
    game.itemStatus[index] = 'revealed';
    ack && ack({ ok: true });
    broadcastAll();
  });

  socket.on('hostNextItem', (data, ack) => {
    if (!requireHost(ack)) return;
    const index = game.currentIndex;
    if (index < 0 || game.itemStatus[index] !== 'revealed') {
      return ack && ack({ ok: false, error: 'Reveal the price before moving on.' });
    }
    if (index + 1 >= items.length) {
      return ack && ack({ ok: false, error: 'No more items. Show results.' });
    }
    game.currentIndex = index + 1;
    ack && ack({ ok: true });
    broadcastAll();
  });

  socket.on('hostGetResults', (data, ack) => {
    if (!requireHost(ack)) return;
    ack && ack({ ok: true, results: buildResults() });
  });

  socket.on('getResults', (data, ack) => {
    // Team-facing results are only meaningful once every item is revealed.
    const allRevealed = game.itemStatus.every((s) => s === 'revealed');
    if (!allRevealed) {
      return ack && ack({ ok: false, error: 'Results not final yet.' });
    }
    ack && ack({ ok: true, results: buildResults() });
  });

  socket.on('disconnect', () => {
    // Teams remain in the shared list even after disconnect so reconnects don't
    // require re-picking a name and leaderboards stay stable during the event.
  });
});

server.listen(PORT, () => {
  console.log(`Bid Battle server running on port ${PORT}`);
  console.log(`Team screen:  http://localhost:${PORT}/`);
  console.log(`Host screen:  http://localhost:${PORT}/host`);
});
