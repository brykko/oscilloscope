import * as THREE from 'three';

// Constants for data and playback
const DATA_URL = './probe2_nchan=385.bin';  // file in public folder
const SAMPLES_PER_SECOND = 30000;           // e.g., 30 kHz sampling rate
const SWEEP_SPEED_FACTOR = 0.02;            // slows playback down
const SWEEP_DURATION = 0.05;                // Sweep duration in seconds
const CHANNELS = 385;                       // Total channels in the source data

// Subset constants for plotting a subset of channels:
const FIRST_CHANNEL = 100;
const LAST_CHANNEL  = 300;
const PLOT_CHANNELS = LAST_CHANNEL - FIRST_CHANNEL + 1;

// A fraction used to compute amplitude scaling relative to viewHeight
const AMPLITUDE_SCALE_FACTOR = 0.000001;

let scene, camera, renderer;
let lineMeshes = [];   // Array of objects: { mesh, actualChannel, yOffset, amplitudeScale }
let cursorMesh;
let cursorGlow;        // Glow mesh for the cursor
let dataArray;         // Raw signal data (Int16Array)
let totalSamples = 0;  // Total samples across all channels
let samplesPerChannel = 0;

// For the current sweep (a time window)
let windowStartSample = 0; // Starting sample index (per channel) for the current sweep
let sweepSampleCount = 0;  // Number of samples per sweep = SWEEP_DURATION * SAMPLES_PER_SECOND
let currentSample = 0;     // Current sample index within the sweep window

// View dimensions (in pixels)
let viewWidth = window.innerWidth;
let viewHeight = window.innerHeight;

// URL query switches
let showSpikes, showFactors;

function setURLOptions() {
  // Make sure to pass window.location.search to URLSearchParams!
  const queryParams = new URLSearchParams(window.location.search);
  showSpikes = (queryParams.get('showSpikes') ?? 'false') === 'true';
  showFactors = (queryParams.get('showFactors') ?? 'false') === 'true';
  console.log("showSpikes =", showSpikes);
  console.log("showFactors =", showFactors);
}

function initThree() {
  scene = new THREE.Scene();
  
  viewWidth = window.innerWidth;
  viewHeight = window.innerHeight;
  
  // Define the camera in pixel units.
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
  
  // Update camera boundaries.
  camera.left = 0;
  camera.right = viewWidth;
  camera.top = viewHeight;
  camera.bottom = 0;
  camera.updateProjectionMatrix();
  
  renderer.setSize(viewWidth, viewHeight);
  
  // Re-create persistent lines so that channel spacing and amplitude scaling update.
  for (let obj of lineMeshes) {
    scene.remove(obj.mesh);
  }
  lineMeshes = [];
  createPersistentLines();
  
  // Update cursor geometry.
  scene.remove(cursorMesh);
  createCursor();
  
  // Update the glow geometry scale.
  if (cursorGlow) {
    const glowWidth = 1; // constant width for glow
    cursorGlow.scale.set(glowWidth, viewHeight, 1);
  }
}

async function loadDummyData() {
  // For debugging: create a dummy data array (all zeros).
  samplesPerChannel = 7500;  // For the entire file.
  totalSamples = samplesPerChannel * CHANNELS;
  dataArray = new Int16Array(totalSamples);
  console.log(`Dummy data created: ${totalSamples} samples. Samples per channel: ${samplesPerChannel}`);
}

async function loadData() {
  const response = await fetch(DATA_URL);
  const arrayBuffer = await response.arrayBuffer();
  dataArray = new Int16Array(arrayBuffer);
  totalSamples = dataArray.length;
  samplesPerChannel = totalSamples / CHANNELS;
  console.log(`Data loaded: ${totalSamples} samples. Samples per channel: ${samplesPerChannel}`);
}

// --- Spike overlay variables and functions ---
let spikeTimes;      // Float32Array from spike_times.bin
let spikeChannels;   // Uint16Array from spike_channels.bin
let sampleTimes;     // Float32Array from sample_times.bin
let spikeOverlayMesh; // THREE.LineSegments for spike ticks

async function loadSpikeData() {
  // Load spike_times.bin
  let response = await fetch('./probe2_spike_times.bin');
  let buffer = await response.arrayBuffer();
  spikeTimes = new Float32Array(buffer);
  
  // Load spike_channels.bin
  response = await fetch('./probe2_spike_channels.bin');
  buffer = await response.arrayBuffer();
  spikeChannels = new Uint16Array(buffer);
  
  // Load sample_times.bin
  response = await fetch('./probe2_sample_times.bin');
  buffer = await response.arrayBuffer();
  sampleTimes = new Float32Array(buffer);
  
  console.log("Spike data loaded:",
    spikeTimes.length, "spike times,",
    spikeChannels.length, "spike channels,",
    sampleTimes.length, "sample times");
}

function createSpikeOverlay() {
  // Create an empty BufferGeometry for spike tick segments.
  const geometry = new THREE.BufferGeometry();
  // Initially no spikes; we'll update the attribute dynamically.
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
  const material = new THREE.LineBasicMaterial({ color: 0xffffff });
  spikeOverlayMesh = new THREE.LineSegments(geometry, material);
  // Render on top of the raw signal and cursor.
  spikeOverlayMesh.renderOrder = 3;
  scene.add(spikeOverlayMesh);
}

function updateSpikeOverlay() {
  if (!spikeTimes || spikeTimes.length === 0 || !sampleTimes || sampleTimes.length < windowStartSample + sweepSampleCount) return;
  
  // Window start and end times
  const currentSampleAbs = windowStartSample + currentSample;
  const currentTime = sampleTimes[currentSampleAbs];
  const startTime = sampleTimes[windowStartSample];
  const endTime = sampleTimes[windowStartSample + sweepSampleCount - 1];

  const overwriteTime = currentTime - SWEEP_DURATION;

  const verticalSpacing = viewHeight / (PLOT_CHANNELS - 1);
  const tickHeight = 10; // tick mark height in pixels
  const currentCursorX = cursorMesh.position.x;
  
  let positions = [];
  
  for (let i = 0; i < spikeTimes.length; i++) {
    let spikeTime = spikeTimes[i];
    if (spikeTime < overwriteTime || spikeTime > endTime) continue;
    let fraction = (spikeTime - startTime) / SWEEP_DURATION;
    if (fraction < 0){
        fraction = fraction + 1.0;
    }
    let spikeX = fraction * viewWidth;
    
    // Only display the spike if it has already been swept over.
    if (spikeTime > currentTime) continue;
    
    let spikeCh = spikeChannels[i];
    if (spikeCh < FIRST_CHANNEL || spikeCh > LAST_CHANNEL) continue;
    let index = spikeCh - FIRST_CHANNEL;
    let spikeY = index * verticalSpacing;
    
    // Add vertical tick for this spike.
    positions.push(spikeX, spikeY - tickHeight / 2, 0);
    positions.push(spikeX, spikeY + tickHeight / 2, 0);
  }
  
  spikeOverlayMesh.geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  spikeOverlayMesh.geometry.attributes.position.needsUpdate = true;
}

// --- End of Spike overlay functions ---

// Create persistent (dynamic) line geometry for each plotted channel.
function createPersistentLines() {
  lineMeshes = [];
  
  // x coordinates span the entire width of the view.
  const totalXRange = viewWidth;  // from 0 to viewWidth
  const xStep = totalXRange / (sweepSampleCount - 1);
  
  // Compute vertical spacing so that channels fill the view vertically.
  // Channel 0 at y=0, channel (PLOT_CHANNELS-1) at y = viewHeight.
  const verticalSpacing = viewHeight / (PLOT_CHANNELS - 1);
  
  // Amplitude scaling is a fraction of viewHeight.
  const amplitudeScale = AMPLITUDE_SCALE_FACTOR * viewHeight;
  
  for (let i = 0; i < PLOT_CHANNELS; i++) {
    const actualChannel = FIRST_CHANNEL + i;
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(sweepSampleCount * 3);
    
    // Baseline y: channel 0 at bottom, channel (PLOT_CHANNELS-1) at top.
    const yOffset = i * verticalSpacing;
    
    // Precompute x coordinates and set initial y to the baseline.
    for (let j = 0; j < sweepSampleCount; j++) {
      const x = j * xStep;  // x goes from 0 to viewWidth
      positions[j * 3 + 0] = x;
      positions[j * 3 + 1] = yOffset; // initial baseline y
      positions[j * 3 + 2] = 0;
    }
    
    const attribute = new THREE.BufferAttribute(positions, 3);
    attribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', attribute);
    geometry.setDrawRange(0, sweepSampleCount);
    
    const material = new THREE.LineBasicMaterial({ color: 0x999999 });
    const line = new THREE.Line(geometry, material);
    // Draw the line below the cursor.
    line.renderOrder = 1;
    scene.add(line);
    lineMeshes.push({ mesh: line, actualChannel: actualChannel, yOffset: yOffset, amplitudeScale: amplitudeScale });
  }
}

// Create a vertical cursor spanning the full height (0 to viewHeight).
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
  // Draw the cursor on top.
  cursorMesh.renderOrder = 2;
  scene.add(cursorMesh);
  
  // Create the glow effect for the cursor using a custom shader.
  if (cursorGlow) scene.remove(cursorGlow);
  cursorGlow = createCursorGlow();
}

// Create a glow effect for the cursor using a custom shader (no external images).
// (Later you can modify the shader to be asymmetric as desired.)
function createCursorGlow() {
  const glowWidth = 50;  // Width of the glow effect.
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
      
      // Asymmetric glow: sharper on the leading side (vUv.x > 0.5) and more diffuse on trailing side.
      void main() {
        float alpha;
        if (vUv.x < 0.5) {
          float d = (0.5 - vUv.x) / 0.5;
          alpha = 1.0 - pow(d, 0.5);
        } else {
          float d = (vUv.x - 0.5) / 0.5;
          alpha = 1.0 - pow(d, 2.0);
        }
        gl_FragColor = vec4(glowColor, alpha * glowIntensity);
      }
    `,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false
  });
  
  const mesh = new THREE.Mesh(geometry, material);
  // Position the glow mesh so that its center aligns with the cursor.
  mesh.position.set(0, viewHeight / 2, 0);
  // Set renderOrder so that the glow appears just below the cursor.
  mesh.renderOrder = 1.5;
  scene.add(mesh);
  return mesh;
}

// Animation loop: update the persistent raw signal geometries and the spike overlay.
let lastTime = 0;
function animate(timestamp) {
  requestAnimationFrame(animate);
  
  const dt = (timestamp - lastTime) / 1000; // seconds
  lastTime = timestamp;
  
  // Determine how many samples to advance this frame.
  const samplesToAdvance = SAMPLES_PER_SECOND * dt * SWEEP_SPEED_FACTOR;
  let samplesRemaining = samplesToAdvance;
  
  while (samplesRemaining >= 1) {
    const vertexIndex = Math.floor(currentSample);
    // Update the vertex at vertexIndex for each channel.
    for (let obj of lineMeshes) {
      const actualChannel = obj.actualChannel;
      const positions = obj.mesh.geometry.attributes.position.array;
      const dataIndex = (windowStartSample + vertexIndex) * CHANNELS + actualChannel;
      const newData = dataArray[dataIndex] * obj.amplitudeScale;
      // Update y coordinate: baseline plus data amplitude.
      positions[vertexIndex * 3 + 1] = obj.yOffset + newData;
    }
    currentSample++;
    samplesRemaining--;
    
    // If we've reached the end of the sweep window, reset and move the window forward.
    if (currentSample >= sweepSampleCount) {
      currentSample = 0;
      windowStartSample += sweepSampleCount;
      if (windowStartSample + sweepSampleCount > samplesPerChannel) {
        windowStartSample = 0;
      }
      // New data will overwrite the existing vertices.
    }
  }
  
  // Mark each channel's geometry as needing update.
  for (let obj of lineMeshes) {
    obj.mesh.geometry.attributes.position.needsUpdate = true;
  }
  
  // Update the cursor's x position.
  const fraction = currentSample / (sweepSampleCount - 1);
  const xPos = fraction * viewWidth;
  cursorMesh.position.x = xPos;
  if (cursorGlow) {
    cursorGlow.position.x = xPos;
  }

  if (showSpikes && spikeOverlayMesh) {
    updateSpikeOverlay();
  }  
  
  renderer.render(scene, camera);
}

async function main() {
  setURLOptions();
  initThree();
  
  // Load raw data.
  await loadData();
  
  // If using spike overlay, load spike data.
  if (showSpikes) {
    await loadSpikeData();
    createSpikeOverlay();
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