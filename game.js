const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

// UI Elements
const uiHoleInfo = document.getElementById('hole-info');
const uiScoreInfo = document.getElementById('score-info');
const uiTotalScore = document.getElementById('total-score');
const messageOverlay = document.getElementById('message-overlay');
const messageTitle = document.getElementById('message-title');
const messageSubtitle = document.getElementById('message-subtitle');
const nextHoleBtn = document.getElementById('next-hole-btn');

// Constants
const FPS = 60;
const FRICTION = 0.97;
const BALL_RADIUS = 5;
const HOLE_RADIUS = 8;
const TILE_SIZE = 40;
const MAX_POWER = 15;

let WIDTH = 800;
let HEIGHT = 600;

function setupCanvasDimensions() {
    let w = window.innerWidth;
    let h = window.innerHeight;
    
    w = Math.floor(w / TILE_SIZE) * TILE_SIZE;
    h = Math.floor(h / TILE_SIZE) * TILE_SIZE;
    
    if (w > 800) w = 800;
    if (w >= 600 && h > 600) h = 600; 
    if (h > 1200) h = 1200;
    
    if (w < 320) w = 320;
    if (h < 400) h = 400;
    
    canvas.width = w;
    canvas.height = h;
    WIDTH = w;
    HEIGHT = h;
}
setupCanvasDimensions();

// Colors (8-bit palette)
const COLOR_WALL = '#8B4513';
const COLOR_WALL_TOP = '#A0522D';
const COLOR_GREEN_DARK = '#228B22';
const COLOR_GREEN_LIGHT = '#32CD32';
const COLOR_HOLE = '#000000';
const COLOR_AIM = '#FFD700';

const PLAYER_COLORS = [
    '#FFFFFF', // P1: White
    '#FF3333', // P2: Red
    '#33FFFF', // P3: Cyan
    '#FF33FF'  // P4: Magenta
];

// Game State
let currentHole = 1;
let totalHoles = 18;
let gameState = 'LOBBY'; // LOBBY, PLAYING, AIMING, ROLLING, HOLED, GAMEOVER

let players = [];
let currentPlayer = 0;
let numPlayers = 1;
let holePars = Array(18).fill(3);
let currentPar = 3;

// Multiplayer Network State
let peer = null;
let connections = [];
let isHost = false;
let isMultiplayer = false;
let localPlayerIndex = 0;
let readyPlayers = 0;

function checkAllPlayersReady() {
    if (readyPlayers >= numPlayers) {
        readyPlayers = 0;
        
        document.getElementById('message-overlay').classList.add('hidden');
        document.getElementById('next-hole-btn').innerText = "Next Hole";
        document.getElementById('next-hole-btn').disabled = false;
        
        currentHole++;
        startHole();
    }
}

function broadcast(data, excludeConnection = null) {
    for (let c of connections) {
        if (c !== excludeConnection && c.open) {
            c.send(data);
        }
    }
}

function sendNetworkData(data) {
    if (!isMultiplayer) return;
    if (isHost) {
        broadcast(data);
    } else {
        if (connections.length > 0) connections[0].send(data);
    }
}

// Audio System
let audioCtx;
function initAudio() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
}

function playSoundHit() {
    if (!audioCtx) return;
    let osc = audioCtx.createOscillator();
    let gain = audioCtx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(300, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(800, audioCtx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.1);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.1);
}

function playSoundBounce() {
    if (!audioCtx) return;
    let osc = audioCtx.createOscillator();
    let gain = audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(150, audioCtx.currentTime);
    gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.1);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.1);
}

function playSoundHole() {
    if (!audioCtx) return;
    let t = audioCtx.currentTime;
    let notes = [400, 500, 600, 800];
    notes.forEach((freq, i) => {
        let osc = audioCtx.createOscillator();
        let gain = audioCtx.createGain();
        osc.type = 'square';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.1, t + i * 0.1);
        gain.gain.exponentialRampToValueAtTime(0.01, t + i * 0.1 + 0.1);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(t + i * 0.1);
        osc.stop(t + i * 0.1 + 0.1);
    });
}

let hole = { x: 0, y: 0 };
let walls = [];
let greenZones = [];
let borders = []; // Visual edges
let globalGrid = []; // To check tile under ball

function buildCourseGeometry(grid) {
    globalGrid = grid;
    walls = [];
    greenZones = [];
    borders = [];
    
    let rows = grid.length;
    let cols = grid[0].length;
    
    for(let r=0; r<rows; r++) {
        for(let c=0; c<cols; c++) {
            let tile = grid[r][c];
            let x = c * TILE_SIZE;
            let y = r * TILE_SIZE;
            
            if (tile === 'wall') {
                walls.push({ x, y, w: TILE_SIZE, h: TILE_SIZE });
            } else if (tile === 'green') {
                greenZones.push({
                    x, y, w: TILE_SIZE, h: TILE_SIZE,
                    pattern: (r+c)%2 === 0 ? COLOR_GREEN_DARK : COLOR_GREEN_LIGHT
                });
            }
            
            // Visual bumper borders
            if (tile !== 'wall') {
                if (r===0 || grid[r-1][c] === 'wall') borders.push({x1: x, y1: y, x2: x+TILE_SIZE, y2: y});
                if (r===rows-1 || grid[r+1][c] === 'wall') borders.push({x1: x, y1: y+TILE_SIZE, x2: x+TILE_SIZE, y2: y+TILE_SIZE});
                if (c===0 || grid[r][c-1] === 'wall') borders.push({x1: x, y1: y, x2: x, y2: y+TILE_SIZE});
                if (c===cols-1 || grid[r][c+1] === 'wall') borders.push({x1: x+TILE_SIZE, y1: y, x2: x+TILE_SIZE, y2: y+TILE_SIZE});
            }
        }
    }
}

// Input State
let isDragging = false;
let dragStart = { x: 0, y: 0 };
let dragCurrent = { x: 0, y: 0 };

// Init Local
document.querySelectorAll('.player-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        initAudio();
        isMultiplayer = false;
        numPlayers = parseInt(e.target.dataset.players);
        document.getElementById('title-screen').classList.add('hidden');
        startGame();
    });
});

// Init Network UI
document.getElementById('btn-host').addEventListener('click', () => {
    initAudio();
    isMultiplayer = true;
    isHost = true;
    localPlayerIndex = 0;
    numPlayers = 1;
    gameState = 'LOBBY';
    
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let code = '';
    for(let i=0; i<4; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
    
    document.getElementById('room-code-display').innerText = code;
    document.getElementById('online-buttons').classList.add('hidden');
    document.getElementById('host-ui').classList.remove('hidden');
    
    peer = new Peer('MGOLF-' + code);
    peer.on('connection', (c) => {
        if (gameState === 'PLAYING') return; // Cannot join mid-game
        if (connections.length >= 3) return; // Max 4 players total
        
        connections.push(c);
        numPlayers++;
        document.getElementById('host-lobby-count').innerText = `Players in lobby: ${numPlayers}/4`;
        
        c.on('data', (data) => {
            handleNetworkData(data, c);
        });
        
        c.on('open', () => {
            broadcast({ type: 'LOBBY_UPDATE', count: numPlayers });
        });
        
        c.on('close', () => {
            let idx = connections.indexOf(c);
            if(idx > -1) {
                connections.splice(idx, 1);
                numPlayers--;
                document.getElementById('host-lobby-count').innerText = `Players in lobby: ${numPlayers}/4`;
                broadcast({ type: 'LOBBY_UPDATE', count: numPlayers });
            }
        });
    });
});

document.getElementById('btn-start-multiplayer').addEventListener('click', () => {
    if (connections.length < 1) {
        alert("Wait for at least 1 friend to join!");
        return;
    }
    document.getElementById('title-screen').classList.add('hidden');
    startGame();
});

document.getElementById('btn-join-menu').addEventListener('click', () => {
    document.getElementById('online-buttons').classList.add('hidden');
    document.getElementById('join-ui').classList.remove('hidden');
});

document.getElementById('btn-join').addEventListener('click', () => {
    initAudio();
    let code = document.getElementById('join-code-input').value.toUpperCase();
    if(code.length !== 4) return;
    
    isMultiplayer = true;
    isHost = false;
    localPlayerIndex = 1; // Will be overwritten by MAP_DATA
    
    document.getElementById('btn-join').innerText = "Connecting...";
    
    peer = new Peer();
    peer.on('open', () => {
        let conn = peer.connect('MGOLF-' + code);
        connections.push(conn);
        
        conn.on('open', () => {
            document.getElementById('join-input-section').classList.add('hidden');
            document.getElementById('join-lobby-status').classList.remove('hidden');
        });
        
        conn.on('data', (data) => {
            handleNetworkData(data, conn);
        });
        
        conn.on('close', () => {
            alert("Disconnected from Host.");
        });
    });
    
    peer.on('error', (err) => {
        if (err.type === 'peer-unavailable') {
            alert("Room not found! Check the code and try again.");
            document.getElementById('btn-join').innerText = "Connect";
        }
    });
});

function handleNetworkData(data, sourceConn) {
    // If we are the Host, forward actions to all OTHER clients so everyone is synced
    if (isHost && (data.type === 'SHOT' || data.type === 'SYNC')) {
        broadcast(data, sourceConn);
    }

    if (data.type === 'LOBBY_UPDATE') {
        if (!isHost) {
            document.getElementById('join-lobby-status').innerText = `Connected! Players in lobby: ${data.count}/4\nWaiting for host to start...`;
        }
    } else if (data.type === 'READY_NEXT_HOLE') {
        if (isHost) {
            readyPlayers++;
            checkAllPlayersReady();
        }
    } else if (data.type === 'MAP_DATA') {
        numPlayers = data.numPlayers;
        if (!isHost) {
            localPlayerIndex = data.yourPlayerIndex;
            document.getElementById('title-screen').classList.add('hidden');
        }
        
        let cols = data.grid[0].length;
        let rows = data.grid.length;
        WIDTH = cols * TILE_SIZE;
        HEIGHT = rows * TILE_SIZE;
        canvas.width = WIDTH;
        canvas.height = HEIGHT;
        
        buildCourseGeometry(data.grid);
        
        hole.x = data.hx;
        hole.y = data.hy;
        currentPar = data.currentPar;
        currentHole = data.currentHole;
        holePars = data.holePars;
        
        if (players.length === 0) {
            for(let i=0; i<numPlayers; i++) {
                players.push({
                    id: i+1,
                    color: PLAYER_COLORS[i],
                    totalScore: 0,
                    holeScores: Array(18).fill('-'),
                    strokes: 0,
                    holed: false,
                    ball: {x: data.startC*TILE_SIZE + TILE_SIZE/2, y: data.startR*TILE_SIZE + TILE_SIZE/2, vx: 0, vy: 0, radius: 5},
                    lastPosition: {x: data.startC*TILE_SIZE + TILE_SIZE/2, y: data.startR*TILE_SIZE + TILE_SIZE/2}
                });
            }
        } else {
            for(let p of players) {
                p.strokes = 0;
                p.holed = false;
                p.ball.x = data.startC*TILE_SIZE + TILE_SIZE/2;
                p.ball.y = data.startR*TILE_SIZE + TILE_SIZE/2;
                p.ball.vx = 0; p.ball.vy = 0;
            }
        }
        
        document.getElementById('message-overlay').classList.add('hidden');
        document.getElementById('next-hole-btn').innerText = "Next Hole";
        document.getElementById('next-hole-btn').disabled = false;
        
        gameState = 'PLAYING';
        currentPlayer = 0;
        isDragging = false;
        
        updateUI();
        
        if (currentHole === 1) {
            lastTime = performance.now();
            requestAnimationFrame(gameLoop);
        }
    } else if (data.type === 'SHOT') {
        currentPlayer = data.player; // FORCE RESYNC THE TURN
        
        let p = players[data.player];
        p.ball.vx = data.vx;
        p.ball.vy = data.vy;
        playSoundHit();
        p.strokes++;
        updateUI();
        gameState = 'ROLLING';
    } else if (data.type === 'SYNC') {
        let p = players[data.player];
        p.ball.x = data.x;
        p.ball.y = data.y;
        p.strokes = data.strokes;
        
        if (data.holed && !p.holed) {
            p.holed = true;
            playSoundHole();
            nextTurn(); 
        } else if (!data.holed && p.holed) {
            p.holed = false;
        }
        updateUI();
    }
}

function startGame() {
    players = [];
    holePars = Array(18).fill(3);
    for(let i=0; i<numPlayers; i++) {
        players.push({
            color: PLAYER_COLORS[i],
            strokes: 0,
            totalScore: 0,
            holeScores: Array(18).fill('-'),
            ball: {x: 0, y: 0, vx: 0, vy: 0},
            lastPosition: {x: 0, y: 0},
            holed: false
        });
    }
    currentHole = 1;
    startHole();
    if (!window.gameLoopRunning) {
        window.gameLoopRunning = true;
        requestAnimationFrame(gameLoop);
    }
}

function startHole() {
    gameState = 'PLAYING';
    currentPlayer = 0;
    generateLevel();
    for(let p of players) {
        p.strokes = 0;
        p.holed = false;
        p.lastPosition.x = p.ball.x;
        p.lastPosition.y = p.ball.y;
    }
    updateUI();
}

function generateLevel() {
    const cols = Math.floor(WIDTH / TILE_SIZE);
    const rows = Math.floor(HEIGHT / TILE_SIZE);
    
    let attempts = 0;
    let bestLevel = null;
    let maxPathFound = 0;
    
    while(attempts < 2000) {
        attempts++;
        let grid = Array(rows).fill(null).map(() => Array(cols).fill('wall'));
        
        let startC = Math.floor(Math.random() * (cols / 2 - 2)) + 2; 
        let startR = Math.floor(Math.random() * 4) + (rows - 6);
        
        for(let r=startR-1; r<=startR+1; r++) {
            for(let c=startC-1; c<=startC+1; c++) {
                if(r>=3 && r<rows-1 && c>=1 && c<cols-1) grid[r][c] = 'green';
            }
        }
        
        let currentC = startC;
        let currentR = startR;
        let segments = Math.floor(Math.random() * 5) + 6; // 6 to 10 segments
        
        let path = [{c: currentC, r: currentR}];
        let dir = Math.floor(Math.random() * 4);
        
        for(let i=0; i<segments; i++) {
            dir = (dir + (Math.random() > 0.5 ? 1 : -1) + 4) % 4;
            let dist = Math.floor(Math.random() * 5) + 4; // 4 to 8 tiles per segment
            
            let dc = 0, dr = 0;
            if(dir === 0) dr = -1; 
            else if(dir === 1) dc = 1;  
            else if(dir === 2) dr = 1;  
            else if(dir === 3) dc = -1; 
            
            for(let d=0; d<dist; d++) {
                let nextC = currentC + dc;
                let nextR = currentR + dr;
                if (nextC < 1 || nextC >= cols - 1 || nextR < 3 || nextR >= rows - 1) {
                    break;
                }
                currentC = nextC;
                currentR = nextR;
                
                grid[currentR][currentC] = 'green';
                path.push({c: currentC, r: currentR});
            }
        }
        
        let endArea = path[path.length-1];
        let hx = endArea.c * TILE_SIZE + TILE_SIZE/2;
        let hy = endArea.r * TILE_SIZE + TILE_SIZE/2;
        
        for(let r=endArea.r-1; r<=endArea.r+1; r++) {
            for(let c=endArea.c-1; c<=endArea.c+1; c++) {
                if(r>=3 && r<rows-1 && c>=1 && c<cols-1) grid[r][c] = 'green';
            }
        }
        
        let possibleObstacles = [];
        for(let r=0; r<rows; r++) {
            for(let c=0; c<cols; c++) {
                if (grid[r][c] === 'green') {
                    let distToStart = Math.hypot(c - startC, r - startR);
                    let distToHole = Math.hypot(c - endArea.c, r - endArea.r);
                    if (distToStart > 3 && distToHole > 3) {
                        possibleObstacles.push({r, c});
                    }
                }
            }
        }
        
        possibleObstacles.sort(() => Math.random() - 0.5);
        let numObstacles = Math.min(Math.floor(Math.random() * 5) + 5, possibleObstacles.length);
        for(let i=0; i<numObstacles; i++) {
            grid[possibleObstacles[i].r][possibleObstacles[i].c] = 'wall';
        }
        
        let visited = Array(rows).fill(null).map(() => Array(cols).fill(false));
        let queue = [{c: startC, r: startR}];
        visited[startR][startC] = true;
        let foundHole = false;
        
        while(queue.length > 0) {
            let curr = queue.shift();
            if (curr.c === endArea.c && curr.r === endArea.r) {
                foundHole = true;
            }
            let neighbors = [
                {c: curr.c+1, r: curr.r},
                {c: curr.c-1, r: curr.r},
                {c: curr.c, r: curr.r+1},
                {c: curr.c, r: curr.r-1}
            ];
            for (let n of neighbors) {
                if (n.r >= 0 && n.r < rows && n.c >= 0 && n.c < cols) {
                    if (grid[n.r][n.c] === 'green' && !visited[n.r][n.c]) {
                        visited[n.r][n.c] = true;
                        queue.push(n);
                    }
                }
            }
        }
        
        if (!foundHole) continue;
    
    // Prune disconnected islands: any green tile that the flood fill couldn't reach
    // (because an obstacle severed the path) is turned back into a wall.
    for(let r=0; r<rows; r++) {
        for(let c=0; c<cols; c++) {
            if (grid[r][c] === 'green' && !visited[r][c]) {
                grid[r][c] = 'wall';
            }
        }
    }
    
    // Prune dead-end stubs caused by wall drops
    let pruned = true;
    while(pruned) {
        pruned = false;
        for(let r=1; r<rows-1; r++) {
            for(let c=1; c<cols-1; c++) {
                if (grid[r][c] === 'green') {
                    // protect center of start and hole
                    let distToStart = Math.hypot(c - startC, r - startR);
                    let distToHole = Math.hypot(c - endArea.c, r - endArea.r);
                    if (distToStart < 2 || distToHole < 2) continue; 
                    
                    let neighbors = 0;
                    if (grid[r-1][c] === 'green') neighbors++;
                    if (grid[r+1][c] === 'green') neighbors++;
                    if (grid[r][c-1] === 'green') neighbors++;
                    if (grid[r][c+1] === 'green') neighbors++;
                    
                    if (neighbors <= 1) {
                        grid[r][c] = 'wall';
                        pruned = true;
                    }
                }
            }
        }
    }
    
    // Accurate BFS to find shortest playable path for precise Par calculation
    let distGrid = Array(rows).fill(null).map(() => Array(cols).fill(-1));
    let pq = [{c: startC, r: startR, d: 0}];
    distGrid[startR][startC] = 0;
        let shortestPath = 0;
        while(pq.length > 0) {
            let curr = pq.shift();
            if (curr.c === endArea.c && curr.r === endArea.r) {
                shortestPath = curr.d;
                break;
            }
            let ns = [
                {c: curr.c+1, r: curr.r},
                {c: curr.c-1, r: curr.r},
                {c: curr.c, r: curr.r+1},
                {c: curr.c, r: curr.r-1}
            ];
            for (let n of ns) {
                if (n.r >= 0 && n.r < rows && n.c >= 0 && n.c < cols) {
                    if (grid[n.r][n.c] === 'green' && distGrid[n.r][n.c] === -1) {
                        distGrid[n.r][n.c] = curr.d + 1;
                        pq.push({c: n.c, r: n.r, d: curr.d + 1});
                    }
                }
            }
        }
        
        if (shortestPath >= 25) {
            bestLevel = {grid, startC, startR, hx, hy, shortestPath};
            break; // Target hit!
        } else if (shortestPath > maxPathFound) {
            maxPathFound = shortestPath;
            bestLevel = {grid, startC, startR, hx, hy, shortestPath};
        }
    } // end while(attempts)
    
    // Apply best level
    let grid = bestLevel.grid;
    let shortestPath = bestLevel.shortestPath;
    hole.x = bestLevel.hx;
    hole.y = bestLevel.hy;
    
    for(let p of players) {
        p.ball.x = bestLevel.startC * TILE_SIZE + TILE_SIZE/2;
        p.ball.y = bestLevel.startR * TILE_SIZE + TILE_SIZE/2;
        p.ball.vx = 0; p.ball.vy = 0;
    }
    
    // Calculate Par based on ACTUAL playable distance
    if (shortestPath < 12) currentPar = 2;
    else if (shortestPath < 20) currentPar = 3;
    else if (shortestPath < 28) currentPar = 4;
    else currentPar = 5;
    holePars[currentHole - 1] = currentPar;
    
    buildCourseGeometry(grid);
    
    if (isMultiplayer && isHost) {
        let idx = 1;
        for (let c of connections) {
            c.send({
                type: 'MAP_DATA',
                grid: grid,
                startC: bestLevel.startC,
                startR: bestLevel.startR,
                hx: hole.x,
                hy: hole.y,
                holePars: holePars,
                currentPar: currentPar,
                currentHole: currentHole,
                numPlayers: numPlayers,
                yourPlayerIndex: idx
            });
            idx++;
        }
    }
}

function getScaledCoords(e) {
    let rect = canvas.getBoundingClientRect();
    let scaleX = canvas.width / rect.width;
    let scaleY = canvas.height / rect.height;
    
    let clientX = e.clientX;
    let clientY = e.clientY;
    
    if (e.touches && e.touches.length > 0) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
    } else if (e.changedTouches && e.changedTouches.length > 0) {
        clientX = e.changedTouches[0].clientX;
        clientY = e.changedTouches[0].clientY;
    }
    
    return {
        x: (clientX - rect.left) * scaleX,
        y: (clientY - rect.top) * scaleY
    };
}

window.addEventListener('mousedown', (e) => {
    if (gameState !== 'PLAYING') return;
    if (isMultiplayer && currentPlayer !== localPlayerIndex) return; // Not your turn!
    
    let coords = getScaledCoords(e);
    dragStart.x = coords.x;
    dragStart.y = coords.y;
    dragCurrent.x = coords.x;
    dragCurrent.y = coords.y;
    
    isDragging = true;
    gameState = 'AIMING';
});

window.addEventListener('mousemove', (e) => {
    if (isDragging) {
        let coords = getScaledCoords(e);
        
        let dx = dragStart.x - coords.x;
        let dy = dragStart.y - coords.y;
        let dist = Math.hypot(dx, dy);
        let MAX_DRAG = 100;
        
        if (dist > MAX_DRAG) {
            dx = (dx / dist) * MAX_DRAG;
            dy = (dy / dist) * MAX_DRAG;
            dragCurrent.x = dragStart.x - dx;
            dragCurrent.y = dragStart.y - dy;
        } else {
            dragCurrent.x = coords.x;
            dragCurrent.y = coords.y;
        }
    }
});

window.addEventListener('mouseup', (e) => {
    if (!isDragging) return;
    isDragging = false;
    
    if (gameState !== 'AIMING') return;
    if (isMultiplayer && currentPlayer !== localPlayerIndex) return;
    
    let dx = dragStart.x - dragCurrent.x;
    let dy = dragStart.y - dragCurrent.y;
    
    let powerScale = 0.15;
    let powerX = dx * powerScale;
    let powerY = dy * powerScale;
    
    let powerDist = Math.hypot(powerX, powerY);
    if (powerDist > MAX_POWER) {
        powerX = (powerX / powerDist) * MAX_POWER;
        powerY = (powerY / powerDist) * MAX_POWER;
    }
    
    if (powerDist > 0.5) {
        playSoundHit();
        let p = players[currentPlayer];
        p.lastPosition.x = p.ball.x;
        p.lastPosition.y = p.ball.y;
        p.ball.vx = powerX;
        p.ball.vy = powerY;
        p.strokes++;
        
        if (isMultiplayer) {
            sendNetworkData({
                type: 'SHOT',
                player: currentPlayer,
                vx: p.ball.vx,
                vy: p.ball.vy
            });
        }
        
        updateUI();
        gameState = 'ROLLING';
    } else {
        gameState = 'PLAYING';
    }
});

window.addEventListener('touchstart', (e) => {
    if (gameState !== 'PLAYING') return;
    if (isMultiplayer && currentPlayer !== localPlayerIndex) return;
    
    let coords = getScaledCoords(e.touches[0]);
    dragStart.x = coords.x;
    dragStart.y = coords.y;
    dragCurrent.x = coords.x;
    dragCurrent.y = coords.y;
    
    isDragging = true;
    gameState = 'AIMING';
}, {passive: false});

window.addEventListener('touchmove', (e) => {
    if (isDragging) {
        if (e.cancelable) e.preventDefault();
        let coords = getScaledCoords(e.touches[0]);
        
        let dx = dragStart.x - coords.x;
        let dy = dragStart.y - coords.y;
        
        if (Math.hypot(dx, dy) > 200) {
            let angle = Math.atan2(dy, dx);
            dragCurrent.x = dragStart.x - Math.cos(angle) * 200;
            dragCurrent.y = dragStart.y - Math.sin(angle) * 200;
        } else {
            dragCurrent.x = coords.x;
            dragCurrent.y = coords.y;
        }
    }
}, {passive: false});

window.addEventListener('touchend', (e) => {
    if (!isDragging) return;
    isDragging = false;
    
    if (gameState !== 'AIMING') return;
    if (isMultiplayer && currentPlayer !== localPlayerIndex) return;
    
    let dx = dragStart.x - dragCurrent.x;
    let dy = dragStart.y - dragCurrent.y;
    
    let powerScale = 0.15;
    let powerX = dx * powerScale;
    let powerY = dy * powerScale;
    
    let powerDist = Math.hypot(powerX, powerY);
    if (powerDist > MAX_POWER) {
        powerX = (powerX / powerDist) * MAX_POWER;
        powerY = (powerY / powerDist) * MAX_POWER;
    }
    
    if (powerDist > 0.5) {
        playSoundHit();
        let p = players[currentPlayer];
        p.lastPosition.x = p.ball.x;
        p.lastPosition.y = p.ball.y;
        p.ball.vx = powerX;
        p.ball.vy = powerY;
        p.strokes++;
        
        if (isMultiplayer) {
            sendNetworkData({
                type: 'SHOT',
                player: currentPlayer,
                vx: p.ball.vx,
                vy: p.ball.vy
            });
        }
        
        updateUI();
        gameState = 'ROLLING';
    } else {
        gameState = 'PLAYING';
    }
});

function nextTurn() {
    let allHoled = players.every(p => p.holed);
    if (allHoled) {
        gameState = 'HOLED';
        setTimeout(showLevelComplete, 800);
        return;
    }
    
    do {
        currentPlayer = (currentPlayer + 1) % numPlayers;
    } while (players[currentPlayer].holed);
    
    gameState = 'PLAYING';
    updateUI();
}

function updatePhysics() {
    if (gameState !== 'ROLLING') return;

    let p = players[currentPlayer];
    let ball = p.ball;

    ball.vx *= FRICTION;
    ball.vy *= FRICTION;

    let speed = Math.hypot(ball.vx, ball.vy);

    // Stop if slow
    if (speed < 0.1) {
        ball.vx = 0;
        ball.vy = 0;
        
        if (isMultiplayer && currentPlayer === localPlayerIndex) {
            sendNetworkData({
                type: 'SYNC',
                player: currentPlayer,
                x: ball.x,
                y: ball.y,
                strokes: p.strokes,
                holed: p.holed
            });
        }
        nextTurn();
        return;
    }

    // Check hole
    let distToHole = Math.hypot(ball.x - hole.x, ball.y - hole.y);
    if (distToHole < HOLE_RADIUS + BALL_RADIUS) {
        if (speed < 6) { 
            ball.x = hole.x;
            ball.y = hole.y;
            ball.vx = 0;
            ball.vy = 0;
            p.holed = true;
            playSoundHole();
            
            if (isMultiplayer && currentPlayer === localPlayerIndex) {
                sendNetworkData({
                    type: 'SYNC',
                    player: currentPlayer,
                    x: ball.x,
                    y: ball.y,
                    strokes: p.strokes,
                    holed: p.holed
                });
            }
            nextTurn();
            return;
        }
    }

    // Move X
    ball.x += ball.vx;
    for (let w of walls) {
        let bw = BALL_RADIUS;
        let bh = BALL_RADIUS;
        if (ball.x + bw > w.x && ball.x - bw < w.x + w.w && 
            ball.y + bh > w.y && ball.y - bh < w.y + w.h) {
            
            if (ball.vx > 0) {
                ball.x = w.x - bw;
            } else {
                ball.x = w.x + w.w + bw;
            }
            if (Math.abs(ball.vx) > 0.5) playSoundBounce();
            ball.vx *= -0.8;
        }
    }

    // Move Y
    ball.y += ball.vy;
    for (let w of walls) {
        let bw = BALL_RADIUS;
        let bh = BALL_RADIUS;
        if (ball.x + bw > w.x && ball.x - bw < w.x + w.w && 
            ball.y + bh > w.y && ball.y - bh < w.y + w.h) {
            
            if (ball.vy > 0) {
                ball.y = w.y - bh;
            } else {
                ball.y = w.y + w.h + bh;
            }
            if (Math.abs(ball.vy) > 0.5) playSoundBounce();
            ball.vy *= -0.8;
        }
    }
}

function updateUI() {
    uiHoleInfo.textContent = `Hole: ${currentHole}/${totalHoles} (Par ${currentPar})`;
    
    let p = players[currentPlayer];
    if (p) {
        uiScoreInfo.textContent = `P${currentPlayer+1} Strokes: ${p.strokes}`;
        uiScoreInfo.style.color = p.color;
        uiTotalScore.textContent = `Total: ${p.totalScore}`;
        uiTotalScore.style.color = p.color;
    }
}

function getParString(score, par) {
    let diff = score - par;
    if (diff > 0) return `(+${diff})`;
    if (diff < 0) return `(${diff})`;
    return `(Even Par)`;
}

function showLevelComplete() {
    players.forEach(p => {
        p.holeScores[currentHole - 1] = p.strokes;
        p.totalScore += p.strokes;
    });
    updateUI();
    
    let frontParOut = holePars.slice(0, 9).reduce((a, b) => a + b, 0);
    let scorecardHTML = `
        <table class="unified-scorecard">
            <tr>
                <th>Hole</th>
                ${[1,2,3,4,5,6,7,8,9].map(h => `<th>${h}</th>`).join('')}
                <th>Out</th>
            </tr>
            <tr>
                <td style="color: #f1c40f">Par</td>
                ${holePars.slice(0, 9).map(p => `<td>${p}</td>`).join('')}
                <td>${frontParOut}</td>
            </tr>
    `;
    players.forEach((p, index) => {
        let frontTotal = p.holeScores.slice(0, 9).reduce((a, b) => a + (b === '-' ? 0 : b), 0);
        scorecardHTML += `<tr>
            <td style="color: ${p.color}">P${index+1}</td>
            ${p.holeScores.slice(0, 9).map(s => `<td>${s}</td>`).join('')}
            <td>${frontTotal}</td>
        </tr>`;
    });
    scorecardHTML += `</table>`;

    if (currentHole > 9 || gameState === 'GAMEOVER') {
        let backParIn = holePars.slice(9, 18).reduce((a, b) => a + b, 0);
        let totalPar = frontParOut + backParIn;
        scorecardHTML += `
            <table class="unified-scorecard" style="margin-top: 10px;">
                <tr>
                    <th>Hole</th>
                    ${[10,11,12,13,14,15,16,17,18].map(h => `<th>${h}</th>`).join('')}
                    <th>In</th>
                    <th>Tot</th>
                </tr>
                <tr>
                    <td style="color: #f1c40f">Par</td>
                    ${holePars.slice(9, 18).map(p => `<td>${p}</td>`).join('')}
                    <td>${backParIn}</td>
                    <td>${totalPar}</td>
                </tr>
        `;
        players.forEach((p, index) => {
            let backTotal = p.holeScores.slice(9, 18).reduce((a, b) => a + (b === '-' ? 0 : b), 0);
            let frontTotal = p.holeScores.slice(0, 9).reduce((a, b) => a + (b === '-' ? 0 : b), 0);
            let grandTotal = frontTotal + backTotal;
            scorecardHTML += `<tr>
                <td style="color: ${p.color}">P${index+1}</td>
                ${p.holeScores.slice(9, 18).map(s => `<td>${s}</td>`).join('')}
                <td>${backTotal}</td>
                <td>${grandTotal}</td>
            </tr>`;
        });
        scorecardHTML += `</table>`;
    }
    document.getElementById('scorecard').innerHTML = scorecardHTML;
    
    if (currentHole >= totalHoles) {
        let totalPar = holePars.reduce((a, b) => a + b, 0);
        if (numPlayers > 1) {
            let minScore = Math.min(...players.map(p => p.totalScore));
            let winners = players.map((p, index) => ({ p, index })).filter(w => w.p.totalScore === minScore);
            
            if (winners.length === 1) {
                messageTitle.textContent = `Player ${winners[0].index + 1} Wins!`;
                messageTitle.style.color = winners[0].p.color;
            } else {
                messageTitle.textContent = "It's a Tie!";
                messageTitle.style.color = '#f1c40f';
            }
            
            let parString = getParString(minScore, totalPar);
            messageSubtitle.textContent = `Winning Score: ${minScore} ${parString}`;
        } else {
            messageTitle.textContent = "Game Complete!";
            messageTitle.style.color = '#f1c40f';
            
            let parString = getParString(players[0].totalScore, totalPar);
            messageSubtitle.textContent = `Total Strokes: ${players[0].totalScore} ${parString}`;
        }
        nextHoleBtn.textContent = "Play Again";
        gameState = 'GAMEOVER';
    } else {
        messageTitle.textContent = `Hole ${currentHole} Complete!`;
        messageTitle.style.color = '#f1c40f';
        messageSubtitle.textContent = ``;
        nextHoleBtn.textContent = "Next Hole";
    }
    
    document.getElementById('message-overlay').classList.remove('hidden');
}

document.getElementById('next-hole-btn').addEventListener('click', () => {
    if (gameState === 'GAMEOVER') {
        document.getElementById('message-overlay').classList.add('hidden');
        document.getElementById('title-screen').classList.remove('hidden');
        return;
    }
    
    if (isMultiplayer) {
        document.getElementById('next-hole-btn').innerText = "Waiting for others...";
        document.getElementById('next-hole-btn').disabled = true;
        
        if (isHost) {
            readyPlayers++;
            checkAllPlayersReady();
        } else {
            sendNetworkData({ type: 'READY_NEXT_HOLE' });
        }
    } else {
        document.getElementById('message-overlay').classList.add('hidden');
        currentHole++;
        startHole();
    }
});

function draw() {
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    
    for(let w of walls) {
        ctx.fillStyle = COLOR_WALL;
        ctx.fillRect(w.x, w.y, w.w, w.h);
        ctx.fillStyle = COLOR_WALL_TOP;
        ctx.fillRect(w.x, w.y, w.w, 4);
    }
    
    for(let g of greenZones) {
        ctx.fillStyle = g.pattern;
        ctx.fillRect(g.x, g.y, g.w, g.h);
    }
    
    // Draw Bumper Lip
    ctx.strokeStyle = '#D2B48C'; // Light wood / tan color for lip
    ctx.lineWidth = 6;
    ctx.lineCap = 'square';
    ctx.beginPath();
    for(let b of borders) {
        ctx.moveTo(b.x1, b.y1);
        ctx.lineTo(b.x2, b.y2);
    }
    ctx.stroke();
    
    ctx.fillStyle = COLOR_HOLE;
    ctx.beginPath();
    ctx.arc(hole.x, hole.y, HOLE_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    
    // Draw Balls (inactive first, descending order so lower player numbers are on top of the inactive pile)
    for(let i=numPlayers-1; i>=0; i--) {
        if (i === currentPlayer) continue;
        let p = players[i];
        if (p.holed) continue;
        
        ctx.fillStyle = p.color;
        ctx.fillRect(p.ball.x - BALL_RADIUS, p.ball.y - BALL_RADIUS, BALL_RADIUS*2, BALL_RADIUS*2);
    }
    
    // Draw active player on top
    let activeP = players[currentPlayer];
    if (activeP && !activeP.holed) {
        ctx.fillStyle = activeP.color;
        ctx.fillRect(activeP.ball.x - BALL_RADIUS, activeP.ball.y - BALL_RADIUS, BALL_RADIUS*2, BALL_RADIUS*2);
        
        if (gameState === 'PLAYING' || gameState === 'AIMING') {
            ctx.strokeStyle = COLOR_AIM;
            ctx.lineWidth = 1;
            ctx.strokeRect(activeP.ball.x - BALL_RADIUS - 2, activeP.ball.y - BALL_RADIUS - 2, BALL_RADIUS*2 + 4, BALL_RADIUS*2 + 4);
        }
    }
    
    if (gameState === 'AIMING') {
        let ball = players[currentPlayer].ball;
        let dx = dragStart.x - dragCurrent.x;
        let dy = dragStart.y - dragCurrent.y;
        
        ctx.strokeStyle = COLOR_AIM;
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(ball.x, ball.y);
        ctx.lineTo(ball.x + dx, ball.y + dy);
        ctx.stroke();
        ctx.setLineDash([]);
    }
}

function gameLoop() {
    updatePhysics();
    draw();
    requestAnimationFrame(gameLoop);
}
