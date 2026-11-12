// Assessment engine: 3D scene helper, question renderer (all 7 types) and the student quiz player.
// The renderer is shared with the admin question editor (live preview) and the result page (3D review).
import { createViewer } from "./three-viewer.js";
import {
  loadSystems,
  loadAllStructures,
  buildObjMap,
  loadSceneModels,
} from "./anatomy.js";
import {
  $,
  esc,
  rpc,
  toast,
  fmtDur,
  fmtDate,
  fmtDay,
  pct,
  titleCase,
  mountNav,
  confirmBox,
  invalidateNavXP,
  modelUrlFor,
} from "./session.js";

export const PALETTE = [
  "#ff9f1c",
  "#2ec4b6",
  "#e71d36",
  "#9b5de5",
  "#3a86ff",
  "#ff006e",
  "#8ac926",
  "#fb5607",
  "#00bbf9",
  "#f15bb5",
  "#ffbe0b",
  "#06d6a0",
];
export const TYPE_LABEL = {
  MULTIPLE_CHOICE: "Multiple choice",
  IDENTIFY_3D: "3D identification",
  FIND_STRUCTURE: "Find the structure",
  SYSTEM_IDENTIFICATION: "System identification",
  LABEL_ANATOMY: "Label anatomy",
  MULTI_STRUCTURE: "Select multiple structures",
  SEQUENCE: "Sequence",
};
export const IS3D = new Set([
  "IDENTIFY_3D",
  "FIND_STRUCTURE",
  "SYSTEM_IDENTIFICATION",
  "LABEL_ANATOMY",
  "MULTI_STRUCTURE",
]);

// [{s: systemId, o: nodeName}] from the server -> viewer items [{key, names}]
export function itemsFromObjects(objs, color) {
  const m = new Map();
  (objs || []).forEach(({ s, o }) => {
    if (!m.has(s)) m.set(s, []);
    m.get(s).push(o);
  });
  return [...m].map(([key, names]) => ({ key, names, color }));
}

// ======================================================================
// Scene: one viewer + anatomy data. Models load lazily, per system.
// ======================================================================
// preloaded (optional): { systems, all } already fetched by the caller, so they are not requested twice.
export async function mountScene(container, preloaded = null) {
  const scene = { handlers: {}, pins: [], loading: new Map() };
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  container.appendChild(overlay);
  const pinLayer = document.createElement("div");
  pinLayer.className = "pins";
  container.appendChild(pinLayer);
  scene.setStatus = (t) => {
    overlay.textContent = t || "";
    overlay.style.display = t ? "grid" : "none";
  };
  scene.setStatus("Loading anatomy data...");

  let objMap = new Map(),
    frame = 0;
  const rowFor = (names, key) =>
    names.map((n) => objMap.get(key + "|" + n)).find(Boolean) || null;
  scene.rowFor = rowFor;
  scene.viewer = createViewer(container, {
    autoSelect: false,
    onSelect: (names, _o, key, add) => {
      if (names.length) scene.handlers.pick?.(rowFor(names, key), { add });
    },
    onBoxSelect: (items, add) =>
      scene.handlers.box?.(
        items.map(({ key, names }) => rowFor(names, key)).filter(Boolean),
        add,
      ),
    onHover: (names, x, y, key) =>
      scene.handlers.hover?.(names.length ? rowFor(names, key) : null, x, y),
    onFrame() {
      if (!scene.pins.length || ++frame % 3) return;
      scene.pins.forEach((p) => {
        const s = scene.viewer.screenPos(p.items);
        p.el.style.display = s ? "grid" : "none";
        if (s) {
          p.el.style.left = s.x + "px";
          p.el.style.top = s.y + "px";
        }
      });
    },
  });
  try {
    [scene.systems, scene.all] = preloaded
      ? [preloaded.systems, preloaded.all]
      : await Promise.all([
      loadSystems(),
      loadAllStructures(),
    ]);
  } catch (e) {
    console.error(e);
    scene.setStatus("Could not load anatomy data.");
    throw e;
  }
  objMap = buildObjMap(scene.all);
  scene.byId = new Map(scene.all.map((r) => [r.id, r]));
  const kids = new Map();
  scene.all.forEach((r) => {
    if (r.parent_id) {
      if (!kids.has(r.parent_id)) kids.set(r.parent_id, []);
      kids.get(r.parent_id).push(r);
    }
  });
  const namesUnder = (row, out = []) => {
    if (row.model_object_id) out.push(row.model_object_id);
    (kids.get(row.id) || []).forEach((c) => namesUnder(c, out));
    return out;
  };
  // structure rows -> viewer items (a group row includes all its descendants)
  scene.itemsFor = (rows, color) => {
    const m = new Map();
    rows.forEach((r) => {
      if (!m.has(r.system_id)) m.set(r.system_id, []);
      m.get(r.system_id).push(...namesUnder(r));
    });
    return [...m].map(([key, names]) => ({ key, names, color }));
  };
  scene.systemsWithModels = () =>
    scene.systems
      .filter((s) =>
        scene.all.some((r) => r.system_id === s.id && r.model_file_path),
      )
      .map((s) => s.id);

  // Loads models for these system ids (once each). Resolves with the list of failed system names.
  scene.ensure = async (ids) => {
    const need = ids.filter((id) => scene.systems.some((s) => s.id === id));
    need.forEach((id) => {
      if (!scene.loading.has(id))
        scene.loading.set(
          id,
          loadSceneModels(
            scene.viewer,
            scene.systems.filter((s) => s.id === id),
            scene.all,
          ),
        );
    });
    const res = await Promise.all(need.map((id) => scene.loading.get(id)));
    return res.flatMap((r) => r.failed);
  };
  scene.show = (ids) =>
    scene.viewer.setVisibleModels(ids && ids.length ? ids : null);
  scene.clearPins = () => {
    pinLayer.innerHTML = "";
    scene.pins = [];
  };
  // list: [{ n, color, items }]
  scene.setPins = (list) => {
    scene.clearPins();
    scene.pins = list.map((p) => {
      const el = document.createElement("div");
      el.className = "pin";
      el.textContent = p.n;
      el.style.background = p.color;
      pinLayer.appendChild(el);
      return { ...p, el };
    });
    scene.viewer.requestRender(); // pins are positioned on the next rendered frame
  };
  scene.setStatus("");
  return scene;
}

// ======================================================================
// QuestionView: draws one question + its answer controls, wires 3D interaction
// ======================================================================
export class QuestionView {
  constructor(panel, scene) {
    this.panel = panel;
    this.scene = scene;
    this.tok = 0;
  }

  // opts: { answer, locked, feedback, immediate, index, total, onAnswer(answer, {commit}) }
  async render(q, opts = {}) {
    const tok = ++this.tok,
      P = this.panel;
    Object.assign(this, {
      q,
      onAnswer: opts.onAnswer,
      locked: !!opts.locked,
      immediate: !!opts.immediate,
    });
    this.ans = opts.answer ? JSON.parse(JSON.stringify(opts.answer)) : {};
    P.innerHTML = `<div class="qtype">Question ${opts.index ?? ""}${opts.total ? ` of ${opts.total}` : ""} &middot; ${esc(TYPE_LABEL[q.type] || q.type)} &middot; ${q.points} pt${q.points > 1 ? "s" : ""}</div>
      <div class="qtext">${esc(q.text)}</div>${q.image_path ? `<img class="qimg" alt="Question image" src="${esc(modelUrlFor("quiz-media", q.image_path))}">` : ""}
      <div id="qbody"></div><div id="qfb"></div>`;
    this.body = P.querySelector("#qbody");
    const sc = this.scene;
    if (sc) {
      sc.handlers = {};
      sc.viewer.setMarks([]);
      sc.clearPins();
    }
    ({
      MULTIPLE_CHOICE: () => this.drawChoice(q.options),
      IDENTIFY_3D: () => this.drawChoice(q.options),
      SYSTEM_IDENTIFICATION: () => this.drawChoice(q.systems),
      FIND_STRUCTURE: () => this.drawFind(),
      MULTI_STRUCTURE: () => this.drawMulti(),
      LABEL_ANATOMY: () => this.drawLabels(),
      SEQUENCE: () => this.drawSequence(),
    })[q.type]?.();
    if (opts.feedback) this.setFeedback(opts.feedback);
    if (IS3D.has(q.type) && sc) await this.setup3D(tok);
  }

  emit(commit = true) {
    this.onAnswer?.(JSON.parse(JSON.stringify(this.ans)), { commit });
  }
  // In "immediate feedback" quizzes, multi-step answers are only submitted when the student presses Check
  checkBar() {
    if (!this.immediate || this.locked) return;
    const d = document.createElement("div");
    d.className = "row";
    d.innerHTML =
      '<button class="btn" id="checkBtn">Check answer</button><span class="hint">Your answer is locked once checked.</span>';
    this.body.appendChild(d);
    d.querySelector("button").onclick = () => this.emit(true);
    this.refreshCheck();
  }
  hasAns() {
    return Object.values(this.ans).some((v) =>
      Array.isArray(v) ? v.some(Boolean) : !!v,
    );
  }
  refreshCheck() {
    const b = this.panel.querySelector("#checkBtn");
    if (b) b.disabled = !this.hasAns();
  }
  setFeedback(fb) {
    const el = this.panel.querySelector("#qfb");
    if (!el) return;
    el.innerHTML = fb
      ? `<div class="feedback ${fb.is_correct ? "ok" : "bad"}"><b>${fb.is_correct ? "Correct!" : "Not quite."}</b> ${esc(fb.explanation || "")}</div>`
      : "";
  }

  // ---- single choice (MCQ, 3D identification, system identification)
  drawChoice(options = []) {
    const key =
      this.q.type === "SYSTEM_IDENTIFICATION" ? "system_id" : "option_id";
    this.body.innerHTML = `<div class="opts">${options.map((o, i) => `<button class="opt ${this.ans[key] === o.id ? "sel" : ""}" data-id="${esc(o.id)}" ${this.locked ? "disabled" : ""}><span class="k">${"ABCDEFGH"[i] || i + 1}</span><span>${esc(o.text ?? o.name)}</span></button>`).join("")}</div>`;
    this.body.querySelectorAll(".opt").forEach(
      (b) =>
        (b.onclick = () => {
          this.ans = { [key]: b.dataset.id };
          this.body
            .querySelectorAll(".opt")
            .forEach((x) => x.classList.toggle("sel", x === b));
          this.emit(true);
        }),
    );
  }

  // ---- find a structure by clicking the model
  drawFind() {
    const show = () => {
      const r = this.scene?.byId.get(this.ans.structure_id);
      this.body.querySelector("#sel").innerHTML = r
        ? `You selected: <b>${esc(r.name)}</b>`
        : '<span class="muted">Click the structure on the 3D model.</span>';
      this.scene?.viewer.setMarks(r ? this.scene.itemsFor([r], "#ff9f1c") : []);
      this.refreshCheck();
    };
    this.body.innerHTML = '<div id="sel" class="feedback"></div>';
    show();
    if (!this.locked && this.scene)
      this.scene.handlers.pick = (row) => {
        if (!row) return;
        this.ans = { structure_id: row.id };
        show();
        if (!this.immediate) this.emit(true);
      };
    this.checkBar();
  }

  // ---- select several structures
  drawMulti() {
    const ids = () => (this.ans.structure_ids ||= []);
    const show = () => {
      const rows = ids()
        .map((id) => this.scene?.byId.get(id))
        .filter(Boolean);
      this.body.querySelector("#sel").innerHTML = rows.length
        ? `<div class="chips">${rows.map((r) => `<span class="chip brand">${esc(r.name)}${this.locked ? "" : `<button data-rm="${r.id}" aria-label="Remove">&times;</button>`}</span>`).join("")}</div><p class="hint">${rows.length} selected</p>`
        : '<span class="muted">Click structures on the 3D model. Ctrl + drag selects many; click again to unselect.</span>';
      this.body.querySelectorAll("[data-rm]").forEach(
        (b) =>
          (b.onclick = () => {
            this.ans.structure_ids = ids().filter((x) => x !== b.dataset.rm);
            show();
            if (!this.immediate) this.emit(true);
          }),
      );
      this.scene?.viewer.setMarks(this.scene.itemsFor(rows, "#ff9f1c"));
      this.refreshCheck();
    };
    this.body.innerHTML = '<div id="sel" class="feedback"></div>';
    show();
    if (!this.locked && this.scene) {
      this.scene.handlers.pick = (row) => {
        if (!row) return;
        this.ans.structure_ids = ids().includes(row.id)
          ? ids().filter((x) => x !== row.id)
          : [...ids(), row.id];
        show();
        if (!this.immediate) this.emit(true);
      };
      this.scene.handlers.box = (rows, add) => {
        const have = new Set(add ? ids() : []);
        rows.forEach((r) => have.add(r.id));
        this.ans.structure_ids = [...have];
        show();
        if (!this.immediate) this.emit(true);
      };
    }
    this.checkBar();
  }

  // ---- label numbered pins from a word bank
  drawLabels() {
    const q = this.q,
      n = q.pins.length;
    this.ans.labels = Array.from(
      { length: n },
      (_, i) => this.ans.labels?.[i] ?? null,
    );
    const draw = () => {
      const used = this.ans.labels;
      this.body.innerHTML = q.pins
        .map(
          (
            p,
            i,
          ) => `<div class="labelrow field"><b style="background:${PALETTE[i % 12]}">${p.n}</b><select data-i="${i}" ${this.locked ? "disabled" : ""}>
        <option value="">Choose a name...</option>${q.wordbank.map((w) => `<option value="${w.id}" ${used[i] === w.id ? "selected" : ""} ${used.includes(w.id) && used[i] !== w.id ? "disabled" : ""}>${esc(w.text)}</option>`).join("")}</select></div>`,
        )
        .join("");
      this.body.querySelectorAll("select").forEach(
        (s) =>
          (s.onchange = () => {
            this.ans.labels[+s.dataset.i] = s.value || null;
            draw();
            if (!this.immediate) this.emit(true);
          }),
      );
      this.checkBar();
    };
    draw();
  }

  // ---- put items in order
  drawSequence() {
    const q = this.q;
    let order =
        this.ans.order?.length === q.items.length
          ? [...this.ans.order]
          : q.items.map((i) => i.id),
      touched = !!this.ans.order;
    const byId = new Map(q.items.map((i) => [i.id, i.text]));
    const move = (from, to) => {
      if (to < 0 || to >= order.length || from === to) return;
      const [x] = order.splice(from, 1);
      order.splice(to, 0, x);
      touched = true;
      draw();
      this.ans = { order: [...order] };
      if (!this.immediate) this.emit(true);
    };
    const draw = () => {
      this.body.innerHTML = `<ol class="seq ${this.locked ? "locked" : ""}">${order.map((id, i) => `<li draggable="${!this.locked}" data-i="${i}"><span class="n">${i + 1}</span><span class="t">${esc(byId.get(id))}</span>${this.locked ? "" : `<button data-up="${i}" aria-label="Move up">&uarr;</button><button data-dn="${i}" aria-label="Move down">&darr;</button>`}</li>`).join("")}</ol>
        ${!touched && !this.locked ? '<div class="row" style="margin-top:8px"><button class="btn secondary" id="keep">Keep this order</button><span class="hint">Drag items, or use the arrows, to put them in order.</span></div>' : ""}`;
      this.body
        .querySelectorAll("[data-up]")
        .forEach(
          (b) => (b.onclick = () => move(+b.dataset.up, +b.dataset.up - 1)),
        );
      this.body
        .querySelectorAll("[data-dn]")
        .forEach(
          (b) => (b.onclick = () => move(+b.dataset.dn, +b.dataset.dn + 1)),
        );
      const keep = this.body.querySelector("#keep");
      if (keep)
        keep.onclick = () => {
          touched = true;
          this.ans = { order: [...order] };
          draw();
          if (!this.immediate) this.emit(true);
        };
      let from = null;
      this.body.querySelectorAll("li").forEach((li) => {
        li.ondragstart = () => {
          from = +li.dataset.i;
          li.classList.add("drag");
        };
        li.ondragend = () => li.classList.remove("drag");
        li.ondragover = (e) => e.preventDefault();
        li.ondrop = (e) => {
          e.preventDefault();
          if (from != null) move(from, +li.dataset.i);
          from = null;
        };
      });
      this.checkBar();
    };
    draw();
  }

  // ---- 3D: show the right system(s), highlight / ghost, point the camera
  async setup3D(tok) {
    const sc = this.scene,
      q = this.q,
      v = sc.viewer;
    const objs = [
      ...(q.highlight || []),
      ...(q.pins || []).flatMap((p) => p.objects),
    ];
    const ids = new Set(objs.map((o) => o.s));
    if (q.system_id) ids.add(q.system_id);
    // No system named by the question: use the quiz's system, and only download every model as a last resort
    const withModels = sc.systemsWithModels();
    const sys = ids.size
      ? [...ids]
      : withModels.includes(this.fallbackSystem)
        ? [this.fallbackSystem]
        : withModels;
    sc.setStatus("Loading 3D model...");
    const failed = await sc.ensure(sys);
    if (tok !== this.tok) return;
    sc.setStatus(
      failed.length
        ? `Could not load the 3D model (${failed.join(", ")}). Check the model path in Admin > Models.`
        : "",
    );
    sc.show(sys);
    if (q.type === "IDENTIFY_3D" || q.type === "SYSTEM_IDENTIFICATION")
      v.setMarks(itemsFromObjects(q.highlight, q.color), { ghost: true });
    if (q.type === "LABEL_ANATOMY") {
      const marks = q.pins.flatMap((p, i) =>
        itemsFromObjects(p.objects, PALETTE[i % 12]),
      );
      v.setMarks(marks);
      sc.setPins(
        q.pins.map((p, i) => ({
          n: p.n,
          color: PALETTE[i % 12],
          items: itemsFromObjects(p.objects),
        })),
      );
    }
    if (q.camera?.pos) v.setCameraState(q.camera);
    else if (objs.length) v.frameItems(itemsFromObjects(objs));
  }
}

// ======================================================================
// Student page: quiz list + player
// ======================================================================
const STATUS_CHIP = {
  NOT_STARTED: ["Not started", ""],
  IN_PROGRESS: ["In progress", "mid"],
  COMPLETED: ["Completed", "ok"],
};
const DIFF_CHIP = { EASY: "ok", MEDIUM: "mid", HARD: "bad" };

export async function initAssessmentPage(profile) {
  mountNav(profile, "assessment");
  const q = new URLSearchParams(location.search);
  try {
    if (q.get("attempt"))
      return await runPlayer({ attemptId: q.get("attempt"), profile });
    if (q.get("preview") && profile.role === "ADMIN")
      return await runPlayer({ previewQuiz: q.get("preview"), profile });
    if (q.get("quiz")) return await beginQuiz(q.get("quiz"));
    return await showList(profile);
  } catch (e) {
    console.error(e);
    $("listView").hidden = false;
    $("listView").innerHTML =
      `<div class="card"><p class="msg error">${esc(e.message)}</p><a class="btn secondary" href="assessment.html">Back to quizzes</a></div>`;
  }
}

async function beginQuiz(quizId) {
  const id = await rpc("start_attempt", { p_quiz: quizId });
  location.replace("assessment.html?attempt=" + id);
}

const DAY = 86400000;
// "Recommended" order: unfinished attempts, then quizzes you can start (closing soonest first),
// then completed ones still below the pass mark, then everything else.
const rank = (z) =>
  z.status === "IN_PROGRESS"
    ? 0
    : z.can_start && z.status === "NOT_STARTED"
      ? 1
      : z.can_start && !z.passed
        ? 2
        : z.can_start
          ? 3
          : 4;
const SORTS = {
  rec: (a, b) =>
    rank(a) - rank(b) ||
    (a.end_at ? Date.parse(a.end_at) : Infinity) -
      (b.end_at ? Date.parse(b.end_at) : Infinity) ||
    a.title.localeCompare(b.title),
  due: (a, b) =>
    (a.end_at ? Date.parse(a.end_at) : Infinity) -
      (b.end_at ? Date.parse(b.end_at) : Infinity) ||
    a.title.localeCompare(b.title),
  title: (a, b) => a.title.localeCompare(b.title),
  diff: (a, b) =>
    ["EASY", "MEDIUM", "HARD"].indexOf(a.difficulty) -
      ["EASY", "MEDIUM", "HARD"].indexOf(b.difficulty) ||
    a.title.localeCompare(b.title),
  best: (a, b) => (b.best_percentage ?? -1) - (a.best_percentage ?? -1),
};

async function showList(profile) {
  const view = $("listView");
  view.hidden = false;
  view.innerHTML = '<p class="muted">Loading quizzes...</p>';
  let quizzes = await rpc("student_quizzes");
  let status = "";
  const count = (s) => quizzes.filter((z) => !s || z.status === s).length;

  // ---- overview numbers ----
  const done = quizzes.filter((z) => z.best_percentage != null);
  const avgBest = done.length
    ? done.reduce((s, z) => s + Number(z.best_percentage), 0) / done.length
    : null;
  const passed = quizzes.filter((z) => z.passed).length;
  const available = quizzes.filter((z) => z.can_start || z.status === "IN_PROGRESS").length;
  const dueSoon = quizzes.filter(
    (z) =>
      z.end_at &&
      z.can_start &&
      !z.passed &&
      Date.parse(z.end_at) - Date.now() < 3 * DAY &&
      Date.parse(z.end_at) > Date.now(),
  );
  const open = quizzes.find((z) => z.status === "IN_PROGRESS");

  const draw = () => {
    const df = $("fDiff").value,
      sort = $("fSort").value,
      term = $("fText").value.trim().toLowerCase();
    const list = quizzes
      .filter(
        (z) =>
          (!status || z.status === status) &&
          (!df || z.difficulty === df) &&
          (!term ||
            (z.title + " " + (z.category || "") + " " + (z.description || ""))
              .toLowerCase()
              .includes(term)),
      )
      .sort(SORTS[sort] || SORTS.rec);
    $("quizCount").textContent = `${list.length} of ${quizzes.length} quizzes`;
    $("quizGrid").innerHTML = list.length
      ? list.map(card).join("")
      : `<div class="empty card">${quizzes.length ? "No quizzes match these filters." : "No quizzes yet. They appear here when an instructor publishes and assigns them to you."}</div>`;
    $("quizGrid")
      .querySelectorAll("[data-start]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            startFlow(quizzes.find((z) => z.id === b.dataset.start))),
      );
  };

  view.innerHTML = `
    <div class="assess-head">
      <div><h1>Assessments</h1><p class="muted">Timed quizzes set by your instructors, plus a practice sprint to sharpen recall.</p></div>
    </div>
    <section class="grid assess-stats">
      <div class="stat"><b>${available}</b><span>Available now</span></div>
      <div class="stat"><b>${count("COMPLETED")}</b><span>Completed</span></div>
      <div class="stat ok"><b>${passed}</b><span>Passed</span></div>
      <div class="stat"><b>${avgBest == null ? "&mdash;" : pct(avgBest.toFixed(1))}</b><span>Avg best score</span></div>
      <div class="stat ${dueSoon.length ? "bad" : ""}"><b>${dueSoon.length}</b><span>Due in 3 days</span></div>
    </section>
    ${
      open
        ? `<div class="resume-banner"><span class="pulse-dot"></span><div><b>${esc(open.title)}</b> is in progress<span class="muted small"> &middot; the timer keeps running while you are away</span></div><a class="btn small" href="assessment.html?attempt=${open.in_progress_attempt_id}">Resume &rarr;</a></div>`
        : ""
    }
    <div class="assess-layout">
      <div class="assess-main">
        <div class="assess-toolbar">
          <div class="tabs" role="tablist" id="fStatus">${[
            ["", "All"],
            ["NOT_STARTED", "Not started"],
            ["IN_PROGRESS", "In progress"],
            ["COMPLETED", "Completed"],
          ]
            .map(
              ([v, l]) =>
                `<button role="tab" data-v="${v}" aria-selected="${v === status}">${l} <span class="tab-n">${count(v)}</span></button>`,
            )
            .join("")}</div>
          <div class="filters">
            <input id="fText" type="search" placeholder="Search by title, topic or category..." aria-label="Search quizzes">
            <select id="fDiff" aria-label="Difficulty"><option value="">Any difficulty</option><option value="EASY">Easy</option><option value="MEDIUM">Medium</option><option value="HARD">Hard</option></select>
            <select id="fSort" aria-label="Sort"><option value="rec">Sort: Recommended</option><option value="due">Sort: Closing soonest</option><option value="best">Sort: Best score</option><option value="diff">Sort: Difficulty</option><option value="title">Sort: Title A&ndash;Z</option></select>
          </div>
          <p class="small muted" id="quizCount"></p>
        </div>
        <div id="quizGrid" class="grid cards"></div>
      </div>
      <aside class="assess-side" id="gameCol"></aside>
    </div>`;
  ["fText", "fDiff", "fSort"].forEach((i) => ($(i).oninput = draw));
  $("fStatus").onclick = (e) => {
    const b = e.target.closest("button[data-v]");
    if (!b) return;
    status = b.dataset.v;
    $("fStatus")
      .querySelectorAll("button")
      .forEach((x) => x.setAttribute("aria-selected", x === b));
    draw();
  };
  draw();

  // The practice game loads separately so a slow model download never delays the quiz list
  import("./game.js")
    .then((m) => m.mountGame($("gameCol"), profile))
    .catch((e) => {
      console.error(e);
      $("gameCol").innerHTML =
        '<div class="card"><p class="msg error">The practice game could not be loaded.</p></div>';
    });
}

// "Closes in 2 days" style label with an urgency level
function dueLabel(z) {
  if (z.window === "UPCOMING" && z.start_at)
    return [`Opens ${fmtDay(z.start_at)}`, ""];
  if (!z.end_at) return null;
  const ms = Date.parse(z.end_at) - Date.now();
  if (ms <= 0) return ["Closed", ""];
  const h = Math.round(ms / 3600000);
  if (h < 24) return [`Closes in ${Math.max(h, 1)}h`, "bad"];
  const d = Math.round(ms / DAY);
  return [`Closes in ${d} day${d > 1 ? "s" : ""}`, d <= 3 ? "mid" : ""];
}

function card(z) {
  const [sl, sc] = STATUS_CHIP[z.status];
  const attempts = z.max_attempts
    ? `<span class="att" title="${z.attempts_used} of ${z.max_attempts} attempts used">${Array.from(
        { length: Math.min(z.max_attempts, 10) },
        (_, i) => `<i class="${i < z.attempts_used ? "used" : ""}"></i>`,
      ).join("")}<span>${Math.max(z.max_attempts - z.attempts_used, 0)} left</span></span>`
    : `<span class="att"><span>Unlimited attempts</span></span>`;
  const due = dueLabel(z);
  const best = z.best_percentage != null ? Number(z.best_percentage) : null;
  const pass = Number(z.passing_score) || 0;
  const scoreBar = `<div class="qscore">
      <div class="row sp small"><span class="muted">${best == null ? "Not attempted yet" : "Best score"}</span>${best == null ? "" : `<b class="${z.passed ? "ok" : "bad"}">${pct(best)}${z.passed ? " &middot; Passed" : ""}</b>`}</div>
      <div class="qbar"><i class="${z.passed ? "ok" : best == null ? "" : "bad"}" style="width:${best ?? 0}%"></i><span class="mark" style="left:${pass}%" title="Pass mark ${pct(pass)}"></span></div>
    </div>`;
  let action;
  if (z.status === "IN_PROGRESS")
    action = `<a class="btn" href="assessment.html?attempt=${z.in_progress_attempt_id}">Resume</a>`;
  else if (z.window === "UPCOMING")
    action = `<button class="btn" disabled>Opens ${esc(fmtDay(z.start_at))}</button>`;
  else if (!z.can_start)
    action = `<button class="btn" disabled>${z.window === "CLOSED" ? "Closed" : "No attempts left"}</button>`;
  else
    action = `<button class="btn" data-start="${z.id}">${z.status === "COMPLETED" ? "Retake" : "Start quiz"}</button>`;
  const last = z.last_attempt_id
    ? `<a class="btn secondary" href="result.html?attempt=${z.last_attempt_id}">Last result</a>`
    : "";
  return `<div class="card quiz-card status-${z.status.toLowerCase()}">
    <div class="row sp"><span class="chip ${sc}">${sl}</span><span class="diff ${DIFF_CHIP[z.difficulty]}"><i></i><i></i><i></i>${titleCase(z.difficulty)}</span></div>
    <div>${z.category ? `<span class="qcat">${esc(z.category)}</span>` : ""}<h3>${esc(z.title)}</h3>${z.description ? `<p class="muted small qdesc">${esc(z.description)}</p>` : ""}</div>
    <div class="qmeta">
      <div><b>${z.question_count}</b><span>questions</span></div>
      <div><b>${fmtDur(z.duration_seconds)}</b><span>time limit</span></div>
      <div><b>${pct(z.passing_score)}</b><span>to pass</span></div>
    </div>
    ${scoreBar}
    <div class="row sp small qinfo">${attempts}${due ? `<span class="chip ${due[1]}">${esc(due[0])}</span>` : ""}</div>
    <div class="foot">${action}${last}</div></div>`;
}

async function startFlow(z) {
  const ok = await confirmBox(
    `<span class="qcat">Before you start</span><h3 style="margin-top:4px;font-size:1.2rem">${esc(z.title)}</h3>
     <div class="qmeta" style="margin:14px 0"><div><b>${z.question_count}</b><span>questions</span></div><div><b>${fmtDur(z.duration_seconds)}</b><span>time limit</span></div><div><b>${pct(z.passing_score)}</b><span>to pass</span></div></div>
     <ul class="brief"><li>The timer starts now and keeps running if you leave the page.</li><li>Answers save automatically as you go.</li><li>Use <kbd>&larr;</kbd> <kbd>&rarr;</kbd> to move between questions.</li>${z.max_attempts ? `<li>This uses attempt ${z.attempts_used + 1} of ${z.max_attempts}.</li>` : ""}</ul>`,
    { ok: z.status === "COMPLETED" ? "Start new attempt" : "Start quiz" },
  );
  if (!ok) return;
  try {
    await beginQuiz(z.id);
  } catch (e) {
    toast(e.message, "error");
  }
}

// ----------------------------------------------------------------------
async function runPlayer({ attemptId, previewQuiz, profile }) {
  const preview = !!previewQuiz;
  const data = preview
    ? await rpc("preview_quiz", { p_quiz: previewQuiz })
    : await rpc("get_attempt", { p_attempt: attemptId });
  if (data.done) {
    location.replace("result.html?attempt=" + data.attempt_id);
    return;
  }
  const quiz = data.quiz,
    questions = data.questions;
  if (!questions.length) throw new Error("This quiz has no questions.");
  const answers = new Map(
    questions.map((qq) => [
      qq.id,
      {
        answer: data.answers?.[qq.id]?.answer || null,
        flagged: !!data.answers?.[qq.id]?.flagged,
        feedback: data.answers?.[qq.id]?.feedback || null,
      },
    ]),
  );
  const immediate = !!quiz.immediate_feedback;
  const has3D = questions.some((qq) => IS3D.has(qq.type));
  const skew = preview
    ? 0
    : new Date(data.attempt.server_now).getTime() - Date.now();
  const deadline = preview
    ? Date.now() + quiz.duration_seconds * 1000
    : new Date(data.attempt.deadline).getTime();

  $("listView").hidden = true;
  const pv = $("playerView");
  pv.hidden = false;
  pv.innerHTML = `<div class="player ${has3D ? "" : "no3d"}" id="player">
    <div class="bar-top"><h2>${esc(quiz.title)}${preview ? ' <span class="chip mid">PREVIEW: answers are not saved or scored</span>' : ""}</h2><span id="saveState"></span><span class="timer" id="timer">--:--</span></div>
    <aside class="card qnav"><h4>Questions</h4><div class="qgrid" id="qgrid"></div>
      <div class="legend"><i style="background:var(--ok-bg);border:1px solid #34d399"></i>Answered<br><i style="border:1px solid rgba(255,255,255,.2)"></i>Unanswered<br><span style="color:#f87171">&#9873;</span> Marked for review</div>
      <p class="small" id="counts" style="margin-top:10px"></p></aside>
    <section class="card" id="qpane"></section>
    <div id="stage"></div></div>`;

  let scene = null,
    qv = null,
    idx = 0;
  const pane = $("qpane");
  const ensureScene = async () => {
    if (!scene && has3D) {
      scene = await mountScene($("stage"));
    }
    return scene;
  };
  qv = new QuestionView(pane, null);
  qv.fallbackSystem = quiz.system_id; // 3D questions that name no system show the quiz's system

  // ---- saving ----
  const dirty = new Set();
  let saving = false,
    retry = null;
  const setSave = (t, err) => {
    const e = $("saveState");
    e.textContent = t;
    e.className = err ? "err" : "";
  };
  async function flush() {
    if (preview || saving || !dirty.size) return true;
    saving = true;
    setSave("Saving...");
    try {
      for (const qid of [...dirty]) {
        const a = answers.get(qid);
        const res = await rpc("save_answer", {
          p_attempt: attemptId,
          p_question: qid,
          p_answer: a.answer,
          p_flagged: a.flagged,
        });
        dirty.delete(qid);
        if (res.feedback) a.feedback = res.feedback; // the caller re-renders (the question is then locked)
      }
      setSave("All changes saved");
      return true;
    } catch (e) {
      console.error(e);
      if (/Time is up/i.test(e.message)) {
        setSave("Time is up", true);
        return false;
      }
      setSave("Save failed - retrying...", true);
      clearTimeout(retry);
      retry = setTimeout(flush, 4000);
      return false;
    } finally {
      saving = false;
    }
  }
  let debounce = null;
  const schedule = (ms = 500) => {
    clearTimeout(debounce);
    debounce = setTimeout(flush, ms);
  };

  function onAnswer(ans, { commit }) {
    const qq = questions[idx],
      a = answers.get(qq.id);
    a.answer = ans;
    renderNav();
    if (!commit) return; // immediate-feedback draft: kept locally until "Check answer"
    dirty.add(qq.id);
    if (immediate) {
      flush().then(() => render());
    } else schedule();
  }

  // ---- rendering ----
  function renderNav() {
    $("qgrid").innerHTML = questions
      .map((qq, i) => {
        const a = answers.get(qq.id),
          has = a.answer && Object.keys(a.answer).length;
        return `<button data-i="${i}" class="${has ? "answered" : ""} ${a.flagged ? "flagged" : ""} ${i === idx ? "current" : ""}" aria-label="Question ${i + 1}${has ? ", answered" : ""}${a.flagged ? ", marked for review" : ""}">${i + 1}</button>`;
      })
      .join("");
    $("qgrid")
      .querySelectorAll("button")
      .forEach((b) => (b.onclick = () => go(+b.dataset.i)));
    const done = questions.filter((qq) => {
        const a = answers.get(qq.id).answer;
        return a && Object.keys(a).length;
      }).length,
      fl = questions.filter((qq) => answers.get(qq.id).flagged).length;
    $("counts").innerHTML =
      `<b>${done}</b> answered &middot; <b>${questions.length - done}</b> unanswered &middot; <b>${fl}</b> flagged`;
  }
  async function render() {
    const qq = questions[idx],
      a = answers.get(qq.id);
    renderNav();
    $("player").classList.toggle("no3d", !IS3D.has(qq.type));
    if (IS3D.has(qq.type)) {
      qv.scene = await ensureScene();
    }
    const locked = immediate && !!a.feedback;
    // keep the control bar below the question
    await qv.render(qq, {
      answer: a.answer,
      locked,
      feedback: locked ? a.feedback : null,
      immediate,
      index: idx + 1,
      total: questions.length,
      onAnswer,
    });
    const bar = document.createElement("div");
    bar.className = "controls";
    bar.innerHTML = `<button class="btn secondary" id="prev" ${idx === 0 ? "disabled" : ""}>&larr; Previous</button>
      <button class="btn secondary flag ${a.flagged ? "on" : ""}" id="flag">&#9873; ${a.flagged ? "Marked for review" : "Mark for review"}</button><span class="sp"></span>
      ${idx < questions.length - 1 ? '<button class="btn" id="next">Next &rarr;</button>' : ""}<button class="btn ${idx < questions.length - 1 ? "secondary" : ""}" id="submit">Submit quiz</button>`;
    pane.appendChild(bar);
    $("prev").onclick = () => go(idx - 1);
    $("next") && ($("next").onclick = () => go(idx + 1));
    $("submit").onclick = () => submit(false);
    $("flag").onclick = () => {
      a.flagged = !a.flagged;
      dirty.add(qq.id);
      schedule(300);
      render();
    };
  }
  const go = (i) => {
    if (i < 0 || i >= questions.length) return;
    idx = i;
    render();
  };
  document.addEventListener("keydown", (e) => {
    if (
      /input|select|textarea/i.test(e.target.tagName) ||
      e.ctrlKey ||
      e.metaKey
    )
      return;
    if (e.key === "ArrowRight") go(idx + 1);
    if (e.key === "ArrowLeft") go(idx - 1);
  });

  // ---- timer ----
  const warned = new Set();
  let finishing = false;
  const tick = setInterval(() => {
    const left = Math.max(
        0,
        Math.round((deadline - (Date.now() + skew)) / 1000),
      ),
      t = $("timer");
    if (!t) return;
    t.textContent = `${String(Math.floor(left / 60)).padStart(2, "0")}:${String(left % 60).padStart(2, "0")}`;
    t.className =
      "timer " + (left <= 60 ? "danger" : left <= 300 ? "warn" : "");
    [
      [300, "5 minutes left"],
      [60, "1 minute left!"],
      [30, "30 seconds left!"],
    ].forEach(([s, msg]) => {
      if (
        left <= s &&
        left > 0 &&
        !warned.has(s) &&
        quiz.duration_seconds > s * 1.5
      ) {
        warned.add(s);
        toast(msg, s <= 60 ? "error" : "");
      }
    });
    if (left === 0 && !finishing && !preview) {
      finishing = true;
      toast("Time is up. Submitting your answers...", "error");
      submit(true);
    }
  }, 250);

  // ---- submit ----
  async function submit(auto) {
    if (preview) {
      toast("Preview finished. Nothing was saved.");
      return;
    }
    if (!auto) {
      const un = questions.filter((qq) => {
          const a = answers.get(qq.id).answer;
          return !(a && Object.keys(a).length);
        }).length,
        fl = questions.filter((qq) => answers.get(qq.id).flagged).length;
      const ok = await confirmBox(
        `<h3>Submit quiz?</h3><p>${un ? `<b>${un}</b> question${un > 1 ? "s are" : " is"} unanswered. ` : "All questions are answered. "}${fl ? `<b>${fl}</b> marked for review. ` : ""}You cannot change answers after submitting.</p>`,
        { ok: "Submit", cancel: "Keep working" },
      );
      if (!ok) return;
    }
    finishing = true;
    clearInterval(tick);
    $("submit") && ($("submit").disabled = true);
    await flush();
    try {
      await rpc("submit_attempt", { p_attempt: attemptId });
      invalidateNavXP(); // the attempt earned XP
      window.onbeforeunload = null;
      location.replace("result.html?attempt=" + attemptId);
    } catch (e) {
      finishing = false;
      toast(e.message, "error");
      $("submit") && ($("submit").disabled = false);
    }
  }
  window.onbeforeunload = () =>
    dirty.size ? "Your latest answers are still saving." : undefined;
  render();
}
