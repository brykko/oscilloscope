import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.150.1/build/three.module.js';

// Constants for data and playback
const DATA_URL = '/probe1_nchan=369.bin';  // file in public folder
const SAMPLES_PER_SECOND = 30000;          // e.g., 30 kHz sampling rate
const SWEEP_SPEED_FACTOR = 0.02;            // slows playback down
const SWEEP_DURATION = 0.05;               // Sweep duration in seconds

const CHANNELS = 369;                      // Total channels in the source data

// Subset constants for plotting a subset of channels:
const FIRST_CHANNEL = 100;
const LAST_CHANNEL  = 300;
const PLOT_CHANNELS = LAST_CHANNEL - FIRST_CHANNEL + 1;

// A fraction used to compute amplitude scaling relative to viewHeight
const AMPLITUDE_SCALE_FACTOR = 0.000005;

let scene, camera, renderer;
let lineMeshes = [];   // Array of objects: { mesh, actualChannel, yOffset, amplitudeScale }
let cursorMesh;
let cursorGlow;        // New: the glow mesh for the cursor
let dataArray;         // Entire source data (dummy or loaded)
let totalSamples = 0;  // Total samples across all channels
let samplesPerChannel = 0;

// For the current sweep (a time window)
let windowStartSample = 0; // Starting sample index (per channel) for the current sweep
let sweepSampleCount = 0;  // Number of samples per sweep = SWEEP_DURATION * SAMPLES_PER_SECOND
let currentSample = 0;     // Current sample index within the sweep window

// We'll use these variables to track the view dimensions in pixels.
let viewWidth = window.innerWidth;
let viewHeight = window.innerHeight;

function initThree() {
  scene = new THREE.Scene();
  
  viewWidth = window.innerWidth;
  viewHeight = window.innerHeight;
  
  // Define the camera in pixel units:
  camera = new THREE.OrthographicCamera(0, viewWidth, viewHeight, 0, 1, 100);
  camera.position.z = 10;
  camera.lookAt(0, 0, 0);
  
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(viewWidth, viewHeight);
  document.body.appendChild(renderer.domElement);
  
  window.addEventListener('resize', onWindowResize, false);
}

function onWindowResize() {
  viewWidth = window.innerWidth;
  viewHeight = window.innerHeight;
  
  // Update camera boundaries to match the new window dimensions.
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
    // Set the glow's width and height relative to the new view dimensions.
    const glowWidth = 1; // constant width for glow
    cursorGlow.scale.set(glowWidth, viewHeight, 1);
  }
}

async function loadDummyData() {
  // For debugging: create a dummy data array (all zeros).
  samplesPerChannel = 7500;  // For the entire file.
  totalSamples = samplesPerChannel * CHANNELS;
  dataArray = new Float32Array(totalSamples);
  console.log(`Dummy data created: ${totalSamples} samples. Samples per channel: ${samplesPerChannel}`);
}

async function loadData() {
  const response = await fetch(DATA_URL);
  const arrayBuffer = await response.arrayBuffer();
  dataArray = new Float32Array(arrayBuffer);
  totalSamples = dataArray.length;
  samplesPerChannel = totalSamples / CHANNELS;
  console.log(`Data loaded: ${totalSamples} samples. Samples per channel: ${samplesPerChannel}`);
}

// Create a persistent (dynamic) line geometry for each plotted channel.
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
      
      void main() {
        // Compute horizontal distance from center (vUv.x ranges from 0 to 1).
        float dist = abs(vUv.x - 0.5) * 5.0; // 0 at center, 1 at edges.
        // Fade out the alpha smoothly.
        float alpha = 1.0 - smoothstep(0.0, 1.0, dist);
        gl_FragColor = vec4(glowColor, alpha * glowIntensity);
      }
    `,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false
  });
  
  const mesh = new THREE.Mesh(geometry, material);
  // Position the glow mesh so that its center aligns with the cursor.
  // The plane is centered at (0,0,0) by default so we shift it upward by half viewHeight.
  mesh.position.set(0, viewHeight / 2, 0);
  // Set renderOrder so that the glow appears just below the cursor.
  mesh.renderOrder = 1.5;
  scene.add(mesh);
  return mesh;
}

// Animation loop: update the vertex corresponding to the current sample index with new data.
// Previous vertices remain visible until overwritten as the cursor sweeps.
let lastTime = 0;
function animate(timestamp) {
  requestAnimationFrame(animate);
  
  const dt = (timestamp - lastTime) / 1000; // Delta time in seconds.
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
  
  // Update the cursor's x position based on currentSample.
  const fraction = currentSample / (sweepSampleCount - 1);
  const xPos = fraction * viewWidth;
  cursorMesh.position.x = xPos;
  // Also update the glow's position to match the cursor.
  if (cursorGlow) {
    cursorGlow.position.x = xPos;
  }
  
  renderer.render(scene, camera);
}

async function main() {
  initThree();
  await loadData();
  sweepSampleCount = Math.floor(SWEEP_DURATION * SAMPLES_PER_SECOND);
  console.log("Sweep sample count:", sweepSampleCount);
  windowStartSample = 0;
  currentSample = 0;
  
  createPersistentLines();
  createCursor();
  animate(0);
}

main();