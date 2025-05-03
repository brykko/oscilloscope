import * as THREE from 'three';

// === Constants for Data and Playback ===
const SIGNAL_DATA_FILE = './probe2_nchan=385.bin';  // Raw signal data file (Int16 binary)
const SAMPLES_PER_SECOND = 30000;           // e.g., 30 kHz sampling rate
const SWEEP_SPEED_FACTOR = 0.015;            // slows playback down
const SWEEP_DURATION = 0.05;                // Sweep duration in seconds
const CHANNELS = 385;                       // Total channels in the raw data
// Subset constants for plotting a subset of channels:

// 100-channel view
const FIRST_CHANNEL = 200;
const LAST_CHANNEL  = 300;
const AMPLITUDE_SCALE_FACTOR = 0.0000015; // Amplitude scaling factor (relative to viewHeight)

// Large-scale view
// const FIRST_CHANNEL = 0;
// const LAST_CHANNEL  = 320;
// const AMPLITUDE_SCALE_FACTOR = 0.000001; // Amplitude scaling factor (relative to viewHeight)

const numChannelsToPlot = LAST_CHANNEL - FIRST_CHANNEL + 1;

// Spike tick appearance constants:
const TICK_HEIGHT = 10;       // Height in pixels
const TICK_THICKNESS = 4;     // Thickness in pixels

const FADE_DURATION_SECS = 0.05;

// === Global Variables ===
let scene, camera, renderer;
let lineMeshes = [];       // Raw signal lines; each entry: { mesh, actualChannel, yOffset, amplitudeScale }
let cursorMesh;
let cursorGlow;            // Cursor glow mesh
let dataArray;             // Raw signal data (Int16Array)
let totalSamples = 0;      // Total samples in raw data
let samplesPerChannel = 0; // Samples per channel

// Sweep variables (for ring-buffer updating):
let windowStartSample = 0; // Starting sample index for current sweep
let sweepSampleCount = 0;  // Number of samples per sweep = SWEEP_DURATION * SAMPLES_PER_SECOND
let currentSample = 0;     // Current sample index within the sweep window

// View dimensions (in pixels)
let viewWidth = window.innerWidth;
let viewHeight = window.innerHeight;

// URL query switches
let showSpikes, showFactors, useClusterColors;

function setURLOptions() {
  const queryParams = new URLSearchParams(window.location.search);
  showSpikes = (queryParams.get('showSpikes') ?? '0') === '1';
  showFactors = (queryParams.get('showFactors') ?? '0') === '1';
  useClusterColors = (queryParams.get('useClusterColors') ?? '0') === '1';
  console.log("showSpikes =", showSpikes);
  console.log("showFactors =", showFactors);
  console.log("useClusterColors =", useClusterColors);
}

// === Spike Data Globals ===
let spikeTimes;      // Float32Array from spike_times.bin
let spikeChannels;   // Uint16Array from spike_channels.bin
let spikeClusters;   // Typed array from spike_clusters.bin (assumed Uint16Array)
let sampleTimes;     // Float32Array from sample_times.bin

// For the spike overlay, we now create a Mesh (instead of line segments).
let spikeOverlayMesh; // THREE.Mesh for spike ticks

// === Initialization & Resize ===
function initThree() {
  scene = new THREE.Scene();
  
  viewWidth = window.innerWidth;
  viewHeight = window.innerHeight;
  
  // Define an orthographic camera in pixel units.
  camera = new THREE.OrthographicCamera(0, viewWidth, viewHeight, 0, 1, 100);
  camera.position.z = 10;
  camera.lookAt(0, 0, 0);
  
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(viewWidth, viewHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  document.body.appendChild(renderer.domElement);
  
  window.addEventListener('resize', onWindowResize, false);
}

function onWindowResize() {
  viewWidth = window.innerWidth;
  viewHeight = window.innerHeight;
  
  camera.left = 0;
  camera.right = viewWidth;
  camera.top = viewHeight;
  camera.bottom = 0;
  camera.updateProjectionMatrix();
  
  renderer.setSize(viewWidth, viewHeight);
  
  // Recreate raw signal lines.
  for (let obj of lineMeshes) {
    scene.remove(obj.mesh);
  }
  lineMeshes = [];
  createPersistentLines();
  
  // Recreate cursor and glow.
  scene.remove(cursorMesh);
  createCursor();
  
  // Recreate spike overlay if enabled.
  if (showSpikes) {
    if (spikeOverlayMesh) {
      scene.remove(spikeOverlayMesh);
    }
    createSpikeOverlayMesh();
  }
}

// === Data Loading Functions ===
async function loadData() {
  let response = await fetch(SIGNAL_DATA_FILE);
  let buffer = await response.arrayBuffer();
  dataArray = new Int16Array(buffer);
  totalSamples = dataArray.length;
  samplesPerChannel = totalSamples / CHANNELS;

  // Load sample_times.bin
  response = await fetch('./probe2_sample_times.bin');
  buffer = await response.arrayBuffer();
  sampleTimes = new Float32Array(buffer);

  console.log(`Data loaded: ${totalSamples} samples. Samples per channel: ${samplesPerChannel}`);
}

async function loadSpikeData() {
  // Load spike_times.bin
  let response = await fetch('./probe2_spike_times.bin');
  let buffer = await response.arrayBuffer();
  spikeTimes = new Float32Array(buffer);
  
  // Load spike_channels.bin
  response = await fetch('./probe2_spike_channels.bin');
  buffer = await response.arrayBuffer();
  spikeChannels = new Uint16Array(buffer);
  
  // Load spike_clusters.bin
  response = await fetch('./probe2_spike_clusters.bin');
  buffer = await response.arrayBuffer();
  spikeClusters = new Uint16Array(buffer);
  
  console.log("Spike data loaded:",
    spikeTimes.length, "spike times,",
    spikeChannels.length, "spike channels,",
    spikeClusters.length, "spike clusters,",
    sampleTimes.length, "sample times");
}

// Shared ShaderMaterial supporting both baseColor and per-vertex aColor, with fading.
function createSharedShaderMaterial(useVertexColor) {
  return new THREE.ShaderMaterial({
    uniforms: {
      baseColor: { value: new THREE.Color(0xffffff).toArray().slice(0, 3) }, // vec3
      useVertexColor: { value: useVertexColor ? 1.0 : 0.0 } // float
    },
    vertexShader: `
      attribute float fade;
      attribute vec3 aColor;

      uniform vec3 baseColor;
      uniform float useVertexColor;

      varying vec4 vColor;

      void main() {
        float a = fade;
        vec3 c = mix(baseColor, aColor, useVertexColor);
        vColor = vec4(c, a);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec4 vColor;
      void main() {
        gl_FragColor = vColor;
      }
    `,
    transparent: true
  });
}

function createPersistentLines() {
  lineMeshes = [];
  
  const reveals = new Float32Array(sweepSampleCount);
  const totalXRange = viewWidth;  // from 0 to viewWidth
  const xStep = totalXRange / (sweepSampleCount - 1);
  const verticalSpacing = viewHeight / (numChannelsToPlot - 1);
  const amplitudeScale = AMPLITUDE_SCALE_FACTOR * viewHeight;
  
  // Use shared shader material for raw signal lines (no per-vertex color)
  const lineMaterial = createSharedShaderMaterial(false);
  
  for (let i = 0; i < numChannelsToPlot; i++) {
    const actualChannel = FIRST_CHANNEL + i;
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(sweepSampleCount * 3);
    const fades = new Float32Array(sweepSampleCount);  // new fade attribute
    
    const yOffset = i * verticalSpacing;
    for (let j = 0; j < sweepSampleCount; j++) {
      const x = j * xStep;
      positions[j * 3 + 0] = x;
      positions[j * 3 + 1] = yOffset;
      positions[j * 3 + 2] = 0;
      
      fades[j] = 0.0;  // Start with fully transparent (unrevealed)
    }

    const reveals = new Float32Array(sweepSampleCount);  // new attribute to store when (in absolute samples) each vertex was revealed
    for (let j = 0; j < sweepSampleCount; j++) {
      reveals[j] = 0;  // initialize to zero (or you could initialize to windowStartSample for clarity)
    }
    geometry.setAttribute('revealTime', new THREE.BufferAttribute(reveals, 1));
        
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('fade', new THREE.BufferAttribute(fades, 1)); // add fade attribute
    geometry.setDrawRange(0, sweepSampleCount);
    
    // Use shared shader material
    const line = new THREE.Line(geometry, lineMaterial);
    line.renderOrder = 1;
    scene.add(line);
    
    lineMeshes.push({ mesh: line, actualChannel: actualChannel, yOffset: yOffset, amplitudeScale: amplitudeScale });
  }
}

function updateRawSignalFades() {
  const globalSample = windowStartSample + currentSample;
  const currentTime = sampleTimes[globalSample];

  for (let obj of lineMeshes) {
    const fades = obj.mesh.geometry.attributes.fade.array;
    const reveals = obj.mesh.geometry.attributes.revealTime.array;
    for (let j = 0; j < sweepSampleCount; j++) {
      let deltaT = currentTime - reveals[j];
      let fadeVal = 1 - (deltaT / FADE_DURATION_SECS);
      fades[j] = Math.max(0, Math.min(fadeVal, 1));
    }
    obj.mesh.geometry.attributes.fade.needsUpdate = true;
  }
}


// === Create Spike Overlay Mesh ===
// We create a single Mesh whose geometry will contain quads (two triangles per spike tick).
function createSpikeOverlayMesh() {
  // Start with an empty geometry.
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
  geometry.setAttribute('aColor', new THREE.Float32BufferAttribute([], 3));
  geometry.setAttribute('fade', new THREE.Float32BufferAttribute([], 1));

  // Use shared shader material for per-vertex color and fade.
  const material = createSharedShaderMaterial(true);
  spikeOverlayMesh = new THREE.Mesh(geometry, material);
  spikeOverlayMesh.renderOrder = 3;
  scene.add(spikeOverlayMesh);
}

function getClusterColor(clusterId) {
  // Map the cluster id to a hue value (0 to 1). Adjust multiplier as desired.
  let hue = (clusterId * 0.1) % 1;
  let color = new THREE.Color();
  color.setHSL(hue, 0.8, 0.5);
  return color;
}

function updateSpikeOverlay() {
  console.log("SPIKE OVERLAY");
  // Ensure we have enough sampleTimes for the current sweep.
  // if (!spikeTimes || !spikeChannels || !spikeClusters) return;
  if (!sampleTimes || sampleTimes.length < windowStartSample + sweepSampleCount) return;

  // Determine the current time window.
  const currentSampleAbs = windowStartSample + currentSample;
  const currentTime = sampleTimes[currentSampleAbs];
  const startTime = sampleTimes[windowStartSample];
  const endTime = sampleTimes[windowStartSample + sweepSampleCount - 1];
  const overwriteTime = currentTime - SWEEP_DURATION; // Spikes older than this are overwritten

  // Compute vertical spacing (same as raw signals).
  const verticalSpacing = viewHeight / (numChannelsToPlot - 1);

  // We'll accumulate vertices, colors, and fades for each spike tick.
  const positions = [];
  const vtxColors = [];
  const fades = [];

  // Iterate over each spike event.
  for (let i = 0; i < spikeTimes.length; i++) {
    const spikeTime = spikeTimes[i];
    // Only consider spikes within the current sweep window and not older than overwriteTime.
    if (spikeTime < overwriteTime || spikeTime > endTime) continue;
    // Only reveal spikes that have already been swept over.
    if (spikeTime > currentTime) continue;

    // Compute fade: 1 - (currentTime - spikeTime) / SWEEP_DURATION, clamped 0..1
    // let fade = 1 - (currentTime - spikeTime) / SWEEP_DURATION;
    let fade = 1 - (currentTime - spikeTime) / FADE_DURATION_SECS;
    fade = Math.max(0, Math.min(fade, 1));

    // Map spike time to an x coordinate.
    // Here we map the time span of one sweep (SWEEP_DURATION) to the view width.
    let fraction = (spikeTime - startTime) / SWEEP_DURATION;
    if (fraction < 0) fraction += 1.0; // Wrap negative fractions if needed.
    const spikeX = fraction * viewWidth;

    // Get the channel and check that it's within the plotted subset.
    const spikeCh = spikeChannels[i];
    if (spikeCh < FIRST_CHANNEL || spikeCh > LAST_CHANNEL) continue;
    const index = spikeCh - FIRST_CHANNEL;
    const spikeY = index * verticalSpacing;

    // Get the cluster id and map to a color.
    const clusterId = spikeClusters[i];

    let color;
    if (useClusterColors) {
      color = getClusterColor(clusterId);
    } else {
      color = new THREE.Color();
      color.setRGB(1, 1, 1);
    }

    // Build a quad (two triangles) for a thick spike tick.
    // We want the quad centered at (spikeX, spikeY) with width = TICK_THICKNESS and height = TICK_HEIGHT.
    const halfThick = TICK_THICKNESS / 2;
    const halfTickH = TICK_HEIGHT / 2;

    // Define the four corners:
    // bottom-left, top-left, top-right, bottom-right.
    const bl = [spikeX - halfThick, spikeY - halfTickH, 0];
    const tl = [spikeX - halfThick, spikeY + halfTickH, 0];
    const tr = [spikeX + halfThick, spikeY + halfTickH, 0];
    const br = [spikeX + halfThick, spikeY - halfTickH, 0];

    // To have counterclockwise ordering when viewed from the camera,
    // we define the two triangles as:
    // Triangle 1: (bl, tr, tl)
    positions.push(...bl, ...tr, ...tl);
    // Triangle 2: (bl, br, tr)
    positions.push(...bl, ...br, ...tr);

    // For each vertex, push the same color and fade.
    for (let j = 0; j < 6; j++) {
      vtxColors.push(color.r, color.g, color.b);
      fades.push(fade);
    }
  }

  // Update the spike overlay mesh geometry.
  spikeOverlayMesh.geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  spikeOverlayMesh.geometry.setAttribute('aColor', new THREE.Float32BufferAttribute(vtxColors, 3));
  spikeOverlayMesh.geometry.setAttribute('fade', new THREE.Float32BufferAttribute(fades, 1));
  spikeOverlayMesh.geometry.attributes.position.needsUpdate = true;
  spikeOverlayMesh.geometry.attributes.aColor.needsUpdate = true;
  spikeOverlayMesh.geometry.attributes.fade.needsUpdate = true;
}

// === Cursor and Glow ===
function createCursor() {
  const cursorGeom = new THREE.BufferGeometry();
  const positions = new Float32Array(6);
  positions[0] = 0;
  positions[1] = 0;
  positions[2] = 0;
  positions[3] = 0;
  positions[4] = viewHeight;
  positions[5] = 0;
  cursorGeom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.LineBasicMaterial({ color: 0xff0000 });
  cursorMesh = new THREE.Line(cursorGeom, material);
  cursorMesh.renderOrder = 2;
  scene.add(cursorMesh);
  
  if (cursorGlow) scene.remove(cursorGlow);
  cursorGlow = createCursorGlow();
}

function createCursorGlow() {
  const glowWidth = 50;
  const geometry = new THREE.PlaneGeometry(glowWidth, viewHeight);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      glowColor: { value: new THREE.Color(0xff0000) },
      glowIntensity: { value: 1.0 }
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 glowColor;
      uniform float glowIntensity;
      varying vec2 vUv;
      void main() {
        float alpha;
        if (vUv.x < 0.5) {
          float d = (0.5 - vUv.x) / 0.2;
          alpha = 1.0 - d;
        } else {
          float d = (vUv.x - 0.5) / 0.2;
          alpha = 1.0 - d;
        }
        gl_FragColor = vec4(glowColor, alpha * glowIntensity);
      }
    `,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false
  });
  
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(0, viewHeight / 2, 0);
  mesh.renderOrder = 1.5;
  scene.add(mesh);
  return mesh;
}

// === Animation Loop ===
let lastTime = 0;
function animate(timestamp) {
  requestAnimationFrame(animate);

  // testSpikeOverlayMesh();
  
  const dt = (timestamp - lastTime) / 1000;
  lastTime = timestamp;
  
  const samplesToAdvance = SAMPLES_PER_SECOND * dt * SWEEP_SPEED_FACTOR;
  let samplesRemaining = samplesToAdvance;
  
  while (samplesRemaining >= 1) {
    const vertexIndex = Math.floor(currentSample);
    // Compute the global (absolute) sample count.
    const globalSample = windowStartSample + currentSample;
    for (let obj of lineMeshes) {
      const positions = obj.mesh.geometry.attributes.position.array;
      const reveals = obj.mesh.geometry.attributes.revealTime.array;
      const dataIndex = (windowStartSample + vertexIndex) * CHANNELS + obj.actualChannel;
      const newData = dataArray[dataIndex] * obj.amplitudeScale;
      positions[vertexIndex * 3 + 1] = obj.yOffset + newData;
      // Store the absolute sample index when this vertex was updated.
      // reveals[vertexIndex] = globalSample;
      reveals[vertexIndex] = sampleTimes[globalSample];
    }
    currentSample++;
    samplesRemaining--;
    
    // Start a new sweep
    if (currentSample >= sweepSampleCount) {
      currentSample = 0;
      windowStartSample += sweepSampleCount;
      if (windowStartSample + sweepSampleCount > samplesPerChannel) {
        windowStartSample = 0;
      }
    }
  }
  
  for (let obj of lineMeshes) {
    obj.mesh.geometry.attributes.position.needsUpdate = true;
    obj.mesh.geometry.attributes.revealTime.needsUpdate = true;
  }
  
  const fraction = currentSample / (sweepSampleCount - 1);
  const xPos = fraction * viewWidth;
  cursorMesh.position.x = xPos;
  if (cursorGlow) {
    cursorGlow.position.x = xPos;
  }
  
  // Update spike overlay if enabled.
  if (showSpikes && spikeOverlayMesh) {
    updateSpikeOverlay();
  }
  
  updateRawSignalFades();
  renderer.render(scene, camera);
}

// === Main Entry Point ===
async function main() {
  setURLOptions();
  initThree();
  
  // Load raw data.
  await loadData();
  
  // If spike overlay is enabled, load spike data.
  if (showSpikes) {
    await loadSpikeData();
    // Create the overlay mesh and then it will be updated each frame.
    createSpikeOverlayMesh();
  }
  
  sweepSampleCount = Math.floor(SWEEP_DURATION * SAMPLES_PER_SECOND);
  console.log("Sweep sample count:", sweepSampleCount);
  windowStartSample = 0;
  currentSample = 0;
  
  createPersistentLines();
  createCursor();
  
  animate(0);
}

main();