// Result page: summary, answer review with explanations, 3D answer review, analytics, reports.
import {
  $,
  esc,
  rpc,
  mountNav,
  fmtDate,
  fmtDur,
  pct,
  lineChart,
  barChart,
  downloadCSV,
  titleCase,
} from "./session.js";
import { mountScene, itemsFromObjects, TYPE_LABEL } from "./assessment.js";

const STATUS = {
  CORRECT: ["Correct", "ok"],
  INCORRECT: ["Incorrect", "bad"],
  PARTIAL: ["Partly correct", "mid"],
  UNANSWERED: ["Not answered", ""],
};

export async function initResult(profile) {
  const isAdmin = profile.role === "ADMIN";
  mountNav(profile, isAdmin ? "attempts" : "history");
  const id = new URLSearchParams(location.search).get("attempt");
  if (!id) {
    $("root").innerHTML =
      '<div class="card"><p class="msg error">No attempt selected.</p></div>';
    return;
  }
  let r;
  try {
    r = await rpc("get_result", { p_attempt: id });
  } catch (e) {
    console.error(e);
    $("root").innerHTML =
      `<div class="card"><p class="msg error">${esc(e.message)}</p><a class="btn secondary" href="${isAdmin ? "../admin/attempts.html" : "history.html"}">Back</a></div>`;
    return;
  }
  const a = r.attempt,
    z = r.quiz,
    c = r.counts,
    qs = r.questions,
    showKey = z.show_correct_answers || isAdmin;
  document.title = `Result: ${z.title}`;

  // ---- summary ----
  const mistakes = qs.filter((q) => q.status !== "CORRECT");
  const relatedIds = [
    ...new Set(mistakes.flatMap((q) => (q.related || []).map((s) => s.id))),
  ];
  $("summary").innerHTML = `<div class="result-top">
    <div class="score-ring" style="--p:${a.percentage};--c:${a.passed ? "#34d399" : "#f87171"}"><span>${pct(a.percentage)}</span></div>
    <div style="flex:1;min-width:240px"><h1 style="margin:0">${esc(z.title)}</h1>
      <p style="margin:.3em 0"><span class="chip ${a.passed ? "ok" : "bad"}">${a.passed ? "Passed" : "Not passed"}</span> <span class="muted small">pass mark ${pct(z.passing_score)}${a.status === "TIMEOUT" ? " &middot; time ran out" : ""}${isAdmin ? ` &middot; student: ${esc(a.student)}` : ""}</span></p>
      <p class="muted small">Submitted ${fmtDate(a.submitted_at)} &middot; time taken ${fmtDur(a.time_taken_seconds)} of ${fmtDur(z.duration_seconds)}</p>
      <div class="row noprint">
        ${!isAdmin && r.can_retake ? `<a class="btn" href="assessment.html?quiz=${z.id}">Retake${r.attempts_left != null ? ` (${r.attempts_left} left)` : ""}</a>` : ""}
        ${!isAdmin && showKey && relatedIds.length ? `<a class="btn secondary" href="learn.html?structures=${relatedIds.slice(0, 40).join(",")}">Learn from mistakes (${relatedIds.length})</a>` : ""}
        <button class="btn secondary" id="csv">Download CSV</button><button class="btn secondary" id="print">Print / Save as PDF</button>
        <a class="btn secondary" href="${isAdmin ? "../admin/attempts.html" : "history.html"}">${isAdmin ? "All attempts" : "History"}</a></div></div></div>
    <div class="grid" style="margin-top:16px"><div class="stat"><b>${a.score} / ${a.total_points}</b><span>Points</span></div><div class="stat ok"><b>${c.correct}</b><span>Correct</span></div>
      <div class="stat bad"><b>${c.incorrect}</b><span>Incorrect / partial</span></div><div class="stat"><b>${c.unanswered}</b><span>Not answered</span></div></div>
    ${!showKey ? '<p class="feedback bad">The instructor has hidden correct answers and explanations for this quiz.</p>' : ""}`;
  $("print").onclick = () => print();
  $("csv").onclick = () =>
    downloadCSV(`result-${z.title.replace(/\W+/g, "_")}.csv`, [
      [
        "#",
        "Type",
        "Question",
        "Result",
        "Points earned",
        "Points",
        "Your answer",
        "Correct answer",
      ],
      ...qs.map((q) => [
        q.n,
        TYPE_LABEL[q.type],
        q.text,
        STATUS[q.status][0],
        q.earned,
        q.points,
        q.your_answer ?? "",
        showKey ? (q.correct_answer ?? "") : "(hidden)",
      ]),
    ]);

  // ---- analytics: topic-wise for this attempt + improvement over attempts ----
  const bySys = new Map();
  qs.forEach((q) => {
    const k = q.system_name || "General";
    const t = bySys.get(k) || { e: 0, p: 0, n: 0 };
    t.e += Number(q.earned);
    t.p += q.points;
    t.n++;
    bySys.set(k, t);
  });
  barChart(
    $("topics"),
    [...bySys].map(([k, t]) => ({
      label: k,
      value: Math.round((100 * t.e) / t.p),
      note: `${t.n} q`,
    })),
  );
  lineChart(
    $("trend"),
    r.history.map((h, i) => ({
      label: `Attempt ${i + 1} (${fmtDate(h.at)})`,
      value: Number(h.percentage),
      short: i + 1,
    })),
  );
  $("trendNote").textContent =
    r.history.length > 1
      ? `You have taken this quiz ${r.history.length} times.`
      : "Take the quiz again to see your improvement.";

  // ---- review ----
  const has3D =
    showKey &&
    qs.some((q) => q.correct_objects?.length || q.your_objects?.length);
  $("reviewLayout").classList.toggle("no3d", !has3D);
  if (!has3D) $("stage").style.display = "none";
  let filter = "ALL",
    scene = null;
  const draw = () => {
    const list = qs.filter(
      (q) =>
        filter === "ALL" ||
        q.status === filter ||
        (filter === "MISSED" && q.status !== "CORRECT"),
    );
    $("rv").innerHTML = list.length
      ? list
          .map((q) => {
            const [sl, sc] = STATUS[q.status];
            return `<div class="card rv ${q.status}" data-q="${q.id}"><div class="row sp"><b>Q${q.n} <span class="muted small">${esc(TYPE_LABEL[q.type])}${q.system_name ? " &middot; " + esc(q.system_name) : ""}</span></b><span class="chip ${sc}">${sl} &middot; ${q.earned}/${q.points}</span></div>
        <p style="font-weight:600;margin:.5em 0">${esc(q.text)}</p>
        <dl><dt>Your answer</dt><dd class="ans"><pre>${q.your_answer ? esc(q.your_answer) : "<i>No answer</i>"}</pre></dd>
        ${showKey ? `<dt>Correct answer</dt><dd class="ans good"><pre>${esc(q.correct_answer ?? "")}</pre></dd>${q.explanation ? `<dt>Explanation</dt><dd><pre>${esc(q.explanation)}</pre></dd>` : ""}${q.reference ? `<dt>Reference</dt><dd><pre>${esc(q.reference)}</pre></dd>` : ""}` : ""}</dl>
        <div class="row noprint">${showKey && (q.correct_objects?.length || q.your_objects?.length) ? `<button class="btn small secondary" data-3d="${q.id}">Show in 3D</button>` : ""}
        ${!isAdmin && showKey && q.status !== "CORRECT" && q.related?.length ? `<a class="btn small secondary" href="learn.html?structures=${q.related.map((s) => s.id).join(",")}">Study in Learn Mode</a>` : ""}</div></div>`;
          })
          .join("")
      : '<div class="card empty">Nothing here.</div>';
    $("rv")
      .querySelectorAll("[data-3d]")
      .forEach(
        (b) =>
          (b.onclick = () => show3D(qs.find((q) => q.id === b.dataset["3d"]))),
      );
  };
  document.querySelectorAll("#filters button").forEach(
    (b) =>
      (b.onclick = () => {
        filter = b.dataset.f;
        document
          .querySelectorAll("#filters button")
          .forEach((x) => x.setAttribute("aria-selected", x === b));
        draw();
      }),
  );
  draw();

  // 3D answer review: correct structures green, wrong picks red
  async function show3D(q) {
    if (!has3D) return;
    if (!scene) scene = await mountScene($("stage"));
    const key = (o) => o.s + "|" + o.o,
      good = new Set((q.correct_objects || []).map(key));
    const wrong = (q.your_objects || []).filter((o) => !good.has(key(o)));
    const items = [
      ...itemsFromObjects(q.correct_objects, "#2ecc71"),
      ...itemsFromObjects(wrong, "#ff4d4d"),
    ];
    const sys = [
      ...new Set([...(q.correct_objects || []), ...wrong].map((o) => o.s)),
    ];
    if (q.system_id) sys.push(q.system_id);
    scene.setStatus("Loading 3D model...");
    const failed = await scene.ensure(sys);
    scene.setStatus(failed.length ? "Could not load the 3D model." : "");
    scene.show(sys);
    scene.viewer.setMarks(items, {
      ghost: q.type === "IDENTIFY_3D" || q.type === "SYSTEM_IDENTIFICATION",
    });
    scene.viewer.frameItems(items);
    $("legend3d").innerHTML =
      '<span class="chip ok">Correct structure</span> <span class="chip bad">Your wrong selection</span>';
    $("stage").scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}
