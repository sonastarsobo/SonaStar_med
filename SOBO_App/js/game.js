// Anatomy Sprint: a short, timed identification drill shown beside the quiz list on the Assessment page.
// It is practice only: scores stay in this browser (localStorage) and never reach the gradebook or XP.
//
// Modes
//   spot: a structure is highlighted on the 3D model; pick its name from four options.
//   clue: a function / location description (with the name masked) is shown; pick the structure.
// Distractors come from the same body system, preferring siblings in the hierarchy, so the choices
// are plausible rather than obvious.
import { supabase } from "./supabase.js";
import { loadSystems, loadAllStructures } from "./anatomy.js";
import { esc } from "./session.js";
import { mountScene } from "./assessment.js";

const ROUND_MS = 60000;
const WRONG_PENALTY_MS = 3000;
const SKIP_PENALTY_MS = 1000;
const FAST_MS = 8000; // answers faster than this earn a speed bonus
const HIGHLIGHT = "#a78bfa";
const MODES = {
  spot: {
    label: "3D Spot",
    hint: "A structure lights up on the model. Name it.",
  },
  clue: {
    label: "Clue",
    hint: "Read a function or location description. Pick the structure.",
  },
};
// Generic words that are left visible when a clue's name is masked
const STOP = new Set(
  "left right upper lower major minor anterior posterior superior inferior medial lateral artery arteries vein veins nerve nerves muscle muscles bone bones ligament group".split(
    " ",
  ),
);

const shuffle = (a) => {
  a = [...a];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const fmt = (n) => Math.round(n).toLocaleString();

function maskName(text, name) {
  let t = String(text);
  const parts = [
    name,
    ...name
      .split(/[\s,()/-]+/)
      .filter((w) => w.length > 4 && !STOP.has(w.toLowerCase())),
  ];
  parts.forEach((p) => {
    t = t.replace(new RegExp(reEsc(p), "gi"), "▁▁▁");
  });
  return t.length > 260 ? t.slice(0, 257).trimEnd() + "..." : t;
}

// ---------- personal records (this browser only) ----------
function recordKey(profile, mode, sys) {
  return `sprint:${profile.id}:${mode}:${sys || "all"}`;
}
function readRecord(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null") || { best: 0, runs: [] };
  } catch {
    return { best: 0, runs: [] };
  }
}
function saveRecord(key, rec) {
  try {
    localStorage.setItem(key, JSON.stringify(rec));
  } catch {}
}

export async function mountGame(root, profile) {
  root.innerHTML = `<div class="card game">
    <div class="g-top">
      <div><span class="g-eyebrow">Practice arena</span><h2>Anatomy Sprint</h2></div>
      <button class="btn small secondary g-expand" id="gExpand" title="Wider game area">&#x2922; Expand</button>
    </div>
    <div id="gMenu"><p class="muted small">Loading anatomy...</p></div>
    <div id="gHud" class="g-hud" hidden></div>
    <div id="gStage" class="g-stage" hidden></div>
    <div id="gPlay" hidden></div>
    <div id="gDone" hidden></div>
  </div>`;
  const $g = (id) => root.querySelector("#" + id);
  const layout = root.closest(".assess-layout");
  $g("gExpand").onclick = () => {
    const wide = layout?.classList.toggle("game-wide");
    $g("gExpand").innerHTML = wide ? "&#x2921; Collapse" : "&#x2922; Expand";
    if (wide) root.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  let systems, all;
  try {
    [systems, all] = await Promise.all([loadSystems(), loadAllStructures()]);
  } catch (e) {
    console.error(e);
    $g("gMenu").innerHTML =
      '<p class="msg error">Could not load anatomy data for the game.</p>';
    return;
  }
  const sysName = new Map(systems.map((s) => [s.id, s.name]));
  const modelSystems = systems.filter((s) =>
    all.some((r) => r.system_id === s.id && r.model_file_path),
  );
  let clueRows = null; // fetched the first time Clue mode starts
  let scene = null;

  const state = {
    mode: modelSystems.length ? "spot" : "clue",
    sys: modelSystems[0]?.id || "",
  };

  // ======================= menu =======================
  function drawMenu() {
    show("gMenu");
    const spot = state.mode === "spot";
    if (spot && !modelSystems.some((s) => s.id === state.sys))
      state.sys = modelSystems[0]?.id || "";
    const sysOpts = (spot ? modelSystems : systems)
      .map(
        (s) =>
          `<option value="${s.id}" ${s.id === state.sys ? "selected" : ""}>${esc(s.name)}</option>`,
      )
      .join("");
    const rec = readRecord(recordKey(profile, state.mode, state.sys));
    const runs = rec.runs.slice(-8);
    const maxRun = Math.max(1, ...runs);
    $g("gMenu").innerHTML = `
      <div class="seg" role="tablist" aria-label="Game mode">${Object.entries(MODES)
        .map(
          ([k, m]) =>
            `<button role="tab" data-mode="${k}" aria-selected="${k === state.mode}" ${k === "spot" && !modelSystems.length ? 'disabled title="No 3D models uploaded yet"' : ""}>${m.label}</button>`,
        )
        .join("")}</div>
      <p class="g-hint">${MODES[state.mode].hint}</p>
      <label for="gSys">Body system</label>
      <select id="gSys">${spot ? "" : `<option value="" ${!state.sys ? "selected" : ""}>All systems</option>`}${sysOpts}</select>
      <div class="g-rules">
        <div><b>60s</b><span>round</span></div>
        <div><b>&times;3</b><span>max streak bonus</span></div>
        <div><b>&minus;3s</b><span>per miss</span></div>
      </div>
      <div class="g-record">
        <div><span class="g-label">Personal best</span><b>${rec.best ? fmt(rec.best) : "&mdash;"}</b></div>
        <div class="g-spark" title="Your last rounds">${
          runs.length
            ? runs
                .map(
                  (r) =>
                    `<i style="height:${Math.max(8, (r / maxRun) * 100)}%" title="${fmt(r)}"></i>`,
                )
                .join("")
            : '<span class="muted small">No rounds yet</span>'
        }</div>
      </div>
      <button class="btn g-start" id="gStart">Start round <kbd>Enter</kbd></button>
      <p class="small muted g-foot">Practice only: scores stay on this device and do not affect grades or XP.</p>`;
    $g("gMenu")
      .querySelectorAll("[data-mode]")
      .forEach(
        (b) =>
          (b.onclick = () => {
            state.mode = b.dataset.mode;
            drawMenu();
          }),
      );
    $g("gSys").onchange = (e) => {
      state.sys = e.target.value;
      drawMenu();
    };
    $g("gStart").onclick = start;
  }
  function show(...ids) {
    ["gMenu", "gHud", "gStage", "gPlay", "gDone"].forEach(
      (id) => ($g(id).hidden = !ids.includes(id)),
    );
  }

  // ======================= round =======================
  let run = null;
  async function start() {
    const btn = $g("gStart");
    btn.disabled = true;
    btn.textContent = "Preparing...";
    try {
      const pool = await buildPool();
      if (pool.length < 4) {
        $g("gStage").hidden = true;
        btn.disabled = false;
        btn.innerHTML = "Start round <kbd>Enter</kbd>";
        $g("gMenu").insertAdjacentHTML(
          "beforeend",
          `<p class="msg error">Not enough ${state.mode === "clue" ? "described " : ""}structures in this system to play. Try another system${state.mode === "spot" ? " or Clue mode" : ""}.</p>`,
        );
        return;
      }
      run = {
        pool,
        used: new Set(),
        score: 0,
        streak: 0,
        bestStreak: 0,
        correct: 0,
        answered: 0,
        times: [],
        missed: [],
        endAt: 0,
        q: null,
        locked: false,
        over: false,
      };
      show("gHud", "gPlay", ...(state.mode === "spot" ? ["gStage"] : []));
      await countdown();
      run.endAt = performance.now() + ROUND_MS;
      tick();
      next();
    } catch (e) {
      console.error(e);
      show("gMenu");
      btn.disabled = false;
      btn.innerHTML = "Start round <kbd>Enter</kbd>";
      $g("gMenu").insertAdjacentHTML(
        "beforeend",
        `<p class="msg error">${esc(e.message || "Could not start the game.")}</p>`,
      );
    }
  }

  async function buildPool() {
    if (state.mode === "spot") {
      const stage = $g("gStage");
      stage.hidden = false;
      if (!scene) scene = await mountScene(stage, { systems, all });
      scene.setStatus("Loading 3D model...");
      const failed = await scene.ensure([state.sys]);
      if (failed.length) throw new Error("Could not load the 3D model for " + failed[0] + ".");
      scene.show([state.sys]);
      scene.setStatus("");
      return all.filter((r) => r.system_id === state.sys && r.model_object_id);
    }
    if (!clueRows) {
      const { data, error } = await supabase
        .from("anatomy_structures")
        .select("id,system_id,parent_id,name,function,location")
        .or("function.not.is.null,location.not.is.null")
        .limit(3000);
      if (error) throw error;
      clueRows = data.filter(
        (r) => (r.function || "").trim().length >= 12 || (r.location || "").trim().length >= 12,
      );
    }
    return clueRows.filter((r) => !state.sys || r.system_id === state.sys);
  }

  function countdown() {
    return new Promise((resolve) => {
      let n = 3;
      $g("gHud").innerHTML = "";
      const paint = () =>
        ($g("gPlay").innerHTML = `<div class="g-count"><b>${n}</b><span>Get ready</span></div>`);
      paint();
      const t = setInterval(() => {
        n--;
        if (n <= 0) {
          clearInterval(t);
          resolve();
        } else paint();
      }, 650);
    });
  }

  const mult = () => Math.min(3, 1 + Math.floor(run.streak / 3) * 0.5);
  function drawHud() {
    const left = Math.max(0, run.endAt - performance.now());
    const pctLeft = (left / ROUND_MS) * 100;
    $g("gHud").innerHTML = `
      <div class="g-stats">
        <div><span class="g-label">Score</span><b id="gScore">${fmt(run.score)}</b></div>
        <div><span class="g-label">Streak</span><b>${run.streak}${run.streak >= 3 ? ' <span class="g-fire">&times;' + mult() + "</span>" : ""}</b></div>
        <div><span class="g-label">Time</span><b class="${left < 10000 ? "g-low" : ""}">${(left / 1000).toFixed(1)}s</b></div>
      </div>
      <div class="g-timebar"><i style="width:${pctLeft}%" class="${left < 10000 ? "low" : ""}"></i></div>`;
  }
  let lastHud = 0;
  function tick() {
    if (!run || run.over) return;
    const now = performance.now();
    if (now - lastHud > 90) {
      lastHud = now;
      drawHud(); // ~10 redraws a second is plenty for a 0.1s clock
    }
    if (performance.now() >= run.endAt) {
      if (!run.locked) finish();
      else run.timeUp = true; // finish once the current feedback is shown
      return;
    }
    requestAnimationFrame(tick);
  }

  function pickOptions(target) {
    const sameSys = (state.mode === "spot" ? run.pool : all).filter(
      (r) => r.system_id === target.system_id && r.id !== target.id,
    );
    const siblings = shuffle(
      sameSys.filter((r) => target.parent_id && r.parent_id === target.parent_id),
    );
    const names = new Set([target.name.trim().toLowerCase()]);
    const out = [target];
    for (const r of [...siblings.slice(0, 2), ...shuffle(sameSys)]) {
      if (out.length >= 4) break;
      const n = r.name.trim().toLowerCase();
      if (names.has(n)) continue;
      names.add(n);
      out.push(r);
    }
    return shuffle(out);
  }

  function next() {
    if (!run || run.over) return;
    if (run.timeUp) return finish();
    let target = null;
    for (let tries = 0; tries < 25 && !target; tries++) {
      let fresh = run.pool.filter((r) => !run.used.has(r.id));
      if (!fresh.length) {
        run.used.clear(); // the whole pool has been seen: start over
        fresh = run.pool;
      }
      const t = fresh[Math.floor(Math.random() * fresh.length)];
      run.used.add(t.id);
      if (state.mode === "spot") {
        const items = scene.itemsFor([t], HIGHLIGHT);
        if (!scene.viewer.setMarks(items, { ghost: true })) continue; // not present in the model
        scene.viewer.frameItems(items);
      }
      target = t;
    }
    if (!target) return finish();
    const opts = pickOptions(target);
    if (opts.length < 2) return finish();
    run.q = { target, opts, t0: performance.now() };
    run.locked = false;

    let prompt;
    if (state.mode === "spot") {
      prompt = `<p class="g-q">Identify the highlighted structure</p>`;
    } else {
      const useFn = (target.function || "").trim().length >= 12 && (!target.location || Math.random() < 0.6);
      const text = useFn ? target.function : target.location;
      prompt = `<div class="g-clue"><span class="g-label">${useFn ? "Function" : "Location"}${state.sys ? "" : " &middot; " + esc(sysName.get(target.system_id) || "")}</span><p>${esc(maskName(text, target.name))}</p></div><p class="g-q">Which structure is this?</p>`;
    }
    $g("gPlay").innerHTML = `${prompt}
      <div class="g-opts">${opts
        .map(
          (o, i) =>
            `<button class="g-opt" data-id="${o.id}"><kbd>${i + 1}</kbd><span>${esc(o.name)}</span></button>`,
        )
        .join("")}</div>
      <div class="g-actions"><button class="btn small secondary" id="gSkip">Skip <kbd>0</kbd></button><button class="btn small secondary" id="gQuit">End round <kbd>Esc</kbd></button><span class="g-pop" id="gPop"></span></div>`;
    $g("gPlay")
      .querySelectorAll(".g-opt")
      .forEach((b) => (b.onclick = () => answer(b.dataset.id)));
    $g("gSkip").onclick = () => answer(null);
    $g("gQuit").onclick = () => finish();
  }

  function answer(id) {
    if (!run || run.locked || run.over || !run.q) return;
    run.locked = true;
    const { target } = run.q;
    const ms = performance.now() - run.q.t0;
    const ok = id === target.id;
    const btns = $g("gPlay").querySelectorAll(".g-opt");
    btns.forEach((b) => {
      b.disabled = true;
      if (b.dataset.id === target.id) b.classList.add("right");
      else if (b.dataset.id === id) b.classList.add("wrong");
    });
    let pop;
    if (ok) {
      run.streak++;
      run.bestStreak = Math.max(run.bestStreak, run.streak);
      run.correct++;
      const gain = (100 + 50 * Math.max(0, 1 - ms / FAST_MS)) * mult();
      run.score += gain;
      pop = `<span class="ok">+${fmt(gain)}</span>`;
    } else {
      run.streak = 0;
      run.endAt -= id ? WRONG_PENALTY_MS : SKIP_PENALTY_MS;
      if (!run.missed.some((m) => m.id === target.id)) run.missed.push(target);
      pop = `<span class="bad">${id ? "&minus;3s" : "Skipped &minus;1s"}</span>`;
    }
    if (id) {
      run.answered++;
      run.times.push(ms);
    }
    $g("gPop").innerHTML = pop;
    if (state.mode === "spot")
      scene.viewer.setMarks(scene.itemsFor([target], ok ? "#34d399" : "#f87171"), { ghost: true });
    setTimeout(next, ok ? 550 : 1300);
  }

  function finish() {
    if (!run || run.over) return;
    run.over = true;
    scene?.viewer.setMarks([]);
    const key = recordKey(profile, state.mode, state.sys);
    const rec = readRecord(key);
    const score = Math.round(run.score);
    const isBest = score > 0 && score > rec.best;
    rec.best = Math.max(rec.best, score);
    rec.runs = [...rec.runs, score].slice(-20);
    saveRecord(key, rec);
    const acc = run.answered ? Math.round((run.correct / run.answered) * 100) : 0;
    const avg = run.times.length ? run.times.reduce((a, b) => a + b, 0) / run.times.length / 1000 : 0;
    const missed = run.missed.slice(0, 6);
    show("gDone");
    $g("gDone").innerHTML = `
      <div class="g-result">
        ${isBest ? '<span class="chip brand">New personal best</span>' : ""}
        <span class="g-label">Round score</span>
        <b class="g-big">${fmt(score)}</b>
        <div class="g-summary">
          <div><b>${acc}%</b><span>accuracy</span></div>
          <div><b>${run.correct}/${run.answered}</b><span>correct</span></div>
          <div><b>${run.bestStreak}</b><span>best streak</span></div>
          <div><b>${avg ? avg.toFixed(1) + "s" : "&mdash;"}</b><span>avg answer</span></div>
        </div>
      </div>
      ${
        missed.length
          ? `<h3 class="g-sub">Revise these</h3><ul class="list g-missed">${missed
              .map(
                (m) =>
                  `<li><span>${esc(m.name)} <span class="muted small">${esc(sysName.get(m.system_id) || "")}</span></span><a class="btn small secondary" href="learn.html?structure=${m.id}">Study</a></li>`,
              )
              .join("")}</ul>
             <a class="btn small secondary g-all" href="learn.html?structures=${run.missed.map((m) => m.id).join(",")}">Open all ${run.missed.length} in Learn mode</a>`
          : run.answered
            ? '<p class="muted small">No misses this round. Nicely done.</p>'
            : ""
      }
      <div class="row g-again"><button class="btn" id="gAgain">Play again <kbd>Enter</kbd></button><button class="btn secondary" id="gMenuBtn">Change mode</button></div>`;
    $g("gAgain").onclick = () => {
      drawMenu();
      start();
    };
    $g("gMenuBtn").onclick = drawMenu;
  }

  // ---------- keyboard: 1-4 answer, 0 skip, Esc end, Enter start / play again ----------
  document.addEventListener("keydown", (e) => {
    if (/input|select|textarea/i.test(e.target.tagName) || e.ctrlKey || e.metaKey || e.altKey)
      return;
    if (!root.isConnected) return;
    const playing = run && !run.over && !$g("gPlay").hidden;
    if (playing && run.q) {
      if (/^[1-4]$/.test(e.key)) {
        const b = $g("gPlay").querySelectorAll(".g-opt")[+e.key - 1];
        if (b) {
          e.preventDefault();
          answer(b.dataset.id);
        }
      } else if (e.key === "0") {
        e.preventDefault();
        answer(null);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish();
      }
    } else if (e.key === "Enter" && e.target === document.body) {
      if (!$g("gMenu").hidden && $g("gStart") && !$g("gStart").disabled) {
        e.preventDefault();
        start();
      } else if (!$g("gDone").hidden) {
        e.preventDefault();
        $g("gAgain")?.click();
      }
    }
  });

  drawMenu();
}
