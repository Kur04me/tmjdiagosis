import initWasm, {
  process_image_for_tmj as processImage,
} from '../../wasm/pkg/tmj_core.js';

const SAMPLE_SIDES = [
  { side: 'left', label: '左顎関節', source: '../../sample/left_condyle.jpg' },
  {
    side: 'right',
    label: '右顎関節',
    source: '../../sample/right_contyle.jpg',
  },
];

const REGION_META = {
  condyle: { label: '下顎頭', color: '#f97316' },
  fossa: { label: '関節窩', color: '#38bdf8' },
};

const root = document.querySelector('#root');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const toGrayscale = (img, width, height) => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, width, height);
  const { data } = ctx.getImageData(0, 0, width, height);
  const buffer = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 1) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    buffer[j] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  return buffer;
};

const drawPolyline = (ctx, points, color) => {
  if (!points || points.length === 0) {
    return;
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i += 1) {
    ctx.lineTo(points[i][0], points[i][1]);
  }
  ctx.stroke();

  ctx.fillStyle = color;
  for (const [x, y] of points) {
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
};

const formatPoints = (points) =>
  points
    .map(([x, y]) => `[${x.toFixed(1)}, ${y.toFixed(1)}]`)
    .join(', ')
    .trim();

const computeBounds = (points) => {
  if (!points || points.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
};

const renderMeta = (wrapper, result, side, dims) => {
  const condyleBounds = computeBounds(result.condyle);
  const fossaBounds = computeBounds(result.fossa);

  wrapper.textContent = '';
  wrapper.append(
    `Side: ${side}`,
    '\n',
    `Image size: ${dims.width} × ${dims.height}`,
    '\n',
    `Condyle points (${result.condyle.length}): `,
    formatPoints(result.condyle),
    '\n',
    `Condyle bounds: ${condyleBounds ? JSON.stringify(condyleBounds) : 'N/A'}`,
    '\n',
    `Fossa points (${result.fossa.length}): `,
    formatPoints(result.fossa),
    '\n',
    `Fossa bounds: ${fossaBounds ? JSON.stringify(fossaBounds) : 'N/A'}`
  );
};

async function loadImage(source) {
  const img = new Image();
  img.src = source;
  await img.decode();
  return img;
}

const renderSample = async ({ side, label, source }) => {
  const section = document.createElement('section');
  const heading = document.createElement('h2');
  heading.textContent = label;
  section.appendChild(heading);

  const figure = document.createElement('div');
  figure.className = 'figure';
  section.appendChild(figure);

  const canvasWrapper = document.createElement('div');
  canvasWrapper.className = 'canvas-wrapper';
  figure.appendChild(canvasWrapper);

  const picture = document.createElement('picture');
  const img = await loadImage(source);
  picture.appendChild(img);
  canvasWrapper.appendChild(picture);

  const overlayCanvas = document.createElement('canvas');
  overlayCanvas.width = img.naturalWidth;
  overlayCanvas.height = img.naturalHeight;
  overlayCanvas.style.width = '100%';
  overlayCanvas.style.height = 'auto';
  canvasWrapper.appendChild(overlayCanvas);

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = '処理中...';
  section.appendChild(meta);

  root.appendChild(section);

  await sleep(50);
  const grayscale = toGrayscale(img, img.naturalWidth, img.naturalHeight);
  const raw = processImage(grayscale, img.naturalWidth, img.naturalHeight, side);
  const parsed = JSON.parse(raw);

  const ctx = overlayCanvas.getContext('2d');
  ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

  drawPolyline(ctx, parsed.condyle ?? [], REGION_META.condyle.color);
  drawPolyline(ctx, parsed.fossa ?? [], REGION_META.fossa.color);

  renderMeta(meta, parsed, side, {
    width: img.naturalWidth,
    height: img.naturalHeight,
  });
};

async function boot() {
  await initWasm();
  for (const sample of SAMPLE_SIDES) {
    try {
      await renderSample(sample);
    } catch (error) {
      console.error(`Failed to render ${sample.side}`, error);
      const section = document.createElement('section');
      section.innerHTML = `<h2>${sample.label}</h2><p style="color:#f87171">Failed: ${error}</p>`;
      root.appendChild(section);
    }
  }
}

boot().catch((error) => {
  console.error('Fatal error', error);
  const failure = document.createElement('pre');
  failure.style.padding = '24px';
  failure.style.color = '#f87171';
  failure.textContent = `Fatal: ${error?.stack ?? error}`;
  root.appendChild(failure);
});

