const canvas = document.querySelector("#game");
const ctx = canvas.getContext("2d");
const loginForm = document.querySelector("#loginForm");
const nameInput = document.querySelector("#nameInput");
const connection = document.querySelector("#connection");
const selectionText = document.querySelector("#selection");
const toast = document.querySelector("#toast");

localStorage.removeItem("sector-token");
localStorage.removeItem("sector-player");

const TOKEN_KEY = "mmorts-template-token";
const PLAYER_KEY = "mmorts-template-player";
const API_BASE = window.location.protocol === "file:" ? "http://localhost:3000" : "";

let token = localStorage.getItem(TOKEN_KEY) || "";
let playerId = localStorage.getItem(PLAYER_KEY) || "";
let world = null;
let selected = new Set();
let buildMode = "";
let eventSource = null;
let toastTimer = null;
let controlsReady = false;
let dragStart = null;
let dragCurrent = null;
let isDragging = false;
let loadError = "";

const tileSize = () => canvas.width / (world?.size || 24);

function setText(selector, value) {
  const element = document.querySelector(selector);
  if (element) element.textContent = value;
}

function api(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    }
  }).then(async response => {
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Request failed");
    return data;
  });
}

function loadJson(path, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  return fetch(`${API_BASE}${path}`, {
    cache: "no-store",
    signal: controller.signal,
    headers: {
      Accept: "application/json"
    }
  }).then(async response => {
    clearTimeout(timeout);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }).catch(error => {
    clearTimeout(timeout);
    throw error;
  });
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function myPlayer() {
  return world?.players.find(player => player.id === playerId);
}

function connectStream() {
  if (!token || eventSource) return;
  eventSource = new EventSource(`${API_BASE}/api/events?token=${encodeURIComponent(token)}`);
  eventSource.onopen = () => {
    connection.textContent = "Online";
  };
  eventSource.onerror = () => {
    connection.textContent = "Offline";
    eventSource.close();
    eventSource = null;
    token = "";
    playerId = "";
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(PLAYER_KEY);
  };
  eventSource.onmessage = event => {
    world = JSON.parse(event.data);
    renderUi();
    draw();
  };
}

function renderUi() {
  const player = myPlayer();
  renderControls();
  if (player) {
    setText("#food", player.resources.food);
    setText("#metal", player.resources.metal);
    setText("#energy", player.resources.energy);
  } else {
    setText("#food", "0");
    setText("#metal", "0");
    setText("#energy", "0");
  }

  setText("#mapName", world?.name || "Template");
  setText("#playerCount", world?.stats.players || 0);
  setText("#playerLimit", world?.maxPlayers || 50);
  setText("#unitCount", world?.stats.units || 0);
  setText("#matchStatus", world?.match?.winnerName
    ? "Finished"
    : world?.match?.started
      ? "In progress"
      : "Waiting");
  setText("#matchWinner", world?.match?.winnerName || "None");
  selectionText.textContent = selected.size
    ? `${selected.size} unit${selected.size === 1 ? "" : "s"} selected. Right-click to move or attack.`
    : world?.match?.winnerName
      ? `${world.match.winnerName} wins. New match starts in ${Math.ceil((world.match.resetAfterMs || 10000) / 1000)} seconds.`
    : player?.defeated
      ? "Your command base was destroyed. You are defeated."
    : buildMode
      ? `Choose a nearby tile for ${buildMode}.`
      : "Left-click a troop, or drag a box around troops. Right-click to move selected troops.";

  document.querySelectorAll("[data-build]").forEach(button => {
    button.classList.toggle("active", button.dataset.build === buildMode);
  });

  const roster = document.querySelector("#roster");
  roster.innerHTML = "";
  (world?.players || []).forEach(player => {
    const row = document.createElement("div");
    row.className = "roster-item";
    const status = player.defeated ? "Defeated" : player.online ? "Live" : "Away";
    row.innerHTML = `<span><i class="swatch" style="background:${player.color}"></i>${player.name}</span><strong>${status}</strong>`;
    roster.appendChild(row);
  });

  const events = document.querySelector("#events");
  events.innerHTML = "";
  (world?.events || []).slice().reverse().forEach(item => {
    const row = document.createElement("div");
    row.className = "event";
    row.textContent = item.text;
    events.appendChild(row);
  });
}

function renderControls() {
  if (!world?.catalog || controlsReady) return;

  const buildButtons = document.querySelector("#buildButtons");
  buildButtons.innerHTML = "";
  Object.entries(world.catalog.buildings).forEach(([type, building]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.build = type;
    button.textContent = building.label || type;
    button.title = building.description || "Template building";
    button.addEventListener("click", () => {
      buildMode = buildMode === type ? "" : type;
      renderUi();
    });
    buildButtons.appendChild(button);
  });

  const buildingInfo = document.querySelector("#buildingInfo");
  if (buildingInfo) {
    buildingInfo.innerHTML = "";
    Object.values(world.catalog.buildings).forEach(building => {
      const row = document.createElement("div");
      row.className = "event";
      row.textContent = `${building.label}: ${building.description || "Template building."}`;
      buildingInfo.appendChild(row);
    });
  }

  const trainButtons = document.querySelector("#trainButtons");
  trainButtons.innerHTML = "";
  Object.entries(world.catalog.units).forEach(([type, unit]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.train = type;
    button.textContent = unit.label || type;
    button.addEventListener("click", async () => {
      try {
        await api("/api/train", {
          method: "POST",
          body: JSON.stringify({ type })
        });
        showToast(`${unit.label || type} queued.`);
      } catch (error) {
        showToast(error.message);
      }
    });
    trainButtons.appendChild(button);
  });

  controlsReady = true;
}

function drawGrid() {
  const size = world.size;
  const t = tileSize();
  ctx.strokeStyle = "#263021";
  ctx.lineWidth = 1;
  for (let i = 0; i <= size; i += 1) {
    ctx.beginPath();
    ctx.moveTo(i * t, 0);
    ctx.lineTo(i * t, canvas.height);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i * t);
    ctx.lineTo(canvas.width, i * t);
    ctx.stroke();
  }
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!world) {
    ctx.fillStyle = "#edf3e8";
    ctx.font = "24px Arial";
    ctx.textAlign = "center";
    ctx.fillText(loadError || "Loading template map...", canvas.width / 2, canvas.height / 2);
    ctx.font = "14px Arial";
    ctx.fillStyle = "#aeb7c4";
    ctx.fillText("Use http://localhost:3000, or keep the server running if opened as a file", canvas.width / 2, canvas.height / 2 + 28);
    return;
  }

  drawGrid();
  const t = tileSize();
  drawMapFrame();

  if (world.match?.winnerName) {
    drawWinnerBanner(world.match.winnerName);
  }

  world.resourceNodes.forEach(node => {
    const colors = { food: "#84cc16", metal: "#94a3b8", energy: "#38bdf8" };
    ctx.fillStyle = colors[node.type];
    ctx.beginPath();
    ctx.arc((node.x + 0.5) * t, (node.y + 0.5) * t, t * 0.22, 0, Math.PI * 2);
    ctx.fill();
    if (node.controlledBy) {
      const owner = world.players.find(player => player.id === node.controlledBy);
      ctx.strokeStyle = owner?.color || "#f4f7fb";
      ctx.lineWidth = 3;
      ctx.stroke();
    }
  });

  (world.blockedTiles || []).forEach(tile => {
    ctx.fillStyle = "#29313a";
    ctx.fillRect(tile.x * t, tile.y * t, t, t);
  });

  world.players.forEach(player => {
    player.buildings.forEach(building => drawBuilding(player, building, t));
    drawBase(player, t);
  });

  world.players.forEach(player => {
    player.units.forEach(unit => drawUnit(player, unit, t));
  });

  drawSelectionBox();
}

function drawMapFrame() {
  ctx.fillStyle = "rgba(237, 243, 232, 0.08)";
  ctx.font = "22px Arial";
  ctx.textAlign = "left";
  ctx.fillText("MAP PLACEHOLDER", 22, 34);
  ctx.font = "14px Arial";
  ctx.fillText("Edit public/maps/template-map.json and add art in public/assets", 22, 58);
}

function drawWinnerBanner(name) {
  ctx.fillStyle = "rgba(16, 20, 24, 0.78)";
  ctx.fillRect(220, 420, 520, 92);
  ctx.strokeStyle = "#67e8f9";
  ctx.lineWidth = 2;
  ctx.strokeRect(220, 420, 520, 92);
  ctx.fillStyle = "#f4f7fb";
  ctx.textAlign = "center";
  ctx.font = "28px Arial";
  ctx.fillText(`${name} wins`, 480, 462);
  ctx.font = "15px Arial";
  ctx.fillText("Last commander standing", 480, 488);
}

function drawBase(player, t) {
  if (player.defeated || player.base.destroyed) {
    drawDestroyedBase(player, t);
    return;
  }

  ctx.fillStyle = player.color;
  ctx.strokeStyle = "#f8fafc";
  ctx.lineWidth = player.id === playerId ? 3 : 1;
  ctx.fillRect(player.base.x * t + 5, player.base.y * t + 5, t - 10, t - 10);
  ctx.strokeRect(player.base.x * t + 5, player.base.y * t + 5, t - 10, t - 10);
  drawHealth(player.base, player.base.x * t + 4, player.base.y * t + 1, t - 8);
}

function drawDestroyedBase(player, t) {
  const x = player.base.x * t;
  const y = player.base.y * t;
  ctx.strokeStyle = "#fb7185";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(x + 8, y + 8);
  ctx.lineTo(x + t - 8, y + t - 8);
  ctx.moveTo(x + t - 8, y + 8);
  ctx.lineTo(x + 8, y + t - 8);
  ctx.stroke();
}

function drawBuilding(player, building, t) {
  if (building.type === "command") return;
  const x = building.x * t;
  const y = building.y * t;
  ctx.fillStyle = "#2f3a2b";
  ctx.strokeStyle = player.color;
  ctx.lineWidth = 3;
  ctx.fillRect(x + 9, y + 9, t - 18, t - 18);
  ctx.strokeRect(x + 9, y + 9, t - 18, t - 18);
  ctx.fillStyle = "#edf3e8";
  ctx.font = "12px Arial";
  ctx.textAlign = "center";
  const label = world.catalog?.buildings?.[building.type]?.label || building.type;
  ctx.fillText(label[0].toUpperCase(), x + t / 2, y + t / 2 + 4);
}

function drawUnit(player, unit, t) {
  const x = unit.x * t + t / 2;
  const y = unit.y * t + t / 2;
  const isSelected = selected.has(unit.id);
  ctx.fillStyle = player.color;
  ctx.strokeStyle = isSelected ? "#facc15" : "#111827";
  ctx.lineWidth = isSelected ? 4 : 2;
  ctx.beginPath();
  if (unit.type === "tank") {
    ctx.rect(x - t * 0.22, y - t * 0.18, t * 0.44, t * 0.36);
  } else if (unit.type === "artillery") {
    ctx.moveTo(x, y - t * 0.26);
    ctx.lineTo(x + t * 0.24, y + t * 0.2);
    ctx.lineTo(x - t * 0.24, y + t * 0.2);
    ctx.closePath();
  } else {
    ctx.arc(x, y, t * 0.2, 0, Math.PI * 2);
  }
  ctx.fill();
  ctx.stroke();
  drawHealth(unit, x - t * 0.24, y - t * 0.35, t * 0.48);
}

function drawHealth(entity, x, y, width) {
  ctx.fillStyle = "#48151f";
  ctx.fillRect(x, y, width, 4);
  ctx.fillStyle = "#22c55e";
  ctx.fillRect(x, y, width * Math.max(0, entity.hp / entity.maxHp), 4);
}

function drawSelectionBox() {
  if (!isDragging || !dragStart || !dragCurrent) return;

  const left = Math.min(dragStart.px, dragCurrent.px);
  const top = Math.min(dragStart.py, dragCurrent.py);
  const width = Math.abs(dragCurrent.px - dragStart.px);
  const height = Math.abs(dragCurrent.py - dragStart.py);

  ctx.fillStyle = "rgba(103, 232, 249, 0.14)";
  ctx.strokeStyle = "#67e8f9";
  ctx.lineWidth = 2;
  ctx.fillRect(left, top, width, height);
  ctx.strokeRect(left, top, width, height);
}

function tileFromEvent(event) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const x = (event.clientX - rect.left) * scaleX;
  const y = (event.clientY - rect.top) * scaleY;
  const t = tileSize();
  return { x: Math.floor(x / t), y: Math.floor(y / t), px: x, py: y };
}

function findOwnUnitAt(tile) {
  const player = myPlayer();
  if (!player) return null;
  return player.units.find(unit => Math.hypot(unit.x - tile.x, unit.y - tile.y) < 0.75);
}

function selectUnitsInBox(start, end, keepExisting) {
  const player = myPlayer();
  if (!player) return;

  const left = Math.min(start.x, end.x);
  const right = Math.max(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const bottom = Math.max(start.y, end.y);

  if (!keepExisting) selected.clear();
  player.units.forEach(unit => {
    if (unit.x >= left && unit.x <= right && unit.y >= top && unit.y <= bottom) {
      selected.add(unit.id);
    }
  });
}

loginForm.addEventListener("submit", async event => {
  event.preventDefault();
  try {
    const data = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ name: nameInput.value })
    });
    token = data.token;
    playerId = data.playerId;
    world = data.world;
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(PLAYER_KEY, playerId);
    showToast("Command link established.");
    connectStream();
    renderUi();
    draw();
  } catch (error) {
    showToast(error.message);
  }
});

async function handleBuildAt(event) {
  if (!world || !playerId) return;
  const tile = tileFromEvent(event);

  try {
    await api("/api/build", {
      method: "POST",
      body: JSON.stringify({ type: buildMode, x: tile.x, y: tile.y })
    });
    showToast(`${buildMode} construction complete.`);
    buildMode = "";
    renderUi();
  } catch (error) {
    showToast(error.message);
  }
}

canvas.addEventListener("mousedown", event => {
  if (event.button !== 0 || !world || !playerId) return;
  dragStart = tileFromEvent(event);
  dragCurrent = dragStart;
  isDragging = false;
});

canvas.addEventListener("mousemove", event => {
  if (!dragStart) return;
  dragCurrent = tileFromEvent(event);
  isDragging = Math.hypot(dragCurrent.px - dragStart.px, dragCurrent.py - dragStart.py) > 8;
  draw();
});

canvas.addEventListener("mouseup", async event => {
  if (event.button !== 0 || !dragStart) return;
  const end = tileFromEvent(event);
  const wasDragging = isDragging;

  dragCurrent = end;
  isDragging = false;

  if (buildMode) {
    dragStart = null;
    dragCurrent = null;
    await handleBuildAt(event);
    draw();
    return;
  }

  if (wasDragging) {
    selectUnitsInBox(dragStart, end, event.shiftKey);
  } else {
    const unit = findOwnUnitAt(end);
    if (!event.shiftKey) selected.clear();
    if (unit) {
      if (selected.has(unit.id)) selected.delete(unit.id);
      else selected.add(unit.id);
    }
  }

  dragStart = null;
  dragCurrent = null;
  renderUi();
  draw();
});

canvas.addEventListener("contextmenu", async event => {
  event.preventDefault();
  const player = myPlayer();
  if (!player || player.defeated) return;

  const tile = tileFromEvent(event);
  const unitIds = [...selected];
  if (!unitIds.length) return;

  try {
    await api("/api/move", {
      method: "POST",
      body: JSON.stringify({ unitIds, x: tile.x, y: tile.y })
    });
    showToast(`${unitIds.length} troop${unitIds.length === 1 ? "" : "s"} moving.`);
  } catch (error) {
    showToast(error.message);
  }
});

function loadWorld() {
  loadJson("/api/world")
    .then(data => {
      loadError = "";
      world = data;
      renderUi();
      draw();
      if (token) connectStream();
    })
    .catch(error => {
      loadError = `Map load failed: ${error.name === "AbortError" ? "request timed out" : error.message}`;
      showToast(loadError);
      draw();
      setTimeout(loadWorld, 2000);
    });
}

loadWorld();

draw();
