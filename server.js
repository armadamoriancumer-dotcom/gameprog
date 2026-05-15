const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "world.json");
const CONFIG_FILE = path.join(__dirname, "config", "game.json");
const MAP_FILE = path.join(PUBLIC_DIR, "maps", "template-map.json");

const gameConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
const mapTemplate = JSON.parse(fs.readFileSync(MAP_FILE, "utf8"));
const DATA_VERSION = "mmorts-template-v2";
const TICK_MS = gameConfig.server.tickMs;
const RESET_AFTER_WIN_MS = gameConfig.server.resetAfterWinMs || 10000;
const MAX_PLAYERS = gameConfig.server.maxPlayers;
const UNIT_STATS = gameConfig.units;
const BUILDINGS = gameConfig.buildings;

const sessions = new Map();
const clients = new Set();
let db = loadDb();
let resetTimerStarted = false;

function loadDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) return createFreshDb();

  const loaded = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  if (loaded.version !== DATA_VERSION) return createFreshDb();

  loaded.world = {
    name: mapTemplate.name,
    size: mapTemplate.size,
    tileset: mapTemplate.tileset,
    resourceNodes: mapTemplate.resourceNodes,
    blockedTiles: mapTemplate.blockedTiles,
    events: loaded.world.events || [],
    matchStarted: Boolean(loaded.world.matchStarted),
    winnerId: loaded.world.winnerId || null,
    winnerName: loaded.world.winnerName || null,
    finishedAt: loaded.world.finishedAt || null
  };
  return loaded;
}

function createFreshDb() {
  const fresh = {
    version: DATA_VERSION,
    players: {},
    world: {
      name: mapTemplate.name,
      size: mapTemplate.size,
      tileset: mapTemplate.tileset,
      resourceNodes: mapTemplate.resourceNodes,
      blockedTiles: mapTemplate.blockedTiles,
      events: [],
      matchStarted: false,
      winnerId: null,
      winnerName: null,
      finishedAt: null
    }
  };
  fs.writeFileSync(DB_FILE, JSON.stringify(fresh, null, 2));
  return fresh;
}

function saveDb() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function uid(prefix) {
  return `${prefix}-${crypto.randomBytes(6).toString("hex")}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1e6) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(JSON.stringify(payload));
}

function sanitizeName(name) {
  return String(name || "").trim().slice(0, 18).replace(/[^\w -]/g, "");
}

function publicPlayer(player) {
  return {
    id: player.id,
    name: player.name,
    color: player.color,
    resources: player.resources,
    base: player.base,
    buildings: player.buildings,
    units: player.units,
    queue: player.queue,
    defeated: Boolean(player.defeated),
    online: Boolean(player.online)
  };
}

function worldSnapshot() {
  return {
    name: db.world.name,
    size: db.world.size,
    tileset: db.world.tileset,
    resourceNodes: db.world.resourceNodes,
    blockedTiles: db.world.blockedTiles,
    maxPlayers: MAX_PLAYERS,
    match: {
      started: db.world.matchStarted,
      winnerId: db.world.winnerId,
      winnerName: db.world.winnerName,
      finishedAt: db.world.finishedAt,
      resetAfterMs: RESET_AFTER_WIN_MS
    },
    catalog: {
      buildings: BUILDINGS,
      units: UNIT_STATS
    },
    players: Object.values(db.players).map(publicPlayer),
    events: db.world.events.slice(-8),
    stats: {
      players: Object.keys(db.players).length,
      units: Object.values(db.players).reduce((sum, p) => sum + p.units.length, 0)
    }
  };
}

function broadcast() {
  const data = `data: ${JSON.stringify(worldSnapshot())}\n\n`;
  for (const res of clients) res.write(data);
}

function getPlayer(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = req.headers.authorization?.replace("Bearer ", "") || url.searchParams.get("token");
  const playerId = sessions.get(token);
  return playerId ? db.players[playerId] : null;
}

function findSpawn() {
  const choices = mapTemplate.spawnPoints || [{ x: 2, y: 2 }];
  const used = new Set(Object.values(db.players).map(p => `${p.base.x},${p.base.y}`));
  const open = choices.find(point => !used.has(`${point.x},${point.y}`));
  if (open) return { x: open.x, y: open.y };
  return {
    x: Math.floor(Math.random() * (db.world.size - 6)) + 3,
    y: Math.floor(Math.random() * (db.world.size - 6)) + 3
  };
}

function createPlayer(name) {
  const id = uid("player");
  const base = findSpawn();
  const colors = ["#3b82f6", "#ef4444", "#22c55e", "#eab308", "#a855f7", "#06b6d4", "#f97316", "#14b8a6"];
  const player = {
    id,
    name,
    color: colors[Object.keys(db.players).length % colors.length],
    resources: { ...gameConfig.startingResources },
    base: { ...base, hp: 500, maxHp: 500 },
    buildings: [
      { id: uid("building"), type: "command", x: base.x, y: base.y, hp: 500, maxHp: 500 }
    ],
    units: [
      makeUnit("scout", base.x + 1, base.y, id),
      makeUnit("scout", base.x, base.y + 1, id)
    ],
    queue: [],
    defeated: false,
    online: true,
    lastSeen: Date.now()
  };
  db.players[id] = player;
  addEvent(`${name} joined the test map.`);
  updateMatchState();
  return player;
}

function makeUnit(type, x, y, ownerId) {
  const stats = UNIT_STATS[type];
  return {
    id: uid("unit"),
    ownerId,
    type,
    x,
    y,
    targetX: x,
    targetY: y,
    hp: stats.hp,
    maxHp: stats.hp,
    attackCooldown: 0
  };
}

function addEvent(text) {
  db.world.events.push({ id: uid("event"), text, at: Date.now() });
  db.world.events = db.world.events.slice(-20);
}

function canPay(player, cost) {
  return Object.entries(cost).every(([key, value]) => (player.resources[key] || 0) >= value);
}

function pay(player, cost) {
  Object.entries(cost).forEach(([key, value]) => {
    player.resources[key] -= value;
  });
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function isBlocked(x, y) {
  return db.world.blockedTiles.some(tile => tile.x === x && tile.y === y);
}

function formationOffset(index, total) {
  if (total <= 1) return { x: 0, y: 0 };

  const columns = Math.ceil(Math.sqrt(total));
  const row = Math.floor(index / columns);
  const column = index % columns;
  const usedRows = Math.ceil(total / columns);
  const spacing = 0.85;

  return {
    x: (column - (columns - 1) / 2) * spacing,
    y: (row - (usedRows - 1) / 2) * spacing
  };
}

function clampPosition(value) {
  return clamp(value, 0.2, db.world.size - 0.8);
}

function collectResourceNodes(player) {
  if (player.defeated) return;

  db.world.resourceNodes.forEach(node => {
    const hasCollector = player.units.some(unit => distance(unit, node) <= 0.85);
    if (!hasCollector) return;

    player.resources[node.type] = Math.min(9999, (player.resources[node.type] || 0) + 10);
    if (node.controlledBy !== player.id) {
      addEvent(`${player.name} captured a ${node.type} node.`);
    }
    node.controlledBy = player.id;
  });
}

function defeatPlayer(player, attacker) {
  if (player.defeated) return;

  player.defeated = true;
  player.online = false;
  player.units = [];
  player.queue = [];
  player.buildings = [];
  player.base.hp = 0;
  player.base.destroyed = true;
  addEvent(`${attacker.name} destroyed ${player.name}'s command base. ${player.name} is defeated.`);
  updateMatchState();
}

function updateMatchState() {
  const players = Object.values(db.players);
  const alive = players.filter(player => !player.defeated);

  if (players.length >= 2) db.world.matchStarted = true;
  if (!db.world.matchStarted || db.world.winnerId || alive.length !== 1) return;

  const winner = alive[0];
  db.world.winnerId = winner.id;
  db.world.winnerName = winner.name;
  db.world.finishedAt = Date.now();
  addEvent(`${winner.name} wins the match.`);
  resetTimerStarted = false;
}

function isMatchFinished() {
  return Boolean(db.world.winnerId);
}

function resetMatchForNewPlayers() {
  db = createFreshDb();
  sessions.clear();
  resetTimerStarted = false;
  broadcast();
}

function routeApi(req, res, pathname) {
  if (req.method === "POST" && pathname === "/api/login") {
    return readBody(req).then(body => {
      const name = sanitizeName(body.name) || "Commander";
      let player = Object.values(db.players).find(p => p.name.toLowerCase() === name.toLowerCase());

      if (!player && isMatchFinished()) {
        return sendJson(res, 403, { error: `${db.world.winnerName} already won. Reset the world to start a new match.` });
      }

      if (!player && Object.keys(db.players).length >= MAX_PLAYERS) {
        return sendJson(res, 403, { error: `Server is full. Test limit is ${MAX_PLAYERS} players.` });
      }

      if (!player) player = createPlayer(name);
      player.online = true;
      player.lastSeen = Date.now();
      const token = uid("token");
      sessions.set(token, player.id);
      saveDb();
      sendJson(res, 200, { token, playerId: player.id, world: worldSnapshot() });
      broadcast();
    }).catch(() => sendJson(res, 400, { error: "Invalid JSON" }));
  }

  if (req.method === "GET" && pathname === "/api/world") {
    return sendJson(res, 200, worldSnapshot());
  }

  if (req.method === "GET" && pathname === "/api/events") {
    const player = getPlayer(req);
    if (!player) return sendJson(res, 401, { error: "Log in first" });
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    res.write(`data: ${JSON.stringify(worldSnapshot())}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  if (req.method === "POST" && pathname === "/api/build") {
    return readBody(req).then(body => {
      const player = getPlayer(req);
      const blueprint = BUILDINGS[body.type];
      if (!player || !blueprint) return sendJson(res, 400, { error: "Cannot build that" });
      if (isMatchFinished()) return sendJson(res, 400, { error: "The match is already finished" });
      if (player.defeated) return sendJson(res, 400, { error: "You are defeated" });

      const x = clamp(Number(body.x), 0, db.world.size - 1);
      const y = clamp(Number(body.y), 0, db.world.size - 1);
      if (isBlocked(x, y)) return sendJson(res, 400, { error: "That map tile is blocked" });
      if (distance({ x, y }, player.base) > 6) return sendJson(res, 400, { error: "Build closer to your base" });
      if (!canPay(player, blueprint.cost)) return sendJson(res, 400, { error: "Not enough resources" });

      pay(player, blueprint.cost);
      player.buildings.push({ id: uid("building"), type: body.type, x, y, hp: blueprint.hp, maxHp: blueprint.hp });
      addEvent(`${player.name} built a ${blueprint.label}.`);
      saveDb();
      broadcast();
      sendJson(res, 200, { ok: true });
    }).catch(() => sendJson(res, 400, { error: "Invalid JSON" }));
  }

  if (req.method === "POST" && pathname === "/api/train") {
    return readBody(req).then(body => {
      const player = getPlayer(req);
      const stats = UNIT_STATS[body.type];
      if (!player || !stats) return sendJson(res, 400, { error: "Cannot train that" });
      if (isMatchFinished()) return sendJson(res, 400, { error: "The match is already finished" });
      if (player.defeated) return sendJson(res, 400, { error: "You are defeated" });
      const hasBarracks = player.buildings.some(b => b.type === "barracks" || b.type === "command");
      if (!hasBarracks) return sendJson(res, 400, { error: "Build a barracks first" });
      if (!canPay(player, stats.cost)) return sendJson(res, 400, { error: "Not enough resources" });

      pay(player, stats.cost);
      player.queue.push({ id: uid("queue"), type: body.type, readyAt: Date.now() + stats.buildMs });
      saveDb();
      broadcast();
      sendJson(res, 200, { ok: true });
    }).catch(() => sendJson(res, 400, { error: "Invalid JSON" }));
  }

  if (req.method === "POST" && pathname === "/api/move") {
    return readBody(req).then(body => {
      const player = getPlayer(req);
      if (!player) return sendJson(res, 401, { error: "Log in first" });
      if (isMatchFinished()) return sendJson(res, 400, { error: "The match is already finished" });
      if (player.defeated) return sendJson(res, 400, { error: "You are defeated" });

      const ids = Array.isArray(body.unitIds) ? body.unitIds : [];
      const x = clamp(Number(body.x), 0, db.world.size - 1);
      const y = clamp(Number(body.y), 0, db.world.size - 1);
      if (isBlocked(x, y)) return sendJson(res, 400, { error: "That map tile is blocked" });

      const movingUnits = player.units.filter(unit => ids.includes(unit.id));
      movingUnits.forEach((unit, index) => {
        const offset = formationOffset(index, movingUnits.length);
        unit.targetX = clampPosition(x + offset.x);
        unit.targetY = clampPosition(y + offset.y);
      });
      saveDb();
      broadcast();
      sendJson(res, 200, { ok: true });
    }).catch(() => sendJson(res, 400, { error: "Invalid JSON" }));
  }

  sendJson(res, 404, { error: "Not found" });
}

function serveStatic(req, res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    const types = {
      ".html": "text/html",
      ".css": "text/css",
      ".js": "application/javascript",
      ".json": "application/json",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp"
    };
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
    res.end(data);
  });
}

function tick() {
  const now = Date.now();

  if (db.world.winnerId) {
    if (!resetTimerStarted) {
      resetTimerStarted = true;
      addEvent(`New match starts in ${Math.ceil(RESET_AFTER_WIN_MS / 1000)} seconds.`);
      saveDb();
      broadcast();
    }

    if (now - db.world.finishedAt >= RESET_AFTER_WIN_MS) {
      resetMatchForNewPlayers();
    }
    return;
  }

  Object.values(db.players).forEach(player => {
    if (now - player.lastSeen > 60000) player.online = false;
    if (player.defeated) return;

    const income = { ...gameConfig.baseIncome };
    player.buildings.forEach(building => {
      const extra = BUILDINGS[building.type]?.income || {};
      Object.entries(extra).forEach(([key, value]) => {
        income[key] = (income[key] || 0) + value;
      });
    });
    Object.entries(income).forEach(([key, value]) => {
      player.resources[key] = Math.min(9999, Math.floor((player.resources[key] || 0) + value));
    });

    const ready = player.queue.filter(item => item.readyAt <= now);
    player.queue = player.queue.filter(item => item.readyAt > now);
    ready.forEach(item => {
      player.units.push(makeUnit(item.type, player.base.x + Math.random() * 2 - 1, player.base.y + Math.random() * 2 - 1, player.id));
      addEvent(`${player.name} deployed a ${UNIT_STATS[item.type].label}.`);
    });

    player.units.forEach(unit => {
      const stats = UNIT_STATS[unit.type];
      const dx = unit.targetX - unit.x;
      const dy = unit.targetY - unit.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 0.05) {
        const step = Math.min(stats.speed * (TICK_MS / 1000), dist);
        unit.x += (dx / dist) * step;
        unit.y += (dy / dist) * step;
      }
      unit.attackCooldown = Math.max(0, unit.attackCooldown - TICK_MS);
    });

    collectResourceNodes(player);
  });

  resolveCombat();
  saveDb();
  broadcast();
}

function resolveCombat() {
  const players = Object.values(db.players);
  players.forEach(attacker => {
    if (attacker.defeated) return;

    attacker.units.forEach(unit => {
      if (unit.attackCooldown > 0) return;
      const stats = UNIT_STATS[unit.type];
      let best = null;

      players.forEach(defender => {
        if (defender.id === attacker.id || defender.defeated) return;

        defender.units.forEach(enemy => {
          const d = distance(unit, enemy);
          if (d <= stats.range && (!best || d < best.d)) best = { kind: "unit", target: enemy, owner: defender, d };
        });

        defender.buildings
          .filter(building => building.type !== "command")
          .forEach(building => {
            const d = distance(unit, building);
            if (d <= stats.range && (!best || d < best.d)) {
              best = { kind: "building", target: building, owner: defender, d };
            }
          });

        const baseDistance = distance(unit, defender.base);
        if (!defender.base.destroyed && baseDistance <= stats.range && (!best || baseDistance < best.d)) {
          best = { kind: "base", target: defender.base, owner: defender, d: baseDistance };
        }
      });

      if (!best) return;
      best.target.hp -= stats.attack;
      unit.attackCooldown = 1000;

      if (best.target.hp <= 0) {
        if (best.kind === "unit") {
          best.owner.units = best.owner.units.filter(enemy => enemy.id !== best.target.id);
        } else if (best.kind === "building") {
          best.owner.buildings = best.owner.buildings.filter(building => building.id !== best.target.id);
          addEvent(`${attacker.name} destroyed ${best.owner.name}'s ${best.target.type}.`);
        } else {
          defeatPlayer(best.owner, attacker);
        }
      }
    });
  });
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization"
    });
    res.end();
    return;
  }
  if (pathname.startsWith("/api/")) {
    routeApi(req, res, pathname);
    return;
  }
  serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`MMORTS template server running at http://localhost:${PORT}`);
  console.log(`Test player limit: ${MAX_PLAYERS}`);
});

setInterval(tick, TICK_MS);
