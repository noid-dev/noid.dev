const CONFIG = {
  startDelay: 2, // seconds before draining begins; also the mouse idle time before the cursor hides
  totalDuration: 180, // seconds
  resizeDelay: 0.2, // seconds the window size must stay stable before the sand is rebuilt
  sandColors: [
    '#E8D4B8', // lightest sand
    '#DFC9A8', // very light sand
    '#D4B896', // light sand
    '#C9AD7C', // light golden sand
    '#BFA172', // golden sand
    '#B08D5C', // warm sand
    '#A68255', // amber sand
    '#967545', // dark amber
    '#876838', // dark sand
  ],
  // revealTime: seconds after draining starts when the sand reaches the top of the text
  messages: [
    { text: 'Attention is a gift', revealTime: 45 },
    { text: 'You just gave two minutes of yours', revealTime: 90 },
    { text: 'Three. Who needs them more?', revealTime: 135 }
  ],
  fontFamily: 'Cormorant Garamond, Georgia, serif',
  byline: {
    text: 'by noid',
    yPercent: 0.5,
    sizeVw: 4,
    minSize: 36,
    maxSize: 56,
    lighten: 6, // byline grains are this many colors lighter than the sand around them
    fadeColors: 3, // below the byline's row, grains in the lightest 3 colors slowly darken...
    fadeChance: 0.003 // ...each by one color, with this chance per frame
  }
};

let canvas, ctx;
let cellSize; // CSS pixels per grain
let cols, rows;
let grid = null; // one byte per cell, row by row: 0 = empty, 1-9 = sand color
let drainZoneStart = 0; // index of the first cell in the bottom row
let topSandRow = 0; // every row above this one is empty
let elapsedTime = 0;
let lastFrameTime = null;
let remainingSand = 0;
let imageData = null;
let pixels = null; // the canvas pixels as 32-bit values, same indexes as grid
let viewportWidth = 0;
let viewportHeight = 0;
let columnOrder = []; // randomized column order for physics

// A canvas pixel is 4 bytes (R, G, B, A). Read as one little-endian
// 32-bit number, those bytes become 0xAABBGGRR.
function hexToPixel(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

const TRANSPARENT = 0;
const cellPixels = [TRANSPARENT, ...CONFIG.sandColors.map(hexToPixel)]; // indexed by cell value

function init() {
  canvas = document.getElementById('canvas');
  ctx = canvas.getContext('2d');

  createMessages();
  rebuildSand();
  window.addEventListener('resize', handleResize);
  document.addEventListener('visibilitychange', () => {
    updateFavicon();
    if (!document.hidden) {
      lastFrameTime = performance.now();
      requestWakeLock();
    }
  });

  document.addEventListener('pointermove', resetCursorHideTimer);
  resetCursorHideTimer();

  updateFavicon();
  requestWakeLock();
  requestAnimationFrame(animate);
}

function createMessages() {
  const container = document.getElementById('messages');
  for (const { text, revealTime } of CONFIG.messages) {
    const message = document.createElement('p');
    message.className = 'message';
    message.textContent = text;
    message.style.top = `${revealTime / CONFIG.totalDuration * 100}%`;
    container.append(message);
  }
}

let nextMessageIndex = 0;

function announceRevealedMessages(progress) {
  const message = CONFIG.messages[nextMessageIndex];
  if (message && progress * CONFIG.totalDuration >= message.revealTime) {
    announce(message.text);
    nextMessageIndex++;
  }
}

function announce(text) {
  const line = document.createElement('p');
  line.textContent = text;
  document.getElementById('announcer').append(line);
}

function updateFavicon() {
  const emoji = remainingSand === 0 ? '❤️'
    : document.hidden ? '⌛'
    : '⏳';
  document.getElementById('favicon').href =
    `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>${emoji}</text></svg>`;
}

let cursorHideTimer = null;

function resetCursorHideTimer() {
  document.body.classList.remove('cursor-hidden');
  clearTimeout(cursorHideTimer);
  cursorHideTimer = setTimeout(
    () => document.body.classList.add('cursor-hidden'),
    CONFIG.startDelay * 1000
  );
}

let wakeLock = null;
let isRequestingWakeLock = false;

async function requestWakeLock() {
  const canRequest = !document.hidden && remainingSand > 0;
  if (!canRequest || wakeLock || isRequestingWakeLock) return;

  isRequestingWakeLock = true;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
    if (remainingSand === 0) releaseWakeLock();
  } catch {
    // Refused (iframe policy, battery saver): screen just sleeps as before.
  } finally {
    isRequestingWakeLock = false;
  }
}

function releaseWakeLock() {
  wakeLock?.release();
  wakeLock = null;
}

let resizeTimer = null;

function handleResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(rebuildSand, CONFIG.resizeDelay * 1000);
}

function rebuildSand() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  if (width === viewportWidth && height === viewportHeight) return;
  viewportWidth = width;
  viewportHeight = height;

  cellSize = width < 768 ? 1 : 2;

  cols = Math.ceil(width / cellSize);
  rows = Math.ceil(height / cellSize);
  drainZoneStart = (rows - 1) * cols;

  canvas.width = cols;
  canvas.height = rows;

  const bylineMap = createBylineMap(width, height);

  initializeGrid(bylineMap);

  const drainedRows = Math.floor(rows * drainProgress());
  removeDrainedRows(drainedRows);
  remainingSand = (rows - drainedRows) * cols;
  topSandRow = 0;

  columnOrder = [...Array(cols).keys()];
  imageData = ctx.createImageData(cols, rows);
  pixels = new Uint32Array(imageData.data.buffer);
  renderAll();
}

// Draining shifts the whole pile down evenly, so the sand left after N drained rows
// is the top of the original pattern, moved down by N rows.
function removeDrainedRows(drainedRows) {
  const drainedCells = drainedRows * cols;
  grid.copyWithin(drainedCells, 0, grid.length - drainedCells);
  grid.fill(0, 0, drainedCells);
}

// One byte per cell: 1 where the cell's center falls inside a letter of the byline
function createBylineMap(width, height) {
  const { text, yPercent, sizeVw, minSize, maxSize } = CONFIG.byline;
  const fontSize = Math.max(minSize, Math.min(maxSize, Math.round(width * sizeVw / 100)));

  const textCtx = new OffscreenCanvas(width, height).getContext('2d');
  textCtx.font = `${fontSize}px ${CONFIG.fontFamily}`;
  textCtx.textAlign = 'center';
  textCtx.textBaseline = 'middle';
  textCtx.fillText(text, width / 2, height * yPercent);

  const { data } = textCtx.getImageData(0, 0, width, height);
  const map = new Uint8Array(cols * rows);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = Math.min(col * cellSize + Math.floor(cellSize / 2), width - 1);
      const y = Math.min(row * cellSize + Math.floor(cellSize / 2), height - 1);
      const alpha = data[(y * width + x) * 4 + 3];
      map[row * cols + col] = alpha >= 128 ? 1 : 0;
    }
  }
  return map;
}

function initializeGrid(bylineMap) {
  grid = new Uint8Array(cols * rows);

  for (let row = 0; row < rows; row++) {
    const rowPercent = row / rows;

    for (let col = 0; col < cols; col++) {
      const colPercent = col / cols;

      // Diagonal gradient (top-left light to bottom-right dark)
      let shade = (rowPercent * 0.6 + colPercent * 0.4);

      // Add sweeping curves like wind patterns
      shade += Math.sin(colPercent * Math.PI * 2 + rowPercent * 1.5) * 0.08;
      shade += Math.cos(rowPercent * Math.PI * 3 - colPercent * 2) * 0.05;

      // Add swirl effect from center
      const dx = colPercent - 0.5;
      const dy = rowPercent - 0.5;
      const angle = Math.atan2(dy, dx);
      const dist = Math.sqrt(dx * dx + dy * dy);
      shade += Math.sin(angle * 2 + dist * 4) * 0.06;

      // Add per-grain jitter so the shade bands blend into each other
      shade += (Math.random() - 0.5) * 0.15;

      shade = Math.max(0, Math.min(1, shade));

      const baseColorIndex = Math.floor(shade * (CONFIG.sandColors.length - 1));

      // Add local grain variation: up to 2 colors either side of the base color
      const localVariation = Math.floor(Math.random() * 5) - 2;
      let colorIndex = baseColorIndex + localVariation;

      // Shift color for author signature (lighter = more visible)
      if (bylineMap[row * cols + col]) {
        colorIndex -= CONFIG.byline.lighten;
      }

      colorIndex = Math.max(0, Math.min(CONFIG.sandColors.length - 1, colorIndex));

      grid[row * cols + col] = colorIndex + 1;
    }
  }
}

// 0 before draining starts, 1 once the full duration has passed
function drainProgress() {
  const drainTime = Math.max(0, elapsedTime - CONFIG.startDelay * 1000);
  return Math.min(drainTime / (CONFIG.totalDuration * 1000), 1);
}

function animate(timestamp) {
  if (!lastFrameTime) lastFrameTime = timestamp;

  if (!document.hidden) {
    const delta = timestamp - lastFrameTime;
    elapsedTime += delta;

    const progress = drainProgress();
    const total = rows * cols;
    const targetDrained = Math.floor(total * progress);
    const drainedSoFar = total - remainingSand;
    const toDrain = targetDrained - drainedSoFar;

    // Sand only moves down, so this frame can only change rows from here on
    topSandRow = findTopSandRow(topSandRow);

    updatePhysics();
    drainSand(toDrain);
    render(topSandRow);
    announceRevealedMessages(progress);
  }

  lastFrameTime = timestamp;

  if (remainingSand > 0) {
    requestAnimationFrame(animate);
  } else {
    releaseWakeLock();
    announce(document.title);
    updateFavicon();
  }
}

function updatePhysics() {
  // Shuffle column order each frame for even distribution
  for (let i = columnOrder.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const swap = columnOrder[i];
    columnOrder[i] = columnOrder[j];
    columnOrder[j] = swap;
  }

  const bylineRow = Math.floor(rows * CONFIG.byline.yPercent);
  const { fadeColors, fadeChance } = CONFIG.byline;

  // Process from bottom to top, columns in random order
  for (let row = rows - 2; row >= 0; row--) {
    const rowStart = row * cols;

    for (let i = 0; i < cols; i++) {
      const col = columnOrder[i];
      const index = rowStart + col;
      let sand = grid[index];
      if (sand === 0) continue;

      // Fade byline: light grains below byline gradually darken
      if (row >= bylineRow && sand <= fadeColors && Math.random() < fadeChance) {
        sand++;
        setCell(index, sand);
      }

      const below = index + cols;
      let target = -1;

      if (grid[below] === 0) {
        target = below;
      } else {
        const canGoLeft = col > 0 && grid[below - 1] === 0;
        const canGoRight = col < cols - 1 && grid[below + 1] === 0;
        if (canGoLeft && canGoRight) target = Math.random() < 0.5 ? below - 1 : below + 1;
        else if (canGoLeft) target = below - 1;
        else if (canGoRight) target = below + 1;
      }

      if (target !== -1) {
        setCell(target, sand);
        setCell(index, 0);
      }
    }
  }
}

function drainSand(count) {
  let drained = 0;
  for (let i = 0; i < cols && drained < count; i++) {
    const index = drainZoneStart + columnOrder[i];
    if (grid[index] !== 0) {
      setCell(index, 0);
      remainingSand--;
      drained++;
    }
  }
}

// The bottom row is the invisible "drain zone"
function pixelFor(index) {
  return index < drainZoneStart ? cellPixels[grid[index]] : TRANSPARENT;
}

function setCell(index, value) {
  grid[index] = value;
  pixels[index] = pixelFor(index);
}

function renderAll() {
  for (let index = 0; index < grid.length; index++) {
    pixels[index] = pixelFor(index);
  }
  render();
}

// Sends rows fromRow..bottom of the pixel buffer to the canvas
function render(fromRow = 0) {
  ctx.putImageData(imageData, 0, 0, 0, fromRow, cols, rows - fromRow);
}

function findTopSandRow(fromRow) {
  let index = fromRow * cols;
  while (index < grid.length && grid[index] === 0) index++;
  return Math.floor(index / cols);
}

await document.fonts.load(`${CONFIG.byline.maxSize}px ${CONFIG.fontFamily}`).catch(() => {});
init();
