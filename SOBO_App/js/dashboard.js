// Student dashboard: assessment overview, performance, recent activity, recommendations, achievements.
import {
  $,
  esc,
  rpc,
  mountNav,
  fmtDate,
  fmtDay,
  pct,
  lineChart,
  barChart,
  setNavXP,
} from "./session.js";

const ICON = {
  first: "\u{1F331}",
  perfect: "\u{1F3AF}",
  five: "\u{1F4DA}",
  passer: "\u{2705}",
  high: "\u{1F3C6}",
  explorer: "\u{1F9ED}",
  regular: "\u{1F4C5}",
};

export async function initDashboard(profile) {
  mountNav(profile, "dashboard", { xp: false });
  $("hi").textContent = `Welcome back, ${profile.name}`;
  let d, quizzes;
  try {
    [d, quizzes] = await Promise.all([
      rpc("my_dashboard"),
      rpc("student_quizzes"),
    ]);
  } catch (e) {
    console.error(e);
    $("root").innerHTML =
      `<div class="card"><p class="msg error">${esc(e.message)}</p><p class="muted">Have you run <code>supabase/assessment_v2.sql</code>?</p></div>`;
    return;
  }

  const o = d.overview,
    p = d.performance,
    g = d.gamification;
  setNavXP(g);
  $("overview").innerHTML = [
    ["Assigned", o.assigned],
    ["Completed", o.completed],
    ["Pending", o.pending],
    ["In progress", o.in_progress],
    ["Passed", o.passed, "ok"],
    ["Failed", o.failed, o.failed ? "bad" : ""],
  ]
    .map(
      ([l, v, c]) =>
        `<div class="stat ${c || ""}"><b>${v}</b><span>${l}</span></div>`,
    )
    .join("");

  $("perf").innerHTML =
    `<div class="grid"><div class="stat"><b>${pct(p.average)}</b><span>Average score</span></div><div class="stat"><b>${pct(p.highest)}</b><span>Highest</span></div>
    <div class="stat"><b>${p.attempts}</b><span>Attempts</span></div></div>
    <p class="small muted">Course progress: ${o.completed} of ${o.assigned} quizzes done</p><div class="prog"><i style="width:${p.progress}%"></i></div>
    <h3 style="margin-top:16px">Score trend</h3><div id="trend"></div>`;
  lineChart(
    $("trend"),
    d.trend.map((t, i) => ({
      label: `${t.title} (${fmtDay(t.at)})`,
      value: Number(t.percentage),
      short: i + 1,
    })),
  );

  // Continue learning + resume quiz
  const open = quizzes.find((z) => z.status === "IN_PROGRESS");
  const todo = quizzes
    .filter((z) => z.status === "NOT_STARTED" && z.can_start)
    .slice(0, 3);
  $("cont").innerHTML =
    (open
      ? `<div class="feedback bad" style="margin-bottom:10px"><b>Quiz in progress:</b> ${esc(open.title)} <a class="btn small" href="assessment.html?attempt=${open.in_progress_attempt_id}">Resume</a></div>`
      : "") +
    (d.continue_learning.length
      ? `<ul class="list">${d.continue_learning.map((c) => `<li><span><b>${esc(c.name)}</b> <span class="muted small">${esc(c.system_name)} &middot; ${fmtDate(c.at)}</span></span><a class="btn small secondary" href="learn.html?structure=${c.structure_id}">Continue</a></li>`).join("")}</ul>`
      : '<p class="muted">You have not opened any structure yet. <a href="learn.html">Start exploring in Learn Mode</a>.</p>') +
    (todo.length
      ? `<h3 style="margin-top:12px">Up next</h3><ul class="list">${todo.map((z) => `<li><span>${esc(z.title)} <span class="muted small">${z.question_count} questions</span></span><a class="btn small" href="assessment.html?quiz=${z.id}">Start</a></li>`).join("")}</ul>`
      : "");

  $("recent").innerHTML = d.recent.length
    ? `<ul class="list">${d.recent
        .map(
          (
            r,
          ) => `<li><span><b>${esc(r.title)}</b><br><span class="muted small">${fmtDate(r.at)}</span></span>
      <span><span class="chip ${r.passed ? "ok" : "bad"}">${pct(r.percentage)} ${r.passed ? "Passed" : "Failed"}</span> <a class="btn small secondary" href="result.html?attempt=${r.attempt_id}">Review</a></span></li>`,
        )
        .join("")}</ul>`
    : '<p class="muted">No quiz attempts yet.</p>';

  // Recommended learning from weak areas
  const weakTopics = d.topics.filter((t) => Number(t.pct) < 70).slice(0, 3);
  const ids = d.weak_structures.map((s) => s.id);
  $("reco").innerHTML =
    weakTopics.length || d.weak_structures.length
      ? `
    ${weakTopics.length ? `<h3>Topics to revise</h3>${weakTopics.map((t) => `<div class="bar"><span class="bl">${esc(t.name)}</span><span class="bt"><i class="${Number(t.pct) < 50 ? "bad" : "mid"}" style="width:${t.pct}%"></i></span><span class="bv">${pct(t.pct)}</span></div>`).join("")}` : ""}
    ${
      d.weak_structures.length
        ? `<h3 style="margin-top:12px">Structures you missed most</h3><ul class="list">${d.weak_structures.map((s) => `<li><span>${esc(s.name)} <span class="muted small">${esc(s.system_name)} &middot; missed ${s.missed}x</span></span><a class="btn small secondary" href="learn.html?structure=${s.id}">Study</a></li>`).join("")}</ul>
      <a class="btn" style="margin-top:8px" href="learn.html?structures=${ids.join(",")}">Study all in Learn Mode</a>`
        : ""
    }`
      : '<p class="muted">Complete a quiz and we will recommend what to revise.</p>';

  $("topics").innerHTML = "";
  barChart(
    $("topics"),
    d.topics.map((t) => ({
      label: t.name,
      value: Number(t.pct),
      note: `${t.questions} q`,
    })),
  );

  $("ach").innerHTML =
    `<div class="row sp"><div><b style="font-size:1.4rem">Level ${g.level}</b> <span class="muted">${g.xp} XP</span></div><span class="small muted">${g.next_level_xp - g.xp} XP to level ${g.level + 1}</span></div>
    <div class="prog" style="margin:6px 0 14px"><i style="width:${g.level_progress}%"></i></div>
    <div class="badges">${g.badges.map((b) => `<div class="badge ${b.earned ? "on" : ""}" title="${esc(b.desc)}"><span class="ic">${ICON[b.key] || "\u{2B50}"}</span><b>${esc(b.name)}</b><br><span class="small">${esc(b.desc)}</span></div>`).join("")}</div>
    <p class="small muted" style="margin-top:10px">XP: 20 + half your score for every quiz attempt, plus 5 for each different structure you study (up to 100).</p>`;
}
