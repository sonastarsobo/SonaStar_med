// Reusable 3D viewer: holds several models at once (one per key, e.g. per body system).
// Rendering only; no database logic here.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { clone as cloneModelScene } from "three/addons/utils/SkeletonUtils.js"; // [CHANGE 1] skeleton-safe cloning of cached scenes

// Studio lighting levels: raise/lower these to taste.
const STUDIO = {
  ambient: 0.9,
  key: 1.0,
  fill: 0.6,
  rim: 0.4,
  headlight: 0.8,
  env: 0.7,
  exposure: 0.9,
};

// =====================================================================================
// [CHANGE 2] Model cache, shared by every viewer on the page.
//
// Layer 1 (memory): each model URL is downloaded and parsed at most once per page.
//   Concurrent addModel() calls for the same URL share one in-flight load. Every
//   addModel() gets its own cloned object tree; geometry and textures are shared.
//
// Layer 2 (persistent, this browser only): the downloaded file is kept in the browser's
//   Cache Storage. Your screens are separate HTML pages, so the memory layer is wiped on
//   every navigation; this layer is what avoids re-downloading after a page load.
//   Before reusing a saved copy, a HEAD request (headers only, no file body) checks that
//   the file in Supabase has not changed (Last-Modified / Content-Length).
//   If Cache Storage is unavailable (non-secure origin, private mode, quota) everything
//   silently falls back to a normal download, exactly like before.
// =====================================================================================
const MODEL_CACHE = {
  persistent: true, // set to false to disable the browser-side saved copies
  storeName: "anatomy-viewer-models-v1", // rename to throw every saved copy away
  // Used only when the server gives no Last-Modified/Content-Length to compare
  maxAgeWithoutValidatorsMs: 12 * 60 * 60 * 1000,
};

const gltfLoader = new GLTFLoader();
const gltfCache = new Map(); // cacheKey -> { key, promise, gltf, users }

// Same file -> same key. Supabase signed URLs carry a fresh ?token=... each time they
// are created, so the token is dropped from the key (the download still uses the full URL).
function modelCacheKey(url) {
  try {
    const base = typeof location !== "undefined" ? location.href : undefined;
    const u = new URL(url, base);
    if (u.pathname.includes("/storage/v1/object/sign/"))
      u.searchParams.delete("token");
    u.hash = "";
    return u.href;
  } catch {
    return String(url);
  }
}

async function openModelStore() {
  if (!MODEL_CACHE.persistent || typeof caches === "undefined") return null;
  try {
    return await caches.open(MODEL_CACHE.storeName);
  } catch {
    return null;
  }
}

// true = saved copy is current, false = changed/unknown file (download again), null = cannot tell
async function savedCopyIsCurrent(url, saved) {
  let head;
  try {
    head = await fetch(url, { method: "HEAD", cache: "no-store" });
  } catch {
    // offline: the saved copy is the best we have; any other failure (e.g. CORS): fall back to its age
    return typeof navigator !== "undefined" && navigator.onLine === false
      ? true
      : null;
  }
  if (head.status === 405 || head.status === 501) return null; // HEAD not supported
  if (!head.ok) return false; // e.g. deleted file or expired link: let the download report it
  // Compare the strongest validator both sides have. Content-Length is only a last resort: a
  // compressed download reports a different length than HEAD, which made every saved copy look outdated.
  const etag = (v) => (v || "").replace(/^W\//, "");
  const pair = [
    [etag(head.headers.get("etag")), etag(saved.headers.get("x-model-etag"))],
    [
      head.headers.get("last-modified"),
      saved.headers.get("x-model-last-modified"),
    ],
    [head.headers.get("content-length"), saved.headers.get("x-model-length")],
  ].find(([now, then]) => now && then);
  if (!pair) return null;
  return pair[0] === pair[1];
}

// Resolves { buffer, fromStore, store }. Throws on HTTP/network failure.
async function fetchModelBuffer(url, key, { useSaved = true } = {}) {
  const store = await openModelStore();
  let outdated = false;
  if (store && useSaved) {
    try {
      const saved = await store.match(key);
      if (saved) {
        outdated = true; // unless proven current below
        const current = await savedCopyIsCurrent(url, saved);
        const savedAt = Number(saved.headers.get("x-model-saved-at")) || 0;
        if (
          current === true ||
          (current === null &&
            Date.now() - savedAt < MODEL_CACHE.maxAgeWithoutValidatorsMs)
        )
          return { buffer: await saved.arrayBuffer(), fromStore: true, store };
      }
    } catch {
      // any Cache Storage problem: fall through to a normal download
    }
  }
  // An outdated saved copy means the file changed: ask the server instead of trusting the browser's HTTP cache
  const res = await fetch(url, outdated ? { cache: "no-cache" } : undefined);
  if (!res.ok) throw new Error(`HTTP ${res.status} while downloading model`);
  const buffer = await res.arrayBuffer();
  if (store) {
    // Response() copies the bytes, so `buffer` stays usable for parsing
    store
      .put(
        key,
        new Response(buffer, {
          headers: {
            "content-type":
              res.headers.get("content-type") || "application/octet-stream",
            "x-model-etag": res.headers.get("etag") || "",
            "x-model-last-modified": res.headers.get("last-modified") || "",
            "x-model-length": res.headers.get("content-length") || "",
            "x-model-saved-at": String(Date.now()),
          },
        }),
      )
      .catch(() => {}); // quota etc.: simply not saved
  }
  return { buffer, fromStore: false, store };
}

function describeModel(key, gltf, fromStore) {
  const json = gltf.parser?.json || {};
  const external = [...(json.buffers || []), ...(json.images || [])].filter(
    (r) => r.uri && !r.uri.startsWith("data:"),
  ).length;
  let skinned = 0;
  gltf.scene.traverse((o) => {
    if (o.isSkinnedMesh) skinned++;
  });
  const file = key.split("?")[0].split("/").pop();
  console.info(
    `[viewer] ${file} ${fromStore ? "reused from this browser's saved copy" : "downloaded"}` +
      ` (external files: ${external}, skinned meshes: ${skinned}, animations: ${gltf.animations.length})`,
  );
  if (external)
    console.warn(
      `[viewer] ${file} references ${external} external file(s); they are loaded relative to the model URL and are not saved by the model cache.`,
    );
}

// One cache entry per file. A failed load removes its entry so the next call retries.
function loadGLTFCached(url) {
  const key = modelCacheKey(url);
  const existing = gltfCache.get(key);
  if (existing) return existing;

  const entry = { key, promise: null, gltf: null, users: 0 };
  const manager = gltfLoader.manager; // keeps THREE.DefaultLoadingManager progress hooks working
  const resourcePath = THREE.LoaderUtils.extractUrlBase(url); // same base GLTFLoader.load() would use
  manager.itemStart(url);

  entry.promise = (async () => {
    let got = await fetchModelBuffer(url, key);
    let gltf;
    try {
      gltf = await gltfLoader.parseAsync(got.buffer, resourcePath);
    } catch (err) {
      if (!got.fromStore) throw err;
      // saved copy was unreadable: throw it away and download a fresh one
      await got.store?.delete(key).catch(() => {});
      got = await fetchModelBuffer(url, key, { useSaved: false });
      gltf = await gltfLoader.parseAsync(got.buffer, resourcePath);
    }
    entry.gltf = gltf;
    describeModel(key, gltf, got.fromStore);
    return gltf;
  })().then(
    (gltf) => {
      manager.itemEnd(url);
      return gltf;
    },
    (err) => {
      if (gltfCache.get(key) === entry) gltfCache.delete(key); // never cache a failure
      manager.itemError(url);
      manager.itemEnd(url);
      throw err;
    },
  );

  gltfCache.set(key, entry);
  return entry;
}

function disposeCachedGLTF(gltf) {
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    o.geometry?.dispose();
    (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
      if (!m) return;
      Object.values(m).forEach((v) => {
        if (v && v.isTexture) v.dispose();
      });
      m.dispose();
    });
  });
}

// Optional: start downloading a model before a viewer needs it (e.g. on the dashboard).
// Resolves when the file is ready; rejects if it cannot be loaded (callers should .catch()).
export function preloadModel(url) {
  return loadGLTFCached(url).promise.then(() => undefined);
}

// Optional: free memory held by cached models that no viewer is showing.
// { persistent: true } also deletes this browser's saved copies (next visit downloads again).
export async function clearModelCache({ persistent = false } = {}) {
  gltfCache.forEach((entry, key) => {
    if (entry.gltf && entry.users === 0) {
      disposeCachedGLTF(entry.gltf);
      gltfCache.delete(key);
    }
  });
  if (persistent && typeof caches !== "undefined") {
    try {
      await caches.delete(MODEL_CACHE.storeName);
    } catch {
      // ignore
    }
  }
}

const disposedError = () =>
  Object.assign(
    new Error("Viewer was disposed before the model finished loading."),
    {
      name: "AbortError",
    },
  );

// autoSelect:false = clicks are only reported (the caller draws any highlight itself, e.g. with setMarks). onFrame runs every rendered frame.
export function createViewer(
  container,
  {
    onSelect = () => {},
    onHover = () => {},
    onBoxSelect = () => {},
    autoSelect = true,
    onFrame = null,
    orbitKeys = true, // false: the page handles keyboard camera control itself (Learn mode)
  } = {},
) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = STUDIO.exposure;
  // Render on demand: a frame is drawn only after something changed (camera, models, materials, size)
  let needsRender = true;
  const invalidate = () => {
    needsRender = true;
  };
  // GLB materials are PBR: they need an environment map to look like they do in glTF viewers
  const pmrem = new THREE.PMREMGenerator(renderer),
    room = new RoomEnvironment();
  scene.environment = pmrem.fromScene(room, 0.04).texture;
  pmrem.dispose(); // the environment texture stays; the generator's own GPU buffers are freed
  room.traverse((o) => {
    o.geometry?.dispose();
    o.material?.dispose?.();
  });
  renderer.localClippingEnabled = true; // needed for section (cut) planes
  const canvas = renderer.domElement;
  canvas.tabIndex = 0; // focusable so arrow keys can pan
  container.appendChild(canvas);

  // Three-point studio rig + a soft headlight that follows the camera, so every angle (even inside the skull) stays evenly lit
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8890a0, STUDIO.ambient));
  const addDir = (intensity, x, y, z, color = 0xffffff) => {
    const l = new THREE.DirectionalLight(color, intensity);
    l.position.set(x, y, z);
    scene.add(l);
    return l;
  };
  addDir(STUDIO.key, 4, 6, 5, 0xfff4e6); // key: warm, upper right front
  addDir(STUDIO.fill, -5, 2, 3, 0xe8f0ff); // fill: cool, left
  addDir(STUDIO.rim, 0, 4, -6); // rim: from behind
  scene.add(camera);
  const headlight = new THREE.DirectionalLight(0xffffff, STUDIO.headlight);
  headlight.position.set(0, 0, 0);
  headlight.target.position.set(0, 0, -1);
  camera.add(headlight, headlight.target);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  if (orbitKeys) {
    controls.listenToKeyEvents(canvas);
    controls.keyPanSpeed = 20; // arrow keys pan
  }

  const raycaster = new THREE.Raycaster(),
    pointer = new THREE.Vector2();
  const models = new Map(); // key -> root object
  const nameMaps = new Map(); // key -> Map(original node name -> object)
  const originals = new Map(); // mesh -> original material
  const modelSources = new Map(); // [CHANGE 3] key -> cache entry the model was cloned from (for reference counting)
  const markState = new Map(); // mesh -> saved material values (moved up so removeModel can clean it)
  let destroyed = false; // [CHANGE 7] set by dispose()
  let selected = [],
    home = null,
    anim = null,
    visibleKeys = null; // visibleKeys: Set of model keys, or null = all
  const isOn = (k) => !visibleKeys || visibleKeys.has(k);
  controls.addEventListener("start", () => {
    anim = null;
  }); // user input cancels a running camera move
  controls.addEventListener("change", invalidate); // fired while the camera moves, including damping

  // Smooth camera move (ease in-out) to a new position and target
  function goTo(pos, target, ms = 650) {
    const d = pos.distanceTo(target);
    camera.near = Math.min(camera.near, d / 100);
    camera.far = Math.max(camera.far, d * 100);
    camera.updateProjectionMatrix();
    anim = {
      t: performance.now(),
      ms,
      p0: camera.position.clone(),
      p1: pos.clone(),
      g0: controls.target.clone(),
      g1: target.clone(),
    };
  }
  // Section (dissection cut): one clipping plane shared by every material
  const sectionPlane = new THREE.Plane(),
    sectionPlanes = [sectionPlane];
  let sectionOn = false;
  const applySection = () => {
    const val = sectionOn ? sectionPlanes : null;
    const sideOf = (m) =>
      sectionOn ? THREE.DoubleSide : (m.userData.baseSide ?? THREE.FrontSide);
    models.forEach((root) =>
      root.traverse((o) => {
        if (o.isMesh) {
          o.material.clippingPlanes = val;
          o.material.side = sideOf(o.material);
        }
      }),
    );
    originals.forEach((m) => {
      m.clippingPlanes = val;
      m.side = sideOf(m);
    });
  };

  function resize() {
    const w = container.clientWidth || 1,
      h = container.clientHeight || 1;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    invalidate(); // resizing clears the canvas
  }
  const resizeObserver = new ResizeObserver(resize); // [CHANGE 7] kept so dispose() can disconnect it
  resizeObserver.observe(container);
  resize();

  const keyOf = (o) => {
    for (; o; o = o.parent)
      if (o.userData.modelKey !== undefined) return o.userData.modelKey;
    return null;
  };
  const visibleDeep = (o) => {
    for (; o && o !== scene; o = o.parent) if (!o.visible) return false;
    return true;
  };
  const nameOf = (o) => o.userData.name || o.name;

  // Camera framing of every currently visible model
  function frameVisible(animate = false) {
    const box = new THREE.Box3();
    models.forEach((root) => {
      if (root.visible) box.union(new THREE.Box3().setFromObject(root));
    });
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3()),
      c = box.getCenter(new THREE.Vector3());
    const dist =
      (Math.max(size.x, size.y, size.z) /
        (2 * Math.tan((camera.fov * Math.PI) / 360))) *
        1.5 || 3;
    camera.near = dist / 100;
    camera.far = dist * 100;
    camera.updateProjectionMatrix();
    const pos = new THREE.Vector3(c.x, c.y, c.z + dist);
    home = { pos: pos.clone(), target: c.clone() };
    if (animate) goTo(pos, c);
    else {
      camera.position.copy(pos);
      controls.target.copy(c);
      controls.update();
    }
  }

  // [CHANGE 4] Geometry and textures now belong to the shared cache (another viewer, or the
  // same model added again, may be using them), so only this model's own cloned materials
  // are disposed here. Selection/highlight/mark state pointing at the removed model is cleared.
  function removeModel(key) {
    const root = models.get(key);
    if (!root) return;
    if (selected.length) selected = selected.filter((o) => keyOf(o) !== key);
    scene.remove(root);
    root.traverse((o) => {
      if (!o.isMesh) return;
      if (originals.has(o)) {
        o.material.dispose(); // highlight copy
        o.material = originals.get(o);
        originals.delete(o);
      }
      markState.delete(o);
      (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) =>
        m.dispose(),
      );
    });
    models.delete(key);
    nameMaps.delete(key);
    const src = modelSources.get(key);
    if (src) {
      src.users = Math.max(0, src.users - 1);
      modelSources.delete(key);
    }
  }
  function clearModels() {
    selected = [];
    [...models.keys()].forEach(removeModel); // removeModel restores + disposes highlight materials itself
    originals.clear();
  }

  // Adds a model under `key`; resolves when loaded, rejects with a readable Error.
  // [CHANGE 5] Loads through the shared cache and clones the cached scene instead of downloading again.
  function addModel(
    key,
    url,
    { colorFor = null, matte = false, frontOnly = false } = {},
  ) {
    if (destroyed) return Promise.reject(disposedError());
    const entry = loadGLTFCached(url);
    return entry.promise.then(
      (gltf) => {
        if (destroyed) throw disposedError();
        removeModel(key);
        const root = cloneModelScene(gltf.scene); // own object tree; skinned meshes get their own skeletons
        root.userData.modelKey = key;
        root.visible = isOn(key);
        // Clean up materials: this GLB ships white emissive on every material, which washes the model out to flat white.
        root.traverse((o) => {
          if (!o.isMesh) return;
          o.material = o.material.clone(); // per-model copy: the cached original is never modified
          const m = o.material;
          if (
            m.emissive &&
            !m.emissiveMap &&
            m.emissive.r === 1 &&
            m.emissive.g === 1 &&
            m.emissive.b === 1
          )
            m.emissive.set(0x000000); // only remove the washed-out white glow
          if (matte) {
            // optional: force a clean matte look (no plastic gloss or icy reflections)
            if ("metalness" in m) m.metalness = 0;
            if ("clearcoat" in m) m.clearcoat = 0;
            if ("roughness" in m)
              m.roughness = Math.max(m.roughness ?? 0.6, 0.6);
          }
          m.clippingPlanes = sectionOn ? sectionPlanes : null;
          m.envMapIntensity = STUDIO.env;
          m.userData.baseSide = frontOnly ? THREE.FrontSide : m.side; // default: keep what the GLB asks for (open sheets need both sides); frontOnly avoids speckles on stacked layers
          m.side = sectionOn ? THREE.DoubleSide : m.userData.baseSide;
          const col = colorFor?.(nameOf(o));
          if (col) m.color.set(col);
        });
        const map = new Map();
        root.traverse((o) => {
          const n = nameOf(o);
          if (n && !map.has(n)) map.set(n, o);
        });
        console.info(`[viewer] "${key}" loaded: ${map.size} named parts`);
        scene.add(root);
        invalidate();
        models.set(key, root);
        nameMaps.set(key, map);
        entry.users++;
        modelSources.set(key, entry);
        frameVisible();
        return root;
      },
      (err) => {
        if (err?.name === "AbortError") throw err;
        console.warn(`[viewer] "${key}" failed to load from ${url}:`, err);
        throw new Error(
          "Could not load 3D model. Check the file exists in Storage and is a valid GLB/GLTF.",
        );
      },
    );
  }

  // Show several models at once. keys: array/Set of model keys, or null for all.
  function setVisibleModels(keys) {
    visibleKeys = keys ? new Set(keys) : null;
    models.forEach((root, k) => {
      root.visible = isOn(k);
    });
    const still = selected.filter((o) => isOn(keyOf(o)));
    if (still.length !== selected.length) select(still);
    frameVisible(true);
  }

  // Smoothly move the camera to frame the selected parts (keeps the current viewing direction)
  function focusSelected() {
    if (!selected.length) return;
    const box = new THREE.Box3();
    selected.forEach((o) => box.union(new THREE.Box3().setFromObject(o)));
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3()),
      c = box.getCenter(new THREE.Vector3());
    const dist =
      (Math.max(size.x, size.y, size.z) /
        (2 * Math.tan((camera.fov * Math.PI) / 360))) *
        1.6 || 1;
    const dir = camera.position.clone().sub(controls.target).normalize();
    goTo(c.clone().addScaledVector(dir, dist), c); // smooth zoom to the selection
  }

  function setHighlight(mesh, on) {
    if (!mesh.isMesh) return;
    if (on) {
      originals.set(mesh, mesh.material);
      const m = mesh.material.clone();
      m.clippingPlanes = mesh.material.clippingPlanes;
      if (m.emissive) m.emissive.set(0x8b5cf6);
      mesh.material = m;
    } else if (originals.has(mesh)) {
      mesh.material.dispose();
      mesh.material = originals.get(mesh);
      originals.delete(mesh);
    }
  }
  function select(objs) {
    // one object, an array, or null
    selected.forEach((o) => o.traverse((x) => setHighlight(x, false)));
    selected = objs ? [].concat(objs) : [];
    selected.forEach((o) => o.traverse((x) => setHighlight(x, true)));
    invalidate();
  }

  function pick(e) {
    const r = canvas.getBoundingClientRect();
    pointer.set(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster
      .intersectObjects(
        [...models.values()].filter((m) => m.visible),
        true,
      )
      .find(
        (h) =>
          visibleDeep(h.object) &&
          !(sectionOn && sectionPlane.distanceToPoint(h.point) < 0),
      ); // ignore cut-away parts
    if (!hit) return null;
    const names = []; // hit object and its ancestors, so grouped models still match
    for (let o = hit.object; o && o !== scene; o = o.parent) {
      const n = nameOf(o);
      if (n) names.push(n);
    }
    return {
      hit: hit.object,
      names,
      key: keyOf(hit.object),
      x: e.clientX - r.left,
      y: e.clientY - r.top,
    };
  }

  canvas.addEventListener("pointerdown", (e) => {
    canvas._down = [e.clientX, e.clientY];
    canvas.focus({ preventScroll: true });
  });
  canvas.addEventListener("pointerup", (e) => {
    const d = canvas._down;
    if (!d || Math.hypot(e.clientX - d[0], e.clientY - d[1]) > 4) return; // ignore drags
    const p = pick(e),
      add = e.ctrlKey || e.shiftKey || e.metaKey; // Ctrl/Shift/Cmd + click = add to selection
    if (!p) {
      if (!add) {
        select(null);
        onSelect([], null, null, false);
      }
      return;
    }
    if (!add && autoSelect) select(p.hit);
    onSelect(p.names, p.hit, p.key, add);
  });
  // ---- Ctrl + left-drag: marquee (box) selection ----
  const marq = document.createElement("div");
  Object.assign(marq.style, {
    position: "absolute",
    border: "1px dashed #a78bfa",
    background: "rgba(139,92,246,.15)",
    pointerEvents: "none",
    display: "none",
    zIndex: 4,
  });
  container.appendChild(marq);
  let drag = null;
  canvas.addEventListener(
    "pointerdown",
    (e) => {
      if (e.button !== 0 || !(e.ctrlKey || e.metaKey)) return;
      controls.enabled = false; // otherwise Ctrl + drag would pan the camera
      const r = canvas.getBoundingClientRect();
      drag = {
        x0: e.clientX - r.left,
        y0: e.clientY - r.top,
        x1: e.clientX - r.left,
        y1: e.clientY - r.top,
        moved: false,
      };
    },
    { capture: true },
  );
  // [CHANGE 7] window listeners are named so dispose() can remove them
  function onWindowPointerMove(e) {
    if (!drag) return;
    const r = canvas.getBoundingClientRect();
    drag.x1 = e.clientX - r.left;
    drag.y1 = e.clientY - r.top;
    if (Math.hypot(drag.x1 - drag.x0, drag.y1 - drag.y0) > 4) drag.moved = true;
    if (!drag.moved) return;
    Object.assign(marq.style, {
      display: "block",
      left: Math.min(drag.x0, drag.x1) + "px",
      top: Math.min(drag.y0, drag.y1) + "px",
      width: Math.abs(drag.x1 - drag.x0) + "px",
      height: Math.abs(drag.y1 - drag.y0) + "px",
    });
  }
  function onWindowPointerUp(e) {
    if (!drag) return;
    const d = drag;
    drag = null;
    controls.enabled = true;
    marq.style.display = "none";
    if (d.moved) onBoxSelect(meshesInRect(d), e.shiftKey); // Ctrl+Shift+drag adds to the current selection
  }
  window.addEventListener("pointermove", onWindowPointerMove);
  window.addEventListener("pointerup", onWindowPointerUp);
  // Every visible mesh whose centre falls inside the rectangle (parts behind others are included)
  function meshesInRect(d) {
    const r = canvas.getBoundingClientRect();
    const xmin = Math.min(d.x0, d.x1),
      xmax = Math.max(d.x0, d.x1),
      ymin = Math.min(d.y0, d.y1),
      ymax = Math.max(d.y0, d.y1);
    const out = [],
      v = new THREE.Vector3(),
      box = new THREE.Box3();
    models.forEach((root, key) => {
      if (!root.visible) return;
      root.traverse((o) => {
        if (!o.isMesh || !visibleDeep(o)) return;
        box.setFromObject(o);
        if (box.isEmpty()) return;
        box.getCenter(v);
        if (sectionOn && sectionPlane.distanceToPoint(v) < 0) return;
        v.project(camera);
        if (v.z < -1 || v.z > 1) return;
        const sx = ((v.x + 1) / 2) * r.width,
          sy = ((1 - v.y) / 2) * r.height;
        if (sx < xmin || sx > xmax || sy < ymin || sy > ymax) return;
        const names = [];
        for (let p = o; p && p !== scene; p = p.parent) {
          const n = nameOf(p);
          if (n) names.push(n);
        }
        out.push({ key, names });
      });
    });
    return out;
  }

  let hoverQueued = false;
  canvas.addEventListener("pointermove", (e) => {
    if (e.buttons !== 0 || hoverQueued || !models.size) return;
    hoverQueued = true;
    requestAnimationFrame(() => {
      hoverQueued = false;
      if (destroyed) return;
      const p = pick(e);
      onHover(p ? p.names : [], p ? p.x : 0, p ? p.y : 0, p?.key ?? null);
    });
  });
  canvas.addEventListener("pointerleave", () => onHover([], 0, 0, null));

  let rafId = 0; // [CHANGE 7] so dispose() can stop the render loop
  (function loop() {
    if (destroyed) return;
    rafId = requestAnimationFrame(loop);
    if (anim) {
      const u = Math.min(1, (performance.now() - anim.t) / anim.ms),
        e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
      camera.position.lerpVectors(anim.p0, anim.p1, e);
      controls.target.lerpVectors(anim.g0, anim.g1, e);
      if (u >= 1) anim = null;
      needsRender = true;
    }
    controls.update(); // emits "change" (-> invalidate) only when the camera actually moved
    if (!needsRender) return;
    needsRender = false;
    renderer.render(scene, camera);
    onFrame?.();
  })();

  const find = (names, key) =>
    names.map((n) => nameMaps.get(key)?.get(n)).filter(Boolean);
  const findItems = (items) =>
    items.flatMap(({ key, names }) => find(names, key));

  // ---- Coloured marks (assessment mode): paint parts in any colour, optionally ghost everything else ----
  function restoreMarks() {
    markState.forEach((s, mesh) => {
      const m = mesh.material;
      if (!m) return;
      if (m.emissive) m.emissive.setHex(s.e);
      m.emissiveIntensity = s.ei;
      m.opacity = s.op;
      m.transparent = s.tr;
      m.depthWrite = s.dw;
    });
    markState.clear();
  }
  function touch(mesh) {
    const m = mesh.material;
    if (!markState.has(mesh))
      markState.set(mesh, {
        e: m.emissive ? m.emissive.getHex() : 0,
        ei: m.emissiveIntensity ?? 1,
        op: m.opacity,
        tr: m.transparent,
        dw: m.depthWrite,
      });
    return m;
  }
  // items: [{ key, names, color }]. Returns how many meshes were marked.
  function setMarks(items, { ghost = false } = {}) {
    restoreMarks();
    const marked = new Map();
    items.forEach(({ key, names, color }) =>
      find(names, key).forEach((o) =>
        o.traverse((x) => {
          if (x.isMesh) marked.set(x, color || "#ff9f1c");
        }),
      ),
    );
    if (ghost && marked.size)
      models.forEach((root) =>
        root.traverse((o) => {
          if (o.isMesh && !marked.has(o)) {
            const m = touch(o);
            m.transparent = true;
            m.opacity = 0.12;
            m.depthWrite = false;
          }
        }),
      );
    marked.forEach((color, mesh) => {
      const m = touch(mesh);
      if (m.emissive) {
        m.emissive.set(color);
        m.emissiveIntensity = 0.7;
      }
    });
    return marked.size;
  }
  const boxOf = (objs) => {
    const b = new THREE.Box3();
    objs.forEach((o) => b.union(new THREE.Box3().setFromObject(o)));
    return b;
  };
  // Smoothly frame the given parts (keeps the viewing direction)
  function frameItems(items) {
    const objs = findItems(items);
    if (!objs.length) return false;
    const box = boxOf(objs);
    if (box.isEmpty()) return false;
    const size = box.getSize(new THREE.Vector3()),
      c = box.getCenter(new THREE.Vector3());
    const dist =
      (Math.max(size.x, size.y, size.z) /
        (2 * Math.tan((camera.fov * Math.PI) / 360))) *
        2.2 || 1;
    const dir = camera.position.clone().sub(controls.target).normalize();
    goTo(c.clone().addScaledVector(dir, dist), c);
    return true;
  }
  // Screen position (px, relative to the viewer) of the centre of some parts; null if hidden/behind the camera
  function screenPos(items) {
    const objs = findItems(items);
    if (!objs.length) return null;
    const box = boxOf(objs);
    if (box.isEmpty()) return null;
    const v = box.getCenter(new THREE.Vector3()).project(camera);
    if (v.z < -1 || v.z > 1) return null;
    return {
      x: ((v.x + 1) / 2) * container.clientWidth,
      y: ((1 - v.y) / 2) * container.clientHeight,
    };
  }

  // [CHANGE 7] Tear the viewer down (new, optional). Call it if a page ever replaces one
  // viewer with another without reloading; downloaded models stay cached for reuse.
  function dispose() {
    if (destroyed) return;
    destroyed = true;
    cancelAnimationFrame(rafId);
    resizeObserver.disconnect();
    window.removeEventListener("pointermove", onWindowPointerMove);
    window.removeEventListener("pointerup", onWindowPointerUp);
    controls.dispose();
    restoreMarks();
    clearModels();
    scene.environment?.dispose();
    renderer.dispose();
    renderer.forceContextLoss(); // frees the WebGL context now (browsers allow only a few)
    canvas.remove();
    marq.remove();
  }

  const api = {
    requestRender: invalidate, // for callers that change something the viewer cannot see (e.g. overlay pins)
    addModel,
    clearModels,
    setVisibleModels,
    focusSelected,
    setMarks,
    clearMarks: restoreMarks,
    frameItems,
    screenPos,
    dispose,
    getCameraState: () => ({
      pos: camera.position.toArray().map((n) => +n.toFixed(4)),
      target: controls.target.toArray().map((n) => +n.toFixed(4)),
    }),
    setCameraState(st, animate = true) {
      if (!st?.pos || !st?.target) return false;
      const p = new THREE.Vector3(...st.pos),
        t = new THREE.Vector3(...st.target);
      if (animate) goTo(p, t);
      else {
        camera.position.copy(p);
        controls.target.copy(t);
        controls.update();
      }
      return true;
    },
    hasModels: () => models.size > 0,
    resetCamera() {
      if (home) goTo(home.pos, home.target);
    },
    // Orbit around the target, like a left-drag. Radians: dTheta = left/right, dPhi = up/down.
    rotateBy(dTheta, dPhi = 0) {
      anim = null;
      const off = camera.position.clone().sub(controls.target);
      const s = new THREE.Spherical().setFromVector3(off);
      s.theta += dTheta;
      s.phi = Math.min(Math.PI - 0.01, Math.max(0.01, s.phi + dPhi));
      off.setFromSpherical(s);
      camera.position.copy(controls.target).add(off);
      camera.lookAt(controls.target);
      controls.update();
    },
    // Slide camera and target together, like a right-drag. dx/dy are fractions of the view height.
    panBy(dx, dy) {
      anim = null;
      const dist = camera.position.distanceTo(controls.target);
      const h = 2 * dist * Math.tan((camera.fov * Math.PI) / 360);
      camera.updateMatrix();
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0),
        up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
      const move = right.multiplyScalar(dx * h).add(up.multiplyScalar(dy * h));
      camera.position.add(move);
      controls.target.add(move);
      controls.update();
    },
    zoomBy(f) {
      camera.position
        .sub(controls.target)
        .multiplyScalar(f)
        .add(controls.target);
      controls.update();
    },
    clearSelection() {
      select(null);
    },
    // axis: "x" | "y" | "z" | null (off); t: 0..1 position across the visible models; flip keeps the other side
    setSection(axis, t = 0, flip = false) {
      if (!axis) {
        sectionOn = false;
        applySection();
        return;
      }
      const box = new THREE.Box3();
      models.forEach((r) => {
        if (r.visible) box.union(new THREE.Box3().setFromObject(r));
      });
      if (box.isEmpty()) return;
      const ax = { x: 0, y: 1, z: 2 }[axis],
        lo = box.min.getComponent(ax),
        hi = box.max.getComponent(ax),
        pos = lo + t * (hi - lo);
      const n = new THREE.Vector3();
      n.setComponent(ax, flip ? -1 : 1);
      sectionPlane.normal.copy(n);
      sectionPlane.constant = -n.getComponent(ax) * pos;
      sectionOn = true;
      applySection();
    },
    hasSelection: () => selected.length > 0,
    hideSelected() {
      selected.forEach((o) => (o.visible = false));
      select(null);
    },
    isolateSelected() {
      if (!selected.length) return;
      models.forEach((root) =>
        root.traverse((o) => {
          if (o.isMesh) o.visible = false;
        }),
      );
      selected.forEach((sel) => {
        for (let a = sel.parent; a && a !== scene; a = a.parent)
          if (a.userData.modelKey === undefined) a.visible = true;
        sel.traverse((o) => (o.visible = true));
      });
      focusSelected(); // jump straight to the isolated parts
    },
    showAll() {
      models.forEach((root, k) => {
        root.traverse((o) => (o.visible = true));
        root.visible = isOn(k);
      });
    },
    // items: [{ key, names }] -> select parts across several models at once
    selectMany(items) {
      const objs = items.flatMap(({ key, names }) => find(names, key));
      select(objs);
      return objs.length;
    },
    selectByNames(names, key) {
      const objs = find(names, key);
      select(objs);
      return objs.length;
    },
    // Hides if any is visible, otherwise shows. Returns the new visibility (null if nothing found).
    toggleNames(names, key) {
      const objs = find(names, key);
      if (!objs.length) return null;
      const vis = !objs.some((o) => o.visible);
      objs.forEach((o) => {
        o.visible = vis;
        if (vis)
          for (let a = o.parent; a && a !== scene; a = a.parent)
            if (a.userData.modelKey === undefined) a.visible = true;
      });
      return vis;
    },
  };
  // Render on demand: any call that may change the picture schedules one frame.
  // Read-only calls are left out; screenPos runs inside onFrame and would otherwise render forever.
  for (const [name, fn] of Object.entries(api))
    if (typeof fn === "function" && !/^(get|has|screenPos)/.test(name))
      api[name] = (...args) => {
        const out = fn.apply(api, args);
        invalidate();
        return out;
      };
  return api;
}
