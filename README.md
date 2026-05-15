# MMORTS Template

This is a simple browser-based MMORTS template for testing multiplayer RTS ideas. It gives you the basic project shape, a 50-player test limit, a shared online map, resource income, base building, unit training, movement, and automatic combat.

You can replace the placeholder graphics and edit the map later.

## Run

```bash
npm start
```

Open:

```text
http://localhost:3000
```

Open multiple browser tabs and join with different commander names to test multiplayer.

## Player Limit

The server is configured for 50 test players.

Edit this file to change it:

```text
config/game.json
```

```json
"server": {
  "maxPlayers": 50,
  "tickMs": 1000
}
```

## Add Your Map

Edit:

```text
public/maps/template-map.json
```

Important fields:

- `size`: map width and height in tiles
- `spawnPoints`: where players start
- `resourceNodes`: food, metal, and energy locations
- `blockedTiles`: tiles units cannot move to or build on

Example blocked tile:

```json
{ "x": 10, "y": 12 }
```

Restart the server after changing the map.

## Add Your Assets

Put images in:

```text
public/assets
```

Suggested structure:

```text
public/assets/tiles/grass.png
public/assets/buildings/base.png
public/assets/buildings/farm.png
public/assets/units/scout.png
```

The current game draws simple canvas shapes. When your assets are ready, replace the placeholder drawing functions in:

```text
public/app.js
```

Start with these functions:

- `drawBase`
- `drawBuilding`
- `drawUnit`

## Change Units And Buildings

Edit:

```text
config/game.json
```

You can add new units or buildings by adding new entries under:

- `units`
- `buildings`

The UI buttons are generated from this config automatically.

## Files

```text
server.js                     Node.js multiplayer server
config/game.json              Game balance and 50-player test limit
public/maps/template-map.json Map template
public/assets/                Drop your art here
public/index.html             Browser UI
public/styles.css             Styling
public/app.js                 Canvas rendering and controls
data/world.json               Auto-created saved player/world data
```

## Notes

This template uses JSON persistence to stay easy to understand. For a real online MMORTS, replace `data/world.json` with a database such as SQLite, MySQL, or PostgreSQL, and use WebSockets for lower-latency gameplay.
