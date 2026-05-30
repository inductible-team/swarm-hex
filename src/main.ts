import './style.css';
import { Application, Graphics, Rectangle, Container, AnimatedSprite, Assets, Texture } from 'pixi.js';

const HEX_SIZE = 16;
const COLS = 50;
const ROWS = 30;

// States: 0=Empty, 1=Wax, 3=Brood, 4=Blight
let grid = createGrid();
let nextGrid = createGrid();
let workingBeesGrid = createGrid();
let workProgressGrid = createGrid(); // 0 to 100
let blightProgressGrid = createGrid(); // 0 to 100
let nextBlightProgressGrid = createGrid();
let broodProgressGrid = createGrid(); // 0 to 100

let score = 0;
let globalBroodCount = 0;
let gameState: 'PLAYING' | 'GAME_OVER' | 'GAME_WON' = 'PLAYING';

let beeFrames: Texture[] = [];
let beeContainer: Container;

type BeaconType = 'GENERAL' | 'WAX' | 'BROOD' | 'BLIGHT';
interface Beacon {
    x: number;
    y: number;
    life: number;
    type: BeaconType;
}

let beacons: Beacon[] = [];
let selectedBeaconType: BeaconType = 'GENERAL';
let waxCooldown = 0;
let broodCooldown = 0;
let blightCooldown = 0;

const COOLDOWN_MAX = {
    'WAX': 10,
    'BROOD': 15,
    'BLIGHT': 20
};

const BEACON_AOE = HEX_SIZE * 20; // 320px
const BEACON_DEADZONE = HEX_SIZE * 5; // 80px
const BEACON_INTERRUPT = HEX_SIZE * 10; // 160px

const GRID_WIDTH = COLS * Math.sqrt(3) * HEX_SIZE;
const GRID_HEIGHT = ROWS * 1.5 * HEX_SIZE;

function createGrid(): number[][] {
    return new Array(COLS).fill(0).map(() => new Array(ROWS).fill(0));
}

function setupGrid() {
    const cx = Math.floor(COLS / 2);
    const cy = Math.floor(ROWS / 2);
    grid[cx][cy] = 3; // Ensure 1 starting Brood cell

    // Surround it with Wax 1 tile thick
    const dirs = getNeighbors(cx, cy);
    for (const [dq, dr] of dirs) {
        const nq = cx + dq;
        const nr = cy + dr;
        if (nq >= 0 && nq < COLS && nr >= 0 && nr < ROWS) {
            grid[nq][nr] = 1;
        }
    }
}

function getNeighbors(_q: number, r: number) {
    const parity = r & 1;
    return [
        [[+1,  0], [+1, -1], [ 0, -1], [-1,  0], [ 0, +1], [+1, +1]], // even r
        [[+1,  0], [ 0, -1], [-1, -1], [-1,  0], [-1, +1], [ 0, +1]]  // odd r
    ][parity];
}

function countStructuralNeighbors(g: number[][], q: number, r: number): number {
    let sum = 0;
    const dirs = getNeighbors(q, r);
    for (const [dq, dr] of dirs) {
        const nq = q + dq;
        const nr = r + dr;
        if (nq >= 0 && nq < COLS && nr >= 0 && nr < ROWS) {
            if (g[nq][nr] === 1 || g[nq][nr] === 3) sum++;
        }
    }
    return sum;
}

function countState(g: number[][], q: number, r: number, targetState: number): number {
    let sum = 0;
    const dirs = getNeighbors(q, r);
    for (const [dq, dr] of dirs) {
        const nq = q + dq;
        const nr = r + dr;
        if (nq >= 0 && nq < COLS && nr >= 0 && nr < ROWS) {
            if (g[nq][nr] === targetState) sum++;
        }
    }
    return sum;
}

function updateCA() {
    // 1. Random weed spawn (anywhere on map)
    if (Math.random() < 0.2) {
        const q = Math.floor(Math.random() * COLS);
        const r = Math.floor(Math.random() * ROWS);
        if (grid[q][r] === 0) {
            grid[q][r] = 4;
            blightProgressGrid[q][r] = 100; // Spawn mature to kickstart spreading immediately
        }
    }

    // Pass 1: Decay, Growth, and Maturation
    for (let q = 0; q < COLS; q++) {
        for (let r = 0; r < ROWS; r++) {
            let state = grid[q][r];
            let structuralNeighbors = countStructuralNeighbors(grid, q, r);

            nextGrid[q][r] = state;
            nextBlightProgressGrid[q][r] = blightProgressGrid[q][r];

            if (workingBeesGrid[q][r] > 0) continue;

            if (state === 1 || state === 3) {
                if (structuralNeighbors < 2) {
                    nextGrid[q][r] = state === 1 ? 0 : 1; 
                }
            } else if (state === 4) {
                // Maturation (slower)
                nextBlightProgressGrid[q][r] = Math.min(100, blightProgressGrid[q][r] + 5);
                
                // Overcrowding death
                let blightNeighbors = countState(grid, q, r, 4);
                if (blightNeighbors > 4 && Math.random() < 0.05) {
                    nextGrid[q][r] = 0;
                    nextBlightProgressGrid[q][r] = 0;
                }
            }

            // Half-grown blight (infection) on healthy tiles decays if isolated
            if (state !== 4 && nextBlightProgressGrid[q][r] > 0) {
                if (countState(grid, q, r, 4) === 0) {
                    nextBlightProgressGrid[q][r] = Math.max(0, nextBlightProgressGrid[q][r] - 5);
                }
            }
        }
    }

    // Pass 2: Mature Blight Spreading
    for (let q = 0; q < COLS; q++) {
        for (let r = 0; r < ROWS; r++) {
            if (grid[q][r] === 4 && blightProgressGrid[q][r] >= 100) {
                const dirs = getNeighbors(q, r).slice(); 
                
                for (let i = dirs.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [dirs[i], dirs[j]] = [dirs[j], dirs[i]];
                }
                
                for (let i = 0; i < 3; i++) {
                    const [dq, dr] = dirs[i];
                    const nq = q + dq;
                    const nr = r + dr;
                    
                    if (nq >= 0 && nq < COLS && nr >= 0 && nr < ROWS) {
                        if (nextGrid[nq][nr] !== 4 && workingBeesGrid[nq][nr] === 0) {
                            nextBlightProgressGrid[nq][nr] += 5; 
                        }
                    }
                }
            }
        }
    }

    // Pass 3: Resolve Infections
    for (let q = 0; q < COLS; q++) {
        for (let r = 0; r < ROWS; r++) {
            if (nextGrid[q][r] !== 4 && nextBlightProgressGrid[q][r] >= 100) {
                nextGrid[q][r] = 4;
                nextBlightProgressGrid[q][r] = 0;
            }
        }
    }

    let temp = grid;
    grid = nextGrid;
    nextGrid = temp;

    let tempBlight = blightProgressGrid;
    blightProgressGrid = nextBlightProgressGrid;
    nextBlightProgressGrid = tempBlight;
}

function drawHex(g: Graphics, x: number, y: number, size: number) {
    g.moveTo(x + size * Math.cos(Math.PI / 6), y + size * Math.sin(Math.PI / 6));
    for (let i = 1; i <= 6; i++) {
        const angle = Math.PI / 6 + i * Math.PI / 3;
        g.lineTo(x + size * Math.cos(angle), y + size * Math.sin(angle));
    }
}

function pixelToHex(px: number, py: number) {
    const aq = (Math.sqrt(3)/3 * px - 1/3 * py) / HEX_SIZE;
    const ar = (2/3 * py) / HEX_SIZE;
    
    let rq = Math.round(aq);
    let rr = Math.round(ar);
    let rs = Math.round(-aq - ar);
    
    const qDiff = Math.abs(rq - aq);
    const rDiff = Math.abs(rr - ar);
    const sDiff = Math.abs(rs - (-aq - ar));
    
    if (qDiff > rDiff && qDiff > sDiff) rq = -rr - rs;
    else if (rDiff > sDiff) rr = -rq - rs;
    
    const col = rq + (rr - (rr & 1)) / 2;
    const row = rr;
    return { q: col, r: row };
}

function getHexFromPixel(px: number, py: number) {
    const hexWidth = Math.sqrt(3) * HEX_SIZE;
    const hexHeight = 2 * HEX_SIZE;
    return pixelToHex(px - hexWidth / 2, py - hexHeight / 2);
}

function hexToPixel(q: number, r: number) {
    const hexWidth = Math.sqrt(3) * HEX_SIZE;
    const hexHeight = 2 * HEX_SIZE;
    return {
        x: hexWidth * (q + 0.5 * (r & 1)),
        y: hexHeight * (3/4) * r
    };
}

type BeeState = 'WANDERING' | 'SEEKING_JOB' | 'WORKING';

class Bee {
    x: number;
    y: number;
    vx: number;
    vy: number;
    rotation: number;
    speed: number;
    state: BeeState;
    targetQ: number;
    targetR: number;
    targetJobState: number;
    age: number;
    maxAge: number;
    isQueen: boolean;
    sprite: AnimatedSprite;

    constructor(x: number, y: number, isQueen: boolean = false) {
        this.x = x;
        this.y = y;
        this.isQueen = isQueen;
        const angle = Math.random() * Math.PI * 2;
        this.speed = 0.95; 
        if (this.isQueen) this.speed = 0.56; // Queen is majestic and slower
        this.vx = Math.cos(angle) * this.speed;
        this.vy = Math.sin(angle) * this.speed;
        this.rotation = angle;
        this.state = 'WANDERING';
        this.targetQ = -1;
        this.targetR = -1;
        this.targetJobState = -1;
        this.age = 0;
        this.maxAge = this.isQueen ? Infinity : 60 + Math.random() * 30; // 60 to 90 seconds

        this.sprite = new AnimatedSprite(beeFrames);
        this.sprite.anchor.set(0.5);
        this.sprite.animationSpeed = 0.5 + Math.random() * 0.5;
        this.sprite.play();
        if (this.isQueen) {
            this.sprite.scale.set(0.18);
            this.sprite.tint = 0xFF1493;
        } else {
            this.sprite.scale.set(0.16);
        }
        beeContainer.addChild(this.sprite);
    }

    update(delta: number, totalWidth: number, totalHeight: number, bees: Bee[]) {
        this.age += delta / 60; 

        let closestBeacon: Beacon | null = null;
        let distToClosestBeacon = Infinity;

        // Find closest beacon
        if (!this.isQueen) {
            for (const b of beacons) {
                const dist = Math.hypot(b.x - this.x, b.y - this.y);
                if (dist < distToClosestBeacon) {
                    distToClosestBeacon = dist;
                    closestBeacon = b;
                }
            }
        }

        // Beacon Interrupt
        let shouldPursueBeacon = false;
        if (closestBeacon && distToClosestBeacon < BEACON_INTERRUPT && distToClosestBeacon > BEACON_DEADZONE) {
            shouldPursueBeacon = true;
        }

        if (this.state === 'WORKING' || this.state === 'SEEKING_JOB') {
            const cellState = grid[this.targetQ][this.targetR];
            
            let lostAdjacency = false;
            if (this.targetJobState === 0) {
                if (countStructuralNeighbors(grid, this.targetQ, this.targetR) === 0) {
                    lostAdjacency = true;
                }
            } else if (this.targetJobState === 1) {
                if (countStructuralNeighbors(grid, this.targetQ, this.targetR) < 6) {
                    lostAdjacency = true;
                }
            }

            // Abort if the job is gone (cell state changed from what we targeted), OR if interrupted by beacon, OR lost valid neighbors
            if (shouldPursueBeacon || cellState !== this.targetJobState || lostAdjacency) {
                workingBeesGrid[this.targetQ][this.targetR]--;
                this.state = 'WANDERING';
            }
        }

        if (this.state === 'WORKING') {
            const cellState = grid[this.targetQ][this.targetR];
            let progressSpeed = 1.5; // Default fallback
            if (cellState === 1) progressSpeed = 0.25; // Brood Production: Slowest (Takes twice as long)
            else if (cellState === 0) progressSpeed = 0.75; // Wax Production: Medium (Takes twice as long)
            else if (cellState === 4) progressSpeed = 4.0; // Blight Removal: Fastest
            else if (cellState === 3 && this.isQueen) progressSpeed = 3.0; // Queen laying egg: Fast

            workProgressGrid[this.targetQ][this.targetR] += delta * progressSpeed;
            
            // Blight exposure accelerates aging by 4x
            if (cellState === 4) {
                this.age += (delta / 60) * 3;
            }

            // Complete work
            if (workProgressGrid[this.targetQ][this.targetR] >= 100) {
                if (cellState === 4) { // Blight -> Empty
                    grid[this.targetQ][this.targetR] = 0;
                    blightProgressGrid[this.targetQ][this.targetR] = 0; 
                } else if (cellState === 0) { // Empty -> Wax
                    grid[this.targetQ][this.targetR] = 1;
                    blightProgressGrid[this.targetQ][this.targetR] = 0; 
                } else if (cellState === 1) { // Wax -> Brood
                    grid[this.targetQ][this.targetR] = 3;
                    blightProgressGrid[this.targetQ][this.targetR] = 0; 
                    broodProgressGrid[this.targetQ][this.targetR] = 0; // 0 means Prepared but Empty!
                    score += 50;
                    
                    // Cleanse and fortify neighbors
                    const dirs = getNeighbors(this.targetQ, this.targetR);
                    for (const [dq, dr] of dirs) {
                        const nq = this.targetQ + dq;
                        const nr = this.targetR + dr;
                        if (nq >= 0 && nq < COLS && nr >= 0 && nr < ROWS) {
                            if (grid[nq][nr] !== 3) {
                                grid[nq][nr] = 1;
                                blightProgressGrid[nq][nr] = 0; 
                            }
                        }
                    }
                } else if (cellState === 3 && this.isQueen) { // Queen laid an egg
                    broodProgressGrid[this.targetQ][this.targetR] = 0.01; // Start incubation!
                }
                workProgressGrid[this.targetQ][this.targetR] = 0;
                workingBeesGrid[this.targetQ][this.targetR]--;
                this.state = 'WANDERING';
            }
            return; // Working bees don't move
        }

        const hexWidth = Math.sqrt(3) * HEX_SIZE;
        const hexHeight = 2 * HEX_SIZE;

        if (this.state === 'SEEKING_JOB') {
            const tPos = hexToPixel(this.targetQ, this.targetR);
            const tx = tPos.x + hexWidth / 2;
            const ty = tPos.y + hexHeight / 2;

            const dx = tx - this.x;
            const dy = ty - this.y;
            const dist = Math.hypot(dx, dy);

            // Park when close enough to the tile, but scatter slightly
            if (dist < HEX_SIZE * 1.2) {
                this.state = 'WORKING';
                this.vx = 0;
                this.vy = 0;
                return;
            } else {
                this.vx = (dx / dist) * this.speed;
                this.vy = (dy / dist) * this.speed;
            }
        } else if (this.state === 'WANDERING') {
            // Job Scanning
            let bq = -1, br = -1; // Blight
            let hq = -1, hr = -1; // Brooding
            let wq = -1, wr = -1; // Waxing

            // Only scan for jobs if we aren't actively pursuing an interrupting beacon
            if (!shouldPursueBeacon) {
                const hex = getHexFromPixel(this.x, this.y);
                if (hex.q >= 0 && hex.q < COLS && hex.r >= 0 && hex.r < ROWS) {
                    const scanTiles = [{q: hex.q, r: hex.r}];
                    for (const [dq, dr] of getNeighbors(hex.q, hex.r)) {
                        const nq = hex.q + dq;
                        const nr = hex.r + dr;
                        if (nq >= 0 && nq < COLS && nr >= 0 && nr < ROWS) {
                            scanTiles.push({q: nq, r: nr}); 
                        }
                    }

                    // Shuffle scan tiles to prevent directional bias
                    for (let i = scanTiles.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        [scanTiles[i], scanTiles[j]] = [scanTiles[j], scanTiles[i]];
                    }

                    for (const tile of scanTiles) {
                        const q = tile.q;
                        const r = tile.r;

                        if (workingBeesGrid[q][r] >= 6) continue;

                        const state = grid[q][r];
                        
                        if (this.isQueen) {
                            // Queen ONLY looks for Prepared (0) Brood (3) cells
                            if (state === 3 && broodProgressGrid[q][r] === 0 && workingBeesGrid[q][r] <= 0 && hq === -1) {
                                hq = q; hr = r;
                            }
                        } else {
                            if (state === 4 && bq === -1) {
                                bq = q; br = r;
                            } else if (state === 1 && hq === -1) {
                                // Check if eligible for Brood (surrounded by 6 structure, and adjacent to existing Brood)
                                if (countStructuralNeighbors(grid, q, r) === 6) {
                                    // Must be adjacent to existing Brood, OR be the very first one
                                    if ((countState(grid, q, r, 3) > 0 || globalBroodCount === 0) && broodProgressGrid[q][r] >= 0) {
                                        hq = q; hr = r;
                                    }
                                }
                            } else if (state === 0 && wq === -1) {
                                if (countStructuralNeighbors(grid, q, r) > 0) {
                                    wq = q; wr = r;
                                }
                            }
                        }
                    }
                }
            }

            let priorityOrder = [4, 1, 0]; // Default: Blight, Brood, Wax
            if (closestBeacon && distToClosestBeacon < BEACON_AOE) {
                if (closestBeacon.type === 'WAX') priorityOrder = [0, 4, 1];
                else if (closestBeacon.type === 'BROOD') priorityOrder = [1, 4, 0];
                else if (closestBeacon.type === 'BLIGHT') priorityOrder = [4, 1, 0]; // Same but strictly enforced by AOE
            }

            let assigned = false;
            for (const p of priorityOrder) {
                if (p === 4 && bq !== -1) {
                    this.targetQ = bq; this.targetR = br; this.state = 'SEEKING_JOB';
                    this.targetJobState = grid[bq][br];
                    workingBeesGrid[bq][br]++; 
                    assigned = true;
                    break;
                } else if (p === 1 && hq !== -1) {
                    this.targetQ = hq; this.targetR = hr; this.state = 'SEEKING_JOB';
                    this.targetJobState = grid[hq][hr];
                    workingBeesGrid[hq][hr]++; 
                    assigned = true;
                    break;
                } else if (p === 0 && wq !== -1) {
                    this.targetQ = wq; this.targetR = wr; this.state = 'SEEKING_JOB';
                    this.targetJobState = grid[wq][wr];
                    workingBeesGrid[wq][wr]++; 
                    assigned = true;
                    break;
                }
            }

            if (!assigned) {
                this.vx += (Math.random() - 0.5) * 1.0;
                this.vy += (Math.random() - 0.5) * 1.0;

                // Beacon bias: only pulls wandering bees within a maximum radius
                if (closestBeacon && distToClosestBeacon > BEACON_DEADZONE && distToClosestBeacon < BEACON_AOE) {  
                    const pullStrength = 0.15;
                    this.vx += ((closestBeacon.x - this.x) / distToClosestBeacon) * pullStrength;
                    this.vy += ((closestBeacon.y - this.y) / distToClosestBeacon) * pullStrength;
                }

                // Queen bias: pull towards nearest empty Brood cell
                if (this.isQueen) {
                    let closestDist = Infinity;
                    let targetX = -1;
                    let targetY = -1;
                    for (let q = 0; q < COLS; q++) {
                        for (let r = 0; r < ROWS; r++) {
                            if (grid[q][r] === 3 && broodProgressGrid[q][r] === 0 && workingBeesGrid[q][r] <= 0) {
                                const pos = hexToPixel(q, r);
                                const cx = pos.x + (Math.sqrt(3) * HEX_SIZE) / 2;
                                const cy = pos.y + HEX_SIZE;
                                const dist = Math.hypot(cx - this.x, cy - this.y);
                                if (dist < closestDist) {
                                    closestDist = dist;
                                    targetX = cx;
                                    targetY = cy;
                                }
                            }
                        }
                    }
                    if (targetX !== -1 && closestDist > 0) {
                        const pullStrength = 0.2; // Stronger pull to ensure she finds it
                        this.vx += ((targetX - this.x) / closestDist) * pullStrength;
                        this.vy += ((targetY - this.y) / closestDist) * pullStrength;
                    }
                }
            }
        }

        // Boids Separation: Avoid stacking up perfectly
        let sepX = 0, sepY = 0, sepCount = 0;
        for (const other of bees) {
            if (other === this) continue;
            let dx = this.x - other.x;
            let dy = this.y - other.y;
            let distSq = dx * dx + dy * dy;
            const avoidRadius = HEX_SIZE * 0.4; 
            if (distSq < avoidRadius * avoidRadius) {
                if (distSq < 0.0001) { // Perfect stack! Random nudge
                    dx = (Math.random() - 0.5) * 0.1;
                    dy = (Math.random() - 0.5) * 0.1;
                    distSq = dx * dx + dy * dy;
                }
                const dist = Math.sqrt(distSq);
                sepX += (dx / dist) * (avoidRadius - dist);
                sepY += (dy / dist) * (avoidRadius - dist);
                sepCount++;
            }
        }

        if (sepCount > 0) {
            const sepLen = Math.hypot(sepX, sepY);
            if (sepLen > 0) {
                const biasStrength = 0.05; // Weak bias instead of a hard block
                this.vx += (sepX / sepLen) * biasStrength;
                this.vy += (sepY / sepLen) * biasStrength;
            }
        }

        const speed = Math.hypot(this.vx, this.vy);
        if (speed > this.speed) {
            this.vx = (this.vx / speed) * this.speed;
            this.vy = (this.vy / speed) * this.speed;
        }

        this.x += this.vx * delta;
        this.y += this.vy * delta;

        if (this.x < 0) this.x += totalWidth;
        if (this.x >= totalWidth) this.x -= totalWidth;
        if (this.y < 0) this.y += totalHeight;
        if (this.y >= totalHeight) this.y -= totalHeight;
    }
}

async function init() {
    const app = new Application();
    
    const hexWidth = Math.sqrt(3) * HEX_SIZE;
    const hexHeight = 2 * HEX_SIZE;
    const totalWidth = hexWidth * COLS + (hexWidth / 2);
    const totalHeight = (hexHeight * 3 / 4) * ROWS + (hexHeight / 4);

    await app.init({
        width: totalWidth,
        height: totalHeight,
        backgroundColor: 0x111111,
        antialias: true,
        resolution: window.devicePixelRatio || 1,
    });

    const appContainer = document.getElementById('app');
    if (appContainer) {
        appContainer.innerHTML = '';
        appContainer.appendChild(app.canvas);
    }

    const sheet = await Assets.load('/atlas.png.json');
    beeFrames = sheet.animations.b;

    setupGrid();

    const world = new Container();
    app.stage.addChild(world);

    const graphics = new Graphics();
    world.addChild(graphics);

    beeContainer = new Container();
    world.addChild(beeContainer);

    const btnGeneral = document.getElementById('btn-general') as HTMLButtonElement;
    const btnWax = document.getElementById('btn-wax') as HTMLButtonElement;
    const btnBrood = document.getElementById('btn-brood') as HTMLButtonElement;
    const btnBlight = document.getElementById('btn-blight') as HTMLButtonElement;

    function selectBeacon(type: BeaconType) {
        selectedBeaconType = type;
        btnGeneral.classList.remove('active');
        btnWax.classList.remove('active');
        btnBrood.classList.remove('active');
        btnBlight.classList.remove('active');

        if (type === 'GENERAL') btnGeneral.classList.add('active');
        if (type === 'WAX') btnWax.classList.add('active');
        if (type === 'BROOD') btnBrood.classList.add('active');
        if (type === 'BLIGHT') btnBlight.classList.add('active');
    }

    btnGeneral.addEventListener('click', () => selectBeacon('GENERAL'));
    btnWax.addEventListener('click', () => selectBeacon('WAX'));
    btnBrood.addEventListener('click', () => selectBeacon('BROOD'));
    btnBlight.addEventListener('click', () => selectBeacon('BLIGHT'));

    app.stage.eventMode = 'static';
    app.stage.hitArea = new Rectangle(0, 0, app.screen.width, app.screen.height);
    app.stage.on('pointerdown', (e) => {
        if (gameState !== 'PLAYING') return;
        
        const localPos = graphics.toLocal(e.global);
        
        if (gameState !== 'PLAYING') return;
        
        // Check cooldown
        if (selectedBeaconType === 'WAX' && waxCooldown > 0) return;
        if (selectedBeaconType === 'BROOD' && broodCooldown > 0) return;
        if (selectedBeaconType === 'BLIGHT' && blightCooldown > 0) return;

        // Apply cooldown
        if (selectedBeaconType === 'WAX') waxCooldown = COOLDOWN_MAX.WAX;
        if (selectedBeaconType === 'BROOD') broodCooldown = COOLDOWN_MAX.BROOD;
        if (selectedBeaconType === 'BLIGHT') blightCooldown = COOLDOWN_MAX.BLIGHT;

        // Remove any existing beacon of the same type
        for (let i = beacons.length - 1; i >= 0; i--) {
            if (beacons[i].type === selectedBeaconType) {
                beacons.splice(i, 1);
            }
        }
        beacons.push({ x: localPos.x, y: localPos.y, life: 100, type: selectedBeaconType });
        selectBeacon('GENERAL'); // Auto-revert to general
    });

    const bees: Bee[] = [];
    bees.push(new Bee(GRID_WIDTH / 2, GRID_HEIGHT / 2, true)); // 1 Queen
    for (let i = 0; i < 3; i++) {
        bees.push(new Bee(GRID_WIDTH / 2 + (Math.random() - 0.5) * 50, GRID_HEIGHT / 2 + (Math.random() - 0.5) * 50, false));
    }

    const beeCountEl = document.getElementById('beeCountVal');
    const completionEl = document.getElementById('completionVal');

    document.getElementById('restartBtn')!.addEventListener('click', () => {
        document.getElementById('game-over')!.style.display = 'none';
        resetGame();
    });

    document.getElementById('replayBtn')!.addEventListener('click', () => {
        document.getElementById('game-won')!.style.display = 'none';
        resetGame();
    });

    function resetGame() {
        for (const bee of bees) bee.sprite.destroy();
        grid = createGrid();
        nextGrid = createGrid();
        workingBeesGrid = createGrid();
        workProgressGrid = createGrid();
        blightProgressGrid = createGrid();
        nextBlightProgressGrid = createGrid();
        broodProgressGrid = createGrid();
        beacons.length = 0;
        setupGrid();
        score = 0;
        waxCooldown = 0;
        broodCooldown = 0;
        blightCooldown = 0;
        beacons.length = 0;
        selectBeacon('GENERAL');
        bees.length = 0; 
        bees.push(new Bee(GRID_WIDTH / 2, GRID_HEIGHT / 2, true));
        for (let i = 0; i < 3; i++) {
            bees.push(new Bee(GRID_WIDTH / 2, GRID_HEIGHT / 2, false));
        }
        gameState = 'PLAYING';
    }

    let caTime = 0;
    const CA_INTERVAL = 300; 

    app.ticker.speed = 0.75; 

    app.ticker.add((ticker) => {
        if (gameState !== 'PLAYING') return;

        // Handle Camera Zoom to fit Grid
        const scaleX = window.innerWidth / GRID_WIDTH;
        const scaleY = window.innerHeight / GRID_HEIGHT;
        const scale = Math.min(scaleX, scaleY) * 0.95; // 5% margin
        world.scale.set(scale);
        world.x = (window.innerWidth - GRID_WIDTH * scale) / 2;
        world.y = (window.innerHeight - GRID_HEIGHT * scale) / 2;

        if (beeCountEl) beeCountEl.innerText = bees.length.toString();
        let currentBroodCount = 0;
        for (let q = 0; q < COLS; q++) {
            for (let r = 0; r < ROWS; r++) {
                if (grid[q][r] === 3) { // Brood
                    currentBroodCount++;
                    score += 0.05 * ticker.deltaTime; // Still generate yield
                    
                    if (broodProgressGrid[q][r] > 0) { // ONLY incubate if Queen laid an egg
                        broodProgressGrid[q][r] += 0.05 * ticker.deltaTime; // Incubation timer
                        
                        if (broodProgressGrid[q][r] >= 100) {
                            // Hatch! Revert to Wax and spawn a bee.
                            grid[q][r] = 1;
                            broodProgressGrid[q][r] = -20; // 6-7 second cooldown before it can be rebuilt into Brood
                            const pos = hexToPixel(q, r);
                            bees.push(new Bee(pos.x + (Math.sqrt(3) * HEX_SIZE) / 2, pos.y + HEX_SIZE, false));
                        }
                    }
                } else if (grid[q][r] === 1 && broodProgressGrid[q][r] < 0) {
                    // Recovering from hatch cooldown
                    broodProgressGrid[q][r] += 0.05 * ticker.deltaTime;
                    if (broodProgressGrid[q][r] > 0) broodProgressGrid[q][r] = 0;
                }
            }
        }
        globalBroodCount = currentBroodCount;

        // Cooldown Timers
        const dtSeconds = ticker.deltaTime / 60;
        if (waxCooldown > 0) waxCooldown = Math.max(0, waxCooldown - dtSeconds);
        if (broodCooldown > 0) broodCooldown = Math.max(0, broodCooldown - dtSeconds);
        if (blightCooldown > 0) blightCooldown = Math.max(0, blightCooldown - dtSeconds);

        const cdWaxEl = document.getElementById('cd-wax');
        const cdBroodEl = document.getElementById('cd-brood');
        const cdBlightEl = document.getElementById('cd-blight');

        if (cdWaxEl) cdWaxEl.innerText = waxCooldown > 0 ? `(${Math.ceil(waxCooldown)}s)` : '';
        if (cdBroodEl) cdBroodEl.innerText = broodCooldown > 0 ? `(${Math.ceil(broodCooldown)}s)` : '';
        if (cdBlightEl) cdBlightEl.innerText = blightCooldown > 0 ? `(${Math.ceil(blightCooldown)}s)` : '';

        btnWax.disabled = waxCooldown > 0;
        btnBrood.disabled = broodCooldown > 0;
        btnBlight.disabled = blightCooldown > 0;

        // Auto revert UI if trying to select a disabled button
        if (selectedBeaconType === 'WAX' && waxCooldown > 0) selectBeacon('GENERAL');
        if (selectedBeaconType === 'BROOD' && broodCooldown > 0) selectBeacon('GENERAL');
        if (selectedBeaconType === 'BLIGHT' && blightCooldown > 0) selectBeacon('GENERAL');

        // Decay beacons
        for (let i = beacons.length - 1; i >= 0; i--) {
            beacons[i].life -= dtSeconds * 10;
            if (beacons[i].life <= 0) {
                beacons.splice(i, 1);
            }
        }

        caTime += ticker.deltaMS;
        if (caTime >= CA_INTERVAL) {
            updateCA();
            caTime = 0;
        }

        for (const bee of bees) {
            bee.update(ticker.deltaTime, GRID_WIDTH, GRID_HEIGHT, bees);
        }
        
        for (let i = bees.length - 1; i >= 0; i--) {
            if (bees[i].age >= bees[i].maxAge) {
                const bee = bees[i];
                if (bee.targetQ !== -1 && bee.targetR !== -1 && (bee.state === 'WORKING' || bee.state === 'SEEKING_JOB')) {
                    if (bee.targetQ >= 0 && bee.targetQ < COLS && bee.targetR >= 0 && bee.targetR < ROWS) {
                        workingBeesGrid[bee.targetQ][bee.targetR] = Math.max(0, workingBeesGrid[bee.targetQ][bee.targetR] - 1);
                    }
                }
                bee.sprite.destroy();
                bees.splice(i, 1);
            }
        }

        graphics.clear();
        
        const offsetX = hexWidth / 2;
        const offsetY = hexHeight / 2;
        let aliveCells = 0;

        for (let q = 0; q < COLS; q++) {
            for (let r = 0; r < ROWS; r++) {
                const state = grid[q][r];
                const infection = blightProgressGrid[q][r];
                const work = workProgressGrid[q][r];
                
                if (state !== 0 || infection > 0 || work > 0) {
                    if (state === 1 || state === 3) aliveCells++;

                    const pos = hexToPixel(q, r);
                    const px = pos.x + offsetX;
                    const py = pos.y + offsetY;
                    
                    if (state === 1) graphics.fill({ color: 0x8B8000 }); 
                    else if (state === 3) graphics.fill({ color: 0xFFD700 }); 
                    else if (state === 4) {
                        graphics.fill({ color: 0x4B0082 }); 
                    }
                    
                    if (state !== 0) {
                        drawHex(graphics, px, py, HEX_SIZE * 0.9);
                        graphics.fill();
                    }

                    if (state === 3) {
                        const broodProg = broodProgressGrid[q][r];
                        if (broodProg > 0) {
                            graphics.fill({ color: 0xFFFFFF, alpha: 0.7 });
                            const scale = 0.2 + (broodProg / 100) * 0.8;
                            drawHex(graphics, px, py, HEX_SIZE * 0.9 * scale);
                            graphics.fill();
                            graphics.fill({ alpha: 1.0 }); 
                        }
                    }

                    if (infection > 0 && state !== 4) {
                        graphics.fill({ color: 0x4B0082, alpha: 0.6 });
                        drawHex(graphics, px, py, HEX_SIZE * 0.9 * (infection / 100));
                        graphics.fill();
                        graphics.fill({ alpha: 1.0 }); 
                    }

                    if (work > 0) {
                        let progressColor = 0xFFFFFF;
                        if (state === 0) progressColor = 0x8B8000;
                        else if (state === 1) progressColor = 0xFFD700;
                        else if (state === 3) progressColor = 0xFF1493; // Queen laying egg
                        else if (state === 4) progressColor = 0x111111;
                        
                        graphics.fill({ color: progressColor, alpha: 0.9 });
                        drawHex(graphics, px, py, HEX_SIZE * 0.9 * (work / 100));
                        graphics.fill();
                        graphics.fill({ alpha: 1.0 });
                    }
                }
            }
        }

        // Draw beacons
        for (const b of beacons) {
            const time = performance.now() * 0.005;
            const pulse = 1 + Math.sin(time) * 0.2;
            const lifeRatio = b.life / 100;
            
            let color = 0x00FFFF; // General
            if (b.type === 'WAX') color = 0xFFD700;
            else if (b.type === 'BROOD') color = 0xFFFFFF;
            else if (b.type === 'BLIGHT') color = 0x8A2BE2;

            // Draw Area of Effect radius
            graphics.circle(b.x, b.y, BEACON_AOE);
            graphics.stroke({ color: color, alpha: 0.1 * lifeRatio, width: 1 });

            // Draw core beacon
            graphics.circle(b.x, b.y, BEACON_DEADZONE * pulse);
            graphics.stroke({ color: color, alpha: 0.5 * lifeRatio, width: 2 });
            graphics.circle(b.x, b.y, 4);
            graphics.fill({ color: color, alpha: lifeRatio });
        }

        for (const bee of bees) {
            const px = bee.x;
            const py = bee.y;
            
            const ageRatio = Math.max(0, bee.age / bee.maxAge);
            let colorHex = 0xFFFFFF;
            
            if (bee.isQueen) {
                colorHex = 0xFF1493; // Deep Pink / Royal Purple
            } else {
                const lifePct = Math.max(0, 1 - ageRatio);
                const rColor = Math.floor(255);
                const gbColor = Math.floor(255 * lifePct);
                colorHex = (rColor << 16) | (gbColor << 8) | gbColor;
                bee.sprite.tint = colorHex;
            }

            let targetAngle = Math.atan2(bee.vy, bee.vx);
            if (bee.state === 'WORKING') {
                const tPos = hexToPixel(bee.targetQ, bee.targetR);
                const cx = tPos.x + (Math.sqrt(3) * HEX_SIZE) / 2;
                const cy = tPos.y + HEX_SIZE;
                targetAngle = Math.atan2(cy - py, cx - px);
            }

            // Smooth rotation interpolation
            let diff = targetAngle - bee.rotation;
            // Normalize diff to -PI to PI
            while (diff < -Math.PI) diff += Math.PI * 2;
            while (diff > Math.PI) diff -= Math.PI * 2;
            
            const interpSpeed = bee.isQueen ? 0.02 : 0.1;
            bee.rotation += diff * interpSpeed;
            
            bee.sprite.x = px;
            bee.sprite.y = py;
            bee.sprite.rotation = bee.rotation + Math.PI / 2;
            
            /*
            if (bee.state === 'WORKING') {
                const tPos = hexToPixel(bee.targetQ, bee.targetR);
                const cx = tPos.x + (Math.sqrt(3) * HEX_SIZE) / 2;
                const cy = tPos.y + HEX_SIZE;
                graphics.moveTo(bee.x, bee.y);
                graphics.lineTo(cx, cy);
                graphics.stroke({ color: colorHex, alpha: 0.4, width: 2 });
            }
            */
        }

        if (completionEl) {
            const pct = Math.floor((aliveCells / (COLS * ROWS)) * 100);
            completionEl.innerText = pct.toString();
        }

        if (aliveCells === 0) {
            gameState = 'GAME_OVER';
            document.getElementById('game-over')!.style.display = 'flex';
        } else if (aliveCells >= COLS * ROWS * 0.9) {
            gameState = 'GAME_WON';
            document.getElementById('game-won')!.style.display = 'flex';
        }
    });
}

init().catch(console.error);
