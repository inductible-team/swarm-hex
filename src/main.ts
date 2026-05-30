import './style.css';
import { Application, Graphics, Rectangle, Container, AnimatedSprite, Assets, Texture, Text } from 'pixi.js';

const HEX_SIZE = 24;
const _hexWidth = Math.sqrt(3) * HEX_SIZE;
let COLS = 30;
const ROWS = 22;

const blightColors = [0xF75590, 0x697A21, 0x2DD881, 0x6FEDB7];
const woodColors = [0x272838, 0x3A2E4D, 0x1F1B2E, 0x4B3C5E];

const COLOR_WAX = 0xFBD87F;
const COLOR_BROOD = 0xEAC435;
const COLOR_WOOD = woodColors[Math.floor(Math.random() * woodColors.length)];
const COLOR_BLIGHT = blightColors[Math.floor(Math.random() * blightColors.length)];
const COLOR_QUEEN_EGG = 0x9395D3;
const COLOR_BLIGHT_REMOVE = 0x111111;

const ENABLE_BLIGHT_PULSE = false; // Toggle for the unsettling pulsing effect

// States: 0=Empty, 1=Wax, 3=Brood, 4=Blight
let grid: number[][] = [];
let nextGrid: number[][] = [];
let workingBeesGrid: number[][] = [];
let workProgressGrid: number[][] = []; // 0 to 100
let blightProgressGrid: number[][] = []; // 0 to 100
let nextBlightProgressGrid: number[][] = [];
let broodProgressGrid: number[][] = []; // 0 to 100
let playableCells = 0;
let playerStartX = 0;
let playerStartY = 0;

let score = 0;
// let globalBroodCount = 0;
let gameState: 'PLAYING' | 'GAME_OVER' | 'GAME_WON' = 'PLAYING';

let beeFrames: Texture[] = [];
let queenFrames: Texture[] = [];
let beeContainer: Container;

type BeaconType = 'MOVE' | 'WAX' | 'BROOD' | 'BLIGHT';
interface Beacon {
    x: number;
    y: number;
    life: number;
    maxLife: number;
    aoeRadius: number;
    type: BeaconType;
}

let beacons: Beacon[] = [];
let chargingBeacon: { x: number; y: number; type: BeaconType; radius: number } | null = null;
let selectedBeaconType: BeaconType = 'MOVE';


const BEACON_DEADZONE = HEX_SIZE * 3; 

let GRID_WIDTH = COLS * Math.sqrt(3) * HEX_SIZE;
const GRID_HEIGHT = ROWS * 1.5 * HEX_SIZE;

function createGrid(): number[][] {
    return new Array(COLS).fill(0).map(() => new Array(ROWS).fill(0));
}

function setupGrid() {
    // 1. Create a solid 3-tile wood border (2 visible, 1 for screen bleed)
    for (let q = 0; q < COLS; q++) {
        for (let r = 0; r < ROWS; r++) {
            if (q < 3 || q >= COLS - 3 || r < 3 || r >= ROWS - 3) {
                grid[q][r] = 5; // Wood
            }
        }
    }

    // Randomize player start, avoiding the 3-tile wood border (buffer of 5)
    const startQ = 5 + Math.floor(Math.random() * (COLS - 10));
    const startR = 5 + Math.floor(Math.random() * (ROWS - 10));
    const startPos = hexToPixel(startQ, startR);
    playerStartX = startPos.x;
    playerStartY = startPos.y;
    
    // Generate Wood Islands (State 5) based on total map size
    const totalCells = COLS * ROWS;
    const numIslands = Math.floor(totalCells / 90) + Math.floor(Math.random() * (totalCells / 120)); 
    for (let i = 0; i < numIslands; i++) {
        let rq = Math.floor(Math.random() * COLS);
        let rr = Math.floor(Math.random() * ROWS);
        
        // Ensure they spawn at least 10 tiles away from the start so players don't start trapped
        while (Math.hypot(rq - startQ, rr - startR) < 10) {
            rq = Math.floor(Math.random() * COLS);
            rr = Math.floor(Math.random() * ROWS);
        }

        // Create a blob-like rock island
        const hexRadius = 1 + Math.random() * 2.5; 
        const pixelRadius = hexRadius * _hexWidth;
        const searchRange = Math.ceil(hexRadius) + 1;
        const centerPos = hexToPixel(rq, rr);

        for (let dq = -searchRange; dq <= searchRange; dq++) {
            for (let dr = -searchRange; dr <= searchRange; dr++) {
                const nq = rq + dq;
                const nr = rr + dr;
                if (nq >= 0 && nq < COLS && nr >= 0 && nr < ROWS) {
                    // Calculate pixel distance to allow true circular growth regardless of hex offset math
                    const nPos = hexToPixel(nq, nr);
                    const dist = Math.hypot(nPos.x - centerPos.x, nPos.y - centerPos.y);
                    
                    // Add noise so the blob is irregular and organic
                    const noisyRadius = pixelRadius * (0.6 + Math.random() * 0.5);
                    if (dist <= noisyRadius) {
                        grid[nq][nr] = 5;
                    }
                }
            }
        }
    }

    // Create initial hive cluster (triangle of 3 cells to satisfy >= 2 neighbor decay rule)
    grid[startQ][startR] = 3; 
    broodProgressGrid[startQ][startR] = 0.01; // Starter egg

    const dirs = getNeighbors(startQ, startR);
    // dirs[0] and dirs[1] are adjacent to each other on a hex grid
    grid[startQ + dirs[0][0]][startR + dirs[0][1]] = 1; 
    grid[startQ + dirs[1][0]][startR + dirs[1][1]] = 1;

    // Calculate playable cells (cells that are not rocks)
    playableCells = 0;
    for (let q = 0; q < COLS; q++) {
        for (let r = 0; r < ROWS; r++) {
            if (grid[q][r] !== 5) {
                playableCells++;
            }
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
            if (g[nq][nr] === 1 || g[nq][nr] === 3 || g[nq][nr] === 5) sum++;
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
    // Count blight cells to enforce 15% cap on random spawns
    let blightCount = 0;
    for (let q = 0; q < COLS; q++) {
        for (let r = 0; r < ROWS; r++) {
            if (grid[q][r] === 4) blightCount++;
        }
    }
    const totalCells = COLS * ROWS;

    // 1. Random weed spawn (anywhere on map) - capped at 20% blight coverage
    if (blightCount / totalCells < 0.20 && Math.random() < 0.07) {
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
                nextBlightProgressGrid[q][r] = Math.min(100, blightProgressGrid[q][r] + 6);
                
                // Mature blight stays alive forever until bees destroy it
                // (Removed overcrowding death)
            }

            // Half-grown blight (infection) on healthy tiles decays if isolated
            if (state !== 4 && nextBlightProgressGrid[q][r] > 0) {
                if (countState(grid, q, r, 4) === 0) {
                    nextBlightProgressGrid[q][r] = Math.max(0, nextBlightProgressGrid[q][r] - 3);
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
                        if (nextGrid[nq][nr] !== 4 && nextGrid[nq][nr] !== 5 && workingBeesGrid[nq][nr] === 0) {
                            let spreadSpeed = 6;
                            if (grid[nq][nr] === 1) spreadSpeed = 3; // Grows slightly slower on Wax cells
                            
                            nextBlightProgressGrid[nq][nr] += spreadSpeed; 
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
                nextBlightProgressGrid[q][r] = 100; // Cap it at 100
                workProgressGrid[q][r] = 0; // Reset any lingering work progress
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
    health: number;
    maxHealth: number;

    constructor(x: number, y: number, isQueen: boolean = false) {
        this.x = x;
        this.y = y;
        this.isQueen = isQueen;
        this.age = 0;
        this.maxAge = this.isQueen ? Infinity : 45 + Math.random() * 10;
        this.health = 100;
        this.maxHealth = 100;
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
        this.maxAge = this.isQueen ? Infinity : 45 + Math.random() * 10; // ~50s (1.5x incubation time)

        this.sprite = new AnimatedSprite(isQueen ? queenFrames : beeFrames);
        this.sprite.anchor.set(0.5);
        this.sprite.animationSpeed = 0.5 + Math.random() * 0.5;
        this.sprite.play();
        if (this.isQueen) {
            this.sprite.scale.set(0.27);
        } else {
            this.sprite.scale.set(0.24);
        }
        beeContainer.addChild(this.sprite);
    }

    update(delta: number, totalWidth: number, totalHeight: number, bees: Bee[]) {
        this.age += delta / 60; 

        // Queen health mechanic
        if (this.isQueen && gameState === 'PLAYING') {
            const h = getHexFromPixel(this.x, this.y);
            if (h.q >= 0 && h.q < COLS && h.r >= 0 && h.r < ROWS) {
                if (grid[h.q][h.r] === 4 && blightProgressGrid[h.q][h.r] >= 100) {
                    this.health -= (delta / 60) * 10; // Dies in ~10 seconds
                    if (this.health <= 0) {
                        gameState = 'GAME_OVER';
                        document.getElementById('game-over')!.style.display = 'flex';
                        document.getElementById('game-over')!.querySelector('h1')!.innerText = 'The Queen is Dead';
                    }
                } else if (this.health < this.maxHealth) {
                    this.health = Math.min(this.maxHealth, this.health + (delta / 60) * 3); // Heal
                }
            }
        }

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

        // Beacon logic
        let shouldMoveToBeacon = false;
        let shouldAbortCurrentJob = false;
        let priorityOrder = [4, 1, 0]; // Default: Blight, Brood, Wax
        if (closestBeacon && !this.isQueen) {
            if (distToClosestBeacon <= BEACON_DEADZONE) {
                // Inner zone: job seeking with strict priority
                if (closestBeacon.type === 'WAX') {
                    priorityOrder = [0];
                    if (this.targetJobState !== 0 && this.targetJobState !== -1) shouldAbortCurrentJob = true;
                } else if (closestBeacon.type === 'BROOD') {
                    priorityOrder = [1];
                    if (this.targetJobState !== 1 && this.targetJobState !== -1) shouldAbortCurrentJob = true;
                } else if (closestBeacon.type === 'BLIGHT') {
                    priorityOrder = [4];
                    if (this.targetJobState !== 4 && this.targetJobState !== -1) shouldAbortCurrentJob = true;
                }
            } else if (distToClosestBeacon <= closestBeacon.aoeRadius) {
                // Outer zone: drop jobs and move directly to beacon
                shouldMoveToBeacon = true;
            }
        }

        if (this.state === 'WORKING' || this.state === 'SEEKING_JOB') {
            const cellState = grid[this.targetQ][this.targetR];
            
            let lostAdjacency = false;
            if (this.targetJobState === 0) {
                if (countStructuralNeighbors(grid, this.targetQ, this.targetR) < 2) {
                    lostAdjacency = true;
                }
            } else if (this.targetJobState === 1) {
                if (countStructuralNeighbors(grid, this.targetQ, this.targetR) < 2) {
                    lostAdjacency = true;
                }
            }

            // Abort if the job is gone, lost neighbors, OR if we need to move/abort for a beacon
            if (shouldMoveToBeacon || shouldAbortCurrentJob || cellState !== this.targetJobState || lostAdjacency) {
                workingBeesGrid[this.targetQ][this.targetR] = Math.max(0, workingBeesGrid[this.targetQ][this.targetR] - 1);
                this.state = 'WANDERING';
                this.targetQ = -1;
                this.targetR = -1;
                this.targetJobState = -1;
            }
        }

        if (this.state === 'WORKING') {
            const cellState = grid[this.targetQ][this.targetR];
            let progressSpeed = 1.5; // Default fallback
            if (cellState === 1) progressSpeed = 0.25; // Brood Production: Slowest (Takes twice as long)
            else if (cellState === 0) progressSpeed = 0.75; // Wax Production: Medium (Takes twice as long)
            else if (cellState === 4) progressSpeed = 4.0; // Blight Removal: Fastest
            else if (cellState === 3 && this.isQueen) progressSpeed = 3.0; // Queen laying egg: Fast

            // Blight exposure accelerates aging
            if (cellState === 4) {
                this.age += (delta / 60) * 2;
                blightProgressGrid[this.targetQ][this.targetR] -= delta * progressSpeed;
                
                if (blightProgressGrid[this.targetQ][this.targetR] <= 0) {
                    grid[this.targetQ][this.targetR] = 0;
                    blightProgressGrid[this.targetQ][this.targetR] = 0; 
                    workProgressGrid[this.targetQ][this.targetR] = 0; // Clear any old work progress
                    workingBeesGrid[this.targetQ][this.targetR] = Math.max(0, workingBeesGrid[this.targetQ][this.targetR] - 1);
                    this.state = 'WANDERING';
                }
                return; // Early return for Blight
            }

            // Normal jobs (Wax, Brood, Eggs)
            workProgressGrid[this.targetQ][this.targetR] += delta * progressSpeed;

            // Complete work
            if (workProgressGrid[this.targetQ][this.targetR] >= 100) {
                if (cellState === 0) { // Empty -> Wax
                    grid[this.targetQ][this.targetR] = 1;
                    blightProgressGrid[this.targetQ][this.targetR] = 0; 

                } else if (cellState === 1) { // Wax -> Brood
                    grid[this.targetQ][this.targetR] = 3;
                    blightProgressGrid[this.targetQ][this.targetR] = 0; 
                    broodProgressGrid[this.targetQ][this.targetR] = 0; // 0 means Prepared but Empty!
                    score += 50;
                } else if (cellState === 3 && this.isQueen) { // Queen laying egg
                    broodProgressGrid[this.targetQ][this.targetR] = 0.01; // Start incubation!
                }
                workProgressGrid[this.targetQ][this.targetR] = 0;
                workingBeesGrid[this.targetQ][this.targetR] = Math.max(0, workingBeesGrid[this.targetQ][this.targetR] - 1);
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
            if (shouldMoveToBeacon && closestBeacon) {
                // Outer zone: fly directly to beacon
                const dx = closestBeacon.x - this.x;
                const dy = closestBeacon.y - this.y;
                this.vx = (dx / distToClosestBeacon) * this.speed;
                this.vy = (dy / distToClosestBeacon) * this.speed;
            } else {
                // Job Scanning
                let bq = -1, br = -1; // Blight
                let hq = -1, hr = -1; // Brooding
                let wq = -1, wr = -1; // Waxing

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
                                // Brood can be built on any valid Wax cell
                                if (broodProgressGrid[q][r] >= 0) {
                                    hq = q; hr = r;
                                }
                            } else if (state === 0 && wq === -1) {
                                if (countStructuralNeighbors(grid, q, r) >= 2) {
                                    wq = q; wr = r;
                                }
                            }
                        }
                    }
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
    const aspectRatio = window.innerWidth / window.innerHeight;
    const logicalWidth = 720 * aspectRatio;
    const hexWidth = Math.sqrt(3) * HEX_SIZE;
    
    // Compute COLS to cover the logical width, +2 for screen bleed
    COLS = Math.floor(logicalWidth / hexWidth) + 2;
    GRID_WIDTH = COLS * hexWidth;
    
    // Initialize Grids
    grid = createGrid();
    nextGrid = createGrid();
    workingBeesGrid = createGrid();
    workProgressGrid = createGrid();
    blightProgressGrid = createGrid();
    nextBlightProgressGrid = createGrid();
    broodProgressGrid = createGrid();

    const app = new Application();
    
    const hexHeight = 2 * HEX_SIZE;
    const totalWidth = hexWidth * COLS + (hexWidth / 2);
    const totalHeight = (hexHeight * 3 / 4) * ROWS + (hexHeight / 4);

    await app.init({
        width: logicalWidth,
        height: 720,
        backgroundColor: 0x111111,
        antialias: true,
        autoDensity: true,
        resolution: window.devicePixelRatio || 1,
    });

    const appContainer = document.getElementById('app');
    if (appContainer) {
        appContainer.innerHTML = '';
        appContainer.appendChild(app.canvas);
    }

    const sheet = await Assets.load('/atlas.png.json');
    beeFrames = sheet.animations.b;
    queenFrames = sheet.animations.q;

    function onResize() {
        app.canvas.style.height = `${window.innerHeight}px`;
        app.canvas.style.width = `${window.innerHeight * (logicalWidth / 720)}px`;
    }
    window.addEventListener('resize', onResize);
    onResize();

    setupGrid();

    const world = new Container();
    app.stage.addChild(world);

    // Place the top-left bounds of the world exactly at the center of the screen
    world.x = app.screen.width / 2 - totalWidth / 2;
    world.y = app.screen.height / 2 - totalHeight / 2;

    const graphics = new Graphics();
    world.addChild(graphics);

    beeContainer = new Container();
    world.addChild(beeContainer);



    app.stage.eventMode = 'static';
    app.stage.hitArea = new Rectangle(0, 0, app.screen.width, app.screen.height);

    const chargingText = new Text({ text: '', style: { fill: 0xFFFFFF, fontSize: 16, fontWeight: 'bold' } });
    chargingText.visible = false;
    chargingText.anchor.set(0.5, 1.5); // Position slightly above the cursor
    app.stage.addChild(chargingText);
    app.stage.on('pointerdown', (e) => {
        if (gameState !== 'PLAYING') return;
        
        const localPos = graphics.toLocal(e.global);
        const hexPos = getHexFromPixel(localPos.x, localPos.y);
        
        let determinedType: BeaconType = 'MOVE';

        if (hexPos.q >= 0 && hexPos.q < COLS && hexPos.r >= 0 && hexPos.r < ROWS) {
            const state = grid[hexPos.q][hexPos.r];
            const blightProgress = blightProgressGrid[hexPos.q][hexPos.r];
            
            if (state === 0) {
                // Empty tile logic
                // Check if adjacent to wax (state === 1) or brood (state === 3)
                const dirs = getNeighbors(hexPos.q, hexPos.r);
                let touchesWax = false;
                for (let i = 0; i < 6; i++) {
                    const [dq, dr] = dirs[i];
                    const nq = hexPos.q + dq;
                    const nr = hexPos.r + dr;
                    if (nq >= 0 && nq < COLS && nr >= 0 && nr < ROWS) {
                        if (grid[nq][nr] === 1 || grid[nq][nr] === 3) { 
                            touchesWax = true;
                            break;
                        }
                    }
                }
                
                if (touchesWax) determinedType = 'WAX';
                else determinedType = 'MOVE';
            } else if (state === 4) {
                // Blight
                if (blightProgress >= 100) determinedType = 'BLIGHT';
                else determinedType = 'MOVE'; // immature blight
            } else if (state === 1) {
                determinedType = 'BROOD';
            } else if (state === 5 || state === 3) {
                determinedType = 'MOVE';
            }
        }
        
        selectedBeaconType = determinedType;


        // Max 1 active beacon globally - remove old when starting new charge
        beacons.length = 0;

        chargingBeacon = { x: localPos.x, y: localPos.y, type: selectedBeaconType, radius: HEX_SIZE * 3 };

        chargingText.visible = true;
        chargingText.position.set(e.global.x, e.global.y);
        if (selectedBeaconType === 'MOVE') chargingText.text = 'Move To';
        else if (selectedBeaconType === 'WAX') chargingText.text = 'Build Comb';
        else if (selectedBeaconType === 'BROOD') chargingText.text = 'Make Brood Cells';
        else if (selectedBeaconType === 'BLIGHT') chargingText.text = 'Clear Blight';
    });

    app.stage.on('pointermove', (e) => {
        if (!chargingBeacon) return;
        
        const localPos = graphics.toLocal(e.global);
        const dx = localPos.x - chargingBeacon.x;
        const dy = localPos.y - chargingBeacon.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        chargingBeacon.radius = Math.max(HEX_SIZE * 3, distance);

        chargingText.position.set(e.global.x, e.global.y);
    });

    const finalizeCharge = () => {
        if (!chargingBeacon) return;
        
        chargingText.visible = false;
        
        const finalRadius = chargingBeacon.radius;


        const durationSeconds = chargingBeacon.type === 'MOVE' ? 5 : 10;
        const startLife = durationSeconds;
        beacons.push({ x: chargingBeacon.x, y: chargingBeacon.y, life: startLife, maxLife: startLife, aoeRadius: finalRadius, type: chargingBeacon.type });
        
        chargingBeacon = null;
    };

    app.stage.on('pointerup', finalizeCharge);
    app.stage.on('pointerupoutside', finalizeCharge);

    const bees: Bee[] = [];
    bees.push(new Bee(playerStartX, playerStartY, true)); // 1 Queen
    for (let i = 0; i < 1; i++) {
        bees.push(new Bee(playerStartX + (Math.random() - 0.5) * 50, playerStartY + (Math.random() - 0.5) * 50, false));
    }

    const beeCountEl = document.getElementById('beeCountVal');
    const tugSwarmEl = document.getElementById('tug-swarm');
    const tugBlightEl = document.getElementById('tug-blight');

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

        beacons.length = 0;
        bees.length = 0; 
        bees.push(new Bee(playerStartX, playerStartY, true));
        for (let i = 0; i < 1; i++) {
            bees.push(new Bee(playerStartX + (Math.random() - 0.5) * 50, playerStartY + (Math.random() - 0.5) * 50, false));
        }
        gameState = 'PLAYING';
    }

    let caTime = 0;
    const CA_INTERVAL = 500; 

    app.ticker.speed = 1; 

    window.addEventListener('keydown', (e) => {
        if (e.key === '=' || e.key === '+') {
            app.ticker.speed = Math.min(10, app.ticker.speed * 1.5);
        } else if (e.key === '-' || e.key === '_') {
            app.ticker.speed = Math.max(0.1, app.ticker.speed / 1.5);
        }
    });

    app.ticker.add((ticker) => {
        if (gameState !== 'PLAYING') return;

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
        // globalBroodCount = currentBroodCount;



        // Decay beacons
        const dtSeconds = ticker.deltaTime / 60;
        for (let i = beacons.length - 1; i >= 0; i--) {
            beacons[i].life -= dtSeconds;
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
        
        let aliveCells = 0;
        let blightCells = 0;
        const offsetX = hexWidth / 2;
        const offsetY = hexHeight / 2;
        const time = performance.now() * 0.001;

        for (let q = 0; q < COLS; q++) {
            for (let r = 0; r < ROWS; r++) {
                const state = grid[q][r];
                const infection = blightProgressGrid[q][r];
                const work = workProgressGrid[q][r];
                
                if (state === 1 || state === 3) aliveCells++;
                if (state === 4) blightCells++;

                if (state !== 0 || infection > 0 || work > 0) {
                    const pos = hexToPixel(q, r);
                    const px = pos.x + offsetX;
                    const py = pos.y + offsetY;
                    
                    if (state === 1) graphics.fill({ color: COLOR_WAX, alpha: 0.5 }); 
                    else if (state === 3) graphics.fill({ color: COLOR_BROOD }); 
                    else if (state === 5) graphics.fill({ color: COLOR_WOOD }); // Wood

                    if (state === 4) {
                        let blightScale = 0.99; //1 - Math.random() * 0.1; // Default random static variation
                        if (ENABLE_BLIGHT_PULSE) {
                            const pulseOffset = (q * 17.3) + (r * 23.7);
                            blightScale = 0.95 + Math.sin(time + pulseOffset) * 0.1 + (Math.random() * 0.02 - 0.01);
                        }
                        
                        graphics.fill({ color: COLOR_BLIGHT });
                        drawHex(graphics, px, py, HEX_SIZE * blightScale * (blightProgressGrid[q][r] / 100));
                        graphics.fill();
                    } else if (state !== 0) {
                        let tileScale = 0.9;
                        if( state === 5 ) tileScale = 0.98; // Wood is full size
                        drawHex(graphics, px, py, HEX_SIZE * tileScale);
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
                        graphics.fill({ color: COLOR_BLIGHT, alpha: 0.6 });
                        drawHex(graphics, px, py, HEX_SIZE * (0.9) * (infection / 100));
                        graphics.fill();
                        graphics.fill({ alpha: 1.0 }); 
                    }

                    if (work > 0) {
                        let progressColor = 0xFFFFFF;
                        if (state === 0) progressColor = COLOR_WAX;
                        else if (state === 1) progressColor = COLOR_BROOD;
                        else if (state === 3) progressColor = COLOR_QUEEN_EGG; // Queen laying egg
                        else if (state === 4) progressColor = COLOR_BLIGHT_REMOVE;
                        
                        graphics.fill({ color: progressColor, alpha: 0.5 });
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
            const lifeRatio = b.life / b.maxLife;
            
            let color = 0x00FFFF; // Move
            if (b.type === 'WAX') color = 0xFFD700;
            else if (b.type === 'BROOD') color = 0xFF1493;
            else if (b.type === 'BLIGHT') color = 0x8A2BE2;

            // Draw Area of Effect radius
            graphics.circle(b.x, b.y, b.aoeRadius);
            graphics.stroke({ color: color, alpha: 0.1 * lifeRatio, width: 1 });

            // Draw core beacon
            graphics.circle(b.x, b.y, BEACON_DEADZONE * pulse);
            graphics.stroke({ color: color, alpha: 0.5 * lifeRatio, width: 2 });
            graphics.circle(b.x, b.y, 4);
            graphics.fill({ color: color, alpha: lifeRatio });
        }

        // Draw Charging Beacon Ring
        if (chargingBeacon) {
            const currentRadius = chargingBeacon.radius;
            
            let color = 0x00FFFF; // Move
            if (chargingBeacon.type === 'WAX') color = 0xFFD700;
            else if (chargingBeacon.type === 'BROOD') color = 0xFF1493;
            else if (chargingBeacon.type === 'BLIGHT') color = 0x8A2BE2;

            graphics.circle(chargingBeacon.x, chargingBeacon.y, currentRadius);
            graphics.stroke({ color: color, alpha: 0.3, width: 2 });
            graphics.circle(chargingBeacon.x, chargingBeacon.y, BEACON_DEADZONE);
            graphics.stroke({ color: color, alpha: 0.6, width: 2 });
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
                const c = Math.floor(80 + 175 * lifePct); // Fades from White (255) to Dark Grey (80)
                colorHex = (c << 16) | (c << 8) | c;
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

        // Draw Queen Health Bar
        for (const bee of bees) {
            if (bee.isQueen && bee.health < bee.maxHealth && bee.health > 0) {
                const barWidth = 60;
                const barHeight = 6;
                const barX = bee.x - barWidth / 2;
                const barY = bee.y - 45; // Above her head

                // Background
                graphics.fill({ color: 0x222222 });
                graphics.rect(barX, barY, barWidth, barHeight);
                graphics.fill();
                
                // Health
                graphics.fill({ color: 0xff0000 });
                graphics.rect(barX, barY, barWidth * Math.max(0, bee.health / bee.maxHealth), barHeight);
                graphics.fill();
            }
        }

        if (tugSwarmEl && tugBlightEl) {
            const swarmPct = Math.min(100, (aliveCells / playableCells) * 100);
            const blightPct = Math.min(100, (blightCells / playableCells) * 100);
            tugSwarmEl.style.width = `${swarmPct}%`;
            tugBlightEl.style.width = `${blightPct}%`;
        }

        if (aliveCells === 0) {
            gameState = 'GAME_OVER';
            document.getElementById('game-over')!.style.display = 'flex';
        } else if (aliveCells >= playableCells * 0.9) {
            gameState = 'GAME_WON';
            document.getElementById('game-won')!.style.display = 'flex';
        }
    });
}

init().catch(console.error);
