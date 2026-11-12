// Admin console: logic for every admin/*.html page. Each page calls initAdmin("<page>").
// Security note: this only drives the UI. All permissions are enforced in the database (RLS + admin-only functions).
import { supabase } from "./supabase.js";
import {
  requireAdmin,
  $,
  esc,
  rpc,
  toast,
  fmtDate,
  fmtDay,
  fmtDur,
  pct,
  titleCase,
  mountNav,
  lineChart,
  barChart,
  downloadCSV,
  confirmBox,
  modelUrlFor,
} from "./session.js";
import {
  mountScene,
  QuestionView,
  PALETTE,
  TYPE_LABEL,
  IS3D,
  itemsFromObjects,
} from "./assessment.js";
import { getModelUrl } from "./anatomy.js";

const db = async (req) => {
  const { data, error } = await req;
  if (error) throw new Error(error.message);
  return data;
};
const chip = (t, c = "") => `<span class="chip ${c}">${esc(t)}</span>`;
const REVIEW_CHIP = { APPROVED: "ok", PENDING: "mid", REJECTED: "bad" };
const TYPES = Object.keys(TYPE_LABEL);
const opt = (v, t, sel) =>
  `<option value="${esc(v)}" ${sel ? "selected" : ""}>${esc(t)}</option>`;
const debounce = (fn, ms = 250) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};
const download = (name, rows) => downloadCSV(name, rows);

function openSheet(title, html) {
  let s = $("sheet");
  if (!s) {
    s = document.createElement("div");
    s.id = "sheet";
    s.className = "sheet";
    document.body.appendChild(s);
  }
  s.innerHTML = `<div class="inner"><div class="row sp"><h2 style="margin:0">${esc(title)}</h2><button class="btn secondary small" id="sheetX">Close</button></div><div id="sheetBody" style="margin-top:12px">${html}</div></div>`;
  s.classList.add("open");
  $("sheetX").onclick = closeSheet;
  return $("sheetBody");
}
const closeSheet = () => $("sheet")?.classList.remove("open");

export async function initAdmin(page) {
  const me = await requireAdmin();
  mountNav(me, page);
  try {
    await PAGES[page](me);
  } catch (e) {
    console.error(e);
    $("root").innerHTML =
      `<div class="card"><p class="msg error">${esc(e.message)}</p><p class="muted">If this mentions a missing function or column, run <code>supabase/assessment_v2.sql</code> in the SQL Editor.</p></div>`;
  }
}

// ======================================================================
// DASHBOARD
// ======================================================================
async function dashboard() {
  const [o, people] = await Promise.all([
    rpc("admin_overview"),
    rpc("admin_student_stats"),
  ]);
  const students = people.filter((p) => p.role === "STUDENT");
  const stat = (v, l, cls = "") =>
    `<div class="stat ${cls}"><b>${v}</b><span>${l}</span></div>`;
  const pending = o.questions.pending_review + o.structures_pending_review;
  $("root").innerHTML = `<h1>Admin dashboard</h1>
    ${pending ? `<div class="feedback bad" style="margin-bottom:14px"><b>${pending} item(s) awaiting medical review</b>: ${o.questions.pending_review} question(s) <a href="questions.html?review=PENDING">review</a>, ${o.structures_pending_review} structure(s) <a href="anatomy.html?review=PENDING">review</a>.</div>` : ""}
    <div class="grid">${stat(o.students, "Students")}${stat(o.active_users_7d, "Active users (7 days)")}${stat(`${o.quizzes.published} / ${o.quizzes.total}`, "Quizzes published")}${stat(o.questions.total, "Questions in bank")}
      ${stat(o.attempts.total, "Attempts")}${stat(pct(o.avg_score), "Average score")}${stat(pct(o.pass_rate), "Pass rate", "ok")}${stat(pct(o.completion_rate), "Completion rate")}</div>
    <div class="grid two"><section class="card"><h2>Attempts, last 14 days</h2><div id="daily"></div></section><section class="card"><h2>Topic-wise performance</h2><div id="topics"></div></section></div>
    <section class="card" style="margin-top:14px"><h2>Quiz statistics</h2><div class="tblwrap"><table class="tbl"><thead><tr><th>Quiz</th><th>Status</th><th>Attempts</th><th>Avg score</th><th>Pass rate</th><th>Completion</th></tr></thead><tbody>
      ${o.per_quiz.map((q) => `<tr><td>${esc(q.title)}</td><td>${chip(q.status, q.status === "PUBLISHED" ? "ok" : "")}</td><td>${q.attempts}</td><td>${pct(q.avg)}</td><td>${pct(q.pass_rate)}</td><td>${pct(q.completion_rate)}</td></tr>`).join("") || '<tr><td colspan="6" class="empty">No quizzes yet.</td></tr>'}</tbody></table></div></section>
    <div class="grid two" style="margin-top:14px"><section class="card"><h2>Frequently missed questions</h2><div class="tblwrap"><table class="tbl"><thead><tr><th>Question</th><th>Type</th><th>Times seen</th><th>Missed</th></tr></thead><tbody>
      ${o.frequently_wrong.map((q) => `<tr><td>${esc(q.text.slice(0, 90))}</td><td class="small">${esc(TYPE_LABEL[q.type])}</td><td>${q.answered}</td><td><b>${pct(q.wrong_pct)}</b></td></tr>`).join("") || '<tr><td colspan="4" class="empty">No attempts yet.</td></tr>'}</tbody></table></div></section>
      <section class="card"><h2>Student performance</h2><div class="tblwrap"><table class="tbl"><thead><tr><th>Student</th><th>Attempts</th><th>Average</th><th>Best</th></tr></thead><tbody>
      ${
        [...students]
          .sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1))
          .slice(0, 10)
          .map(
            (s) =>
              `<tr><td>${esc(s.name)}</td><td>${s.attempts}</td><td>${pct(s.avg)}</td><td>${pct(s.best)}</td></tr>`,
          )
          .join("") ||
        '<tr><td colspan="4" class="empty">No students yet.</td></tr>'
      }</tbody></table></div>
      <p class="small"><a href="users.html">All students</a> &middot; <a href="reports.html">Reports</a></p></section></div>`;
  const mx = Math.max(5, ...o.daily.map((d) => d.attempts));
  lineChart(
    $("daily"),
    o.daily.map((d) => ({
      label: fmtDay(d.day),
      value: d.attempts,
      short: new Date(d.day).getDate(),
    })),
    { max: mx, suffix: "" },
  );
  barChart(
    $("topics"),
    o.per_system.map((s) => ({
      label: s.name,
      value: Number(s.pct),
      note: `${s.answers} ans`,
    })),
  );
}

// ======================================================================
// USERS & BATCHES
// ======================================================================
async function users(me) {
  $("root").innerHTML =
    `<h1>Users &amp; batches</h1><div class="tabs" id="tabs"><button data-t="u" aria-selected="true">Users</button><button data-t="b" aria-selected="false">Batches</button></div><div id="tab"></div>`;
  let people = [],
    batches = [],
    tab = "u";
  const load = async () => {
    [people, batches] = await Promise.all([
      rpc("admin_student_stats"),
      db(
        supabase
          .from("batches")
          .select("id,name,description,batch_members(count)")
          .order("name"),
      ),
    ]);
  };
  await load();
  document.querySelectorAll("#tabs button").forEach(
    (b) =>
      (b.onclick = () => {
        tab = b.dataset.t;
        document
          .querySelectorAll("#tabs button")
          .forEach((x) => x.setAttribute("aria-selected", x === b));
        draw();
      }),
  );

  function draw() {
    tab === "u" ? drawUsers() : drawBatches();
  }
  function drawUsers() {
    $("tab").innerHTML =
      `<div class="filters"><input id="uText" type="search" placeholder="Search name or email..."><select id="uRole"><option value="">All roles</option><option>STUDENT</option><option>ADMIN</option></select>
      <select id="uBatch"><option value="">All batches</option>${batches.map((b) => opt(b.id, b.name)).join("")}</select><button class="btn secondary" id="uCsv">Export CSV</button></div>
      <div class="tblwrap card" style="padding:0"><table class="tbl"><thead><tr><th>Name</th><th>Role</th><th>Batches</th><th>Attempts</th><th>Avg</th><th>Passed</th><th>Last active</th><th></th></tr></thead><tbody id="uRows"></tbody></table></div>`;
    const rows = () =>
      people.filter(
        (p) =>
          (!$("uRole").value || p.role === $("uRole").value) &&
          (!$("uBatch").value || p.batch_ids.includes($("uBatch").value)) &&
          (!$("uText").value ||
            (p.name + " " + (p.email || ""))
              .toLowerCase()
              .includes($("uText").value.toLowerCase())),
      );
    const paint = () => {
      $("uRows").innerHTML =
        rows()
          .map(
            (
              p,
            ) => `<tr><td><b>${esc(p.name)}</b><br><span class="muted small">${esc(p.email || "")}</span></td><td>${chip(p.role, p.role === "ADMIN" ? "brand" : "")}</td>
        <td>${p.batches.map((n, i) => `<span class="chip">${esc(n)} <button class="btn link" style="padding:0" data-rmb="${p.id}|${p.batch_ids[i]}" aria-label="Remove from batch">&times;</button></span>`).join(" ")}
          <select data-addb="${p.id}" style="width:auto;padding:3px"><option value="">+ batch</option>${batches
            .filter((b) => !p.batch_ids.includes(b.id))
            .map((b) => opt(b.id, b.name))
            .join("")}</select></td>
        <td>${p.attempts}</td><td>${pct(p.avg)}</td><td>${p.passed}</td><td class="small">${p.last_active ? fmtDate(p.last_active) : "-"}</td>
        <td class="nowrap"><a class="btn small secondary" href="attempts.html?user=${p.id}">Attempts</a>
        ${p.id === me.id ? "" : `<button class="btn small secondary" data-role="${p.id}|${p.role === "ADMIN" ? "STUDENT" : "ADMIN"}">${p.role === "ADMIN" ? "Make student" : "Make admin"}</button>`}</td></tr>`,
          )
          .join("") || '<tr><td colspan="8" class="empty">No users.</td></tr>';
      $("uRows")
        .querySelectorAll("[data-addb]")
        .forEach(
          (s) =>
            (s.onchange = async () => {
              if (!s.value) return;
              try {
                await db(
                  supabase
                    .from("batch_members")
                    .upsert(
                      { batch_id: s.value, user_id: s.dataset.addb },
                      {
                        onConflict: "batch_id,user_id",
                        ignoreDuplicates: true,
                      },
                    ),
                );
                await load();
                paint();
              } catch (e) {
                toast(e.message, "error");
              }
            }),
        );
      $("uRows")
        .querySelectorAll("[data-rmb]")
        .forEach(
          (b) =>
            (b.onclick = async () => {
              const [u, bt] = b.dataset.rmb.split("|");
              try {
                await db(
                  supabase
                    .from("batch_members")
                    .delete()
                    .eq("user_id", u)
                    .eq("batch_id", bt),
                );
                await load();
                paint();
              } catch (e) {
                toast(e.message, "error");
              }
            }),
        );
      $("uRows")
        .querySelectorAll("[data-role]")
        .forEach(
          (b) =>
            (b.onclick = async () => {
              const [u, role] = b.dataset.role.split("|"),
                p = people.find((x) => x.id === u);
              if (
                !(await confirmBox(
                  `Change <b>${esc(p.name)}</b> to <b>${role}</b>?`,
                  { ok: "Change role" },
                ))
              )
                return;
              try {
                await db(
                  supabase.from("profiles").update({ role }).eq("id", u),
                );
                await load();
                paint();
                toast("Role updated", "success");
              } catch (e) {
                toast(e.message, "error");
              }
            }),
        );
    };
    ["uText", "uRole", "uBatch"].forEach((i) => ($(i).oninput = paint));
    paint();
    $("uCsv").onclick = () =>
      download("users.csv", [
        [
          "Name",
          "Email",
          "Role",
          "Batches",
          "Attempts",
          "Average %",
          "Best %",
          "Passed",
          "Last active",
        ],
        ...rows().map((p) => [
          p.name,
          p.email,
          p.role,
          p.batches.join("; "),
          p.attempts,
          p.avg,
          p.best,
          p.passed,
          p.last_active,
        ]),
      ]);
  }
  function drawBatches() {
    $("tab").innerHTML =
      `<section class="card"><h3>New batch</h3><div class="row"><input id="bName" placeholder="Batch name, e.g. MBBS 2026" style="flex:1;min-width:200px"><input id="bDesc" placeholder="Description (optional)" style="flex:2;min-width:200px"><button class="btn" id="bAdd">Create</button></div></section>
      <div class="grid cards" style="margin-top:14px">${
        batches
          .map(
            (
              b,
            ) => `<div class="card"><h3>${esc(b.name)}</h3><p class="muted small">${esc(b.description || "")}</p><p>${b.batch_members[0]?.count ?? 0} member(s)</p>
        <div class="row"><button class="btn small" data-mem="${b.id}">Manage members</button><button class="btn small danger" data-del="${b.id}">Delete</button></div></div>`,
          )
          .join("") || '<div class="empty">No batches yet.</div>'
      }</div>`;
    $("bAdd").onclick = async () => {
      const name = $("bName").value.trim();
      if (!name) return toast("Enter a name", "error");
      try {
        await db(
          supabase
            .from("batches")
            .insert({ name, description: $("bDesc").value.trim() || null }),
        );
        await load();
        drawBatches();
      } catch (e) {
        toast(e.message, "error");
      }
    };
    $("tab")
      .querySelectorAll("[data-del]")
      .forEach(
        (b) =>
          (b.onclick = async () => {
            if (
              !(await confirmBox(
                "Delete this batch? Students stay; quiz assignments to this batch are removed.",
                { ok: "Delete" },
              ))
            )
              return;
            try {
              await db(
                supabase.from("batches").delete().eq("id", b.dataset.del),
              );
              await load();
              drawBatches();
            } catch (e) {
              toast(e.message, "error");
            }
          }),
      );
    $("tab")
      .querySelectorAll("[data-mem]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            members(batches.find((x) => x.id === b.dataset.mem))),
      );
  }
  function members(b) {
    const body = openSheet(
      `Members of ${b.name}`,
      '<input id="mText" type="search" placeholder="Filter students..."><div id="mList" style="margin-top:10px"></div>',
    );
    const paint = () => {
      const t = $("mText").value.toLowerCase();
      $("mList").innerHTML =
        people
          .filter(
            (p) =>
              p.role === "STUDENT" &&
              (p.name + (p.email || "")).toLowerCase().includes(t),
          )
          .map(
            (p) =>
              `<label class="chk"><input type="checkbox" data-u="${p.id}" ${p.batch_ids.includes(b.id) ? "checked" : ""}> ${esc(p.name)} <span class="muted small">${esc(p.email || "")}</span></label>`,
          )
          .join("") || '<p class="empty">No students.</p>';
      $("mList")
        .querySelectorAll("input")
        .forEach(
          (c) =>
            (c.onchange = async () => {
              try {
                if (c.checked)
                  await db(
                    supabase
                      .from("batch_members")
                      .upsert(
                        { batch_id: b.id, user_id: c.dataset.u },
                        {
                          onConflict: "batch_id,user_id",
                          ignoreDuplicates: true,
                        },
                      ),
                  );
                else
                  await db(
                    supabase
                      .from("batch_members")
                      .delete()
                      .eq("batch_id", b.id)
                      .eq("user_id", c.dataset.u),
                  );
                await load();
              } catch (e) {
                toast(e.message, "error");
                c.checked = !c.checked;
              }
            }),
        );
    };
    $("mText").oninput = paint;
    paint();
    $("sheetX").onclick = async () => {
      closeSheet();
      await load();
      drawBatches();
    };
  }
  draw();
}

// ======================================================================
// ANATOMY CONTENT (edit + medical review)
// ======================================================================
async function anatomy() {
  const systems = await db(
    supabase.from("anatomy_systems").select("id,name").order("display_order"),
  );
  const qp = new URLSearchParams(location.search);
  $("root").innerHTML =
    `<h1>Anatomy content</h1><p class="muted">Edit the teaching text shown in Learn Mode and record medical review. Models are managed under <a href="models.html">Models</a>.</p>
    <div class="filters"><select id="aSys">${systems.map((s) => opt(s.id, s.name)).join("")}</select><input id="aText" type="search" placeholder="Search structures...">
      <select id="aRev"><option value="">Any review status</option>${["PENDING", "APPROVED", "REJECTED"].map((r) => opt(r, titleCase(r), r === qp.get("review"))).join("")}</select>
      <button class="btn secondary" id="aAdd">+ Add structure</button></div>
    <div class="row noprint" style="margin-bottom:8px"><button class="btn small secondary" data-bulk="APPROVED">Approve selected</button><button class="btn small secondary" data-bulk="REJECTED">Reject selected</button><button class="btn small secondary" data-bulk="PENDING">Mark pending</button><span class="muted small" id="aInfo"></span></div>
    <div class="card tblwrap" style="padding:0"><table class="tbl"><thead><tr><th><input type="checkbox" id="aAll" aria-label="Select all"></th><th>Name</th><th>Parent</th><th>3D object</th><th>Text</th><th>Review</th><th></th></tr></thead><tbody id="aRows"></tbody></table></div>
    <div class="row" style="margin-top:8px"><button class="btn secondary small" id="aPrev">Previous</button><button class="btn secondary small" id="aNext">Next</button><span class="muted small" id="aPage"></span></div>`;
  let rows = [],
    page = 0;
  const PER = 60,
    byId = new Map();
  async function load() {
    rows = await db(
      supabase
        .from("anatomy_structures")
        .select(
          "id,name,parent_id,model_object_id,description,location,function,important_features,review_status,system_id",
        )
        .eq("system_id", $("aSys").value)
        .order("display_order")
        .order("name")
        .limit(3000),
    );
    byId.clear();
    rows.forEach((r) => byId.set(r.id, r));
    page = 0;
    paint();
  }
  const filtered = () =>
    rows.filter(
      (r) =>
        (!$("aRev").value || r.review_status === $("aRev").value) &&
        (!$("aText").value ||
          r.name.toLowerCase().includes($("aText").value.toLowerCase())),
    );
  function paint() {
    const f = filtered(),
      pages = Math.max(1, Math.ceil(f.length / PER));
    page = Math.min(page, pages - 1);
    $("aRows").innerHTML =
      f
        .slice(page * PER, page * PER + PER)
        .map(
          (
            r,
          ) => `<tr><td><input type="checkbox" data-sel="${r.id}"></td><td><b>${esc(r.name)}</b></td><td class="small muted">${esc(byId.get(r.parent_id)?.name || "")}</td><td class="small">${esc(r.model_object_id || "(group)")}</td>
      <td class="small">${[r.description, r.location, r.function].filter(Boolean).length ? chip("has text", "ok") : chip("empty")}</td><td>${chip(r.review_status, REVIEW_CHIP[r.review_status])}</td><td><button class="btn small secondary" data-edit="${r.id}">Edit</button></td></tr>`,
        )
        .join("") ||
      '<tr><td colspan="7" class="empty">No structures.</td></tr>';
    $("aPage").textContent =
      `Page ${page + 1} of ${pages} (${f.length} structures)`;
    $("aRows")
      .querySelectorAll("[data-edit]")
      .forEach((b) => (b.onclick = () => edit(byId.get(b.dataset.edit))));
  }
  ["aText", "aRev"].forEach(
    (i) =>
      ($(i).oninput = () => {
        page = 0;
        paint();
      }),
  );
  $("aSys").onchange = load;
  $("aPrev").onclick = () => {
    page = Math.max(0, page - 1);
    paint();
  };
  $("aNext").onclick = () => {
    page++;
    paint();
  };
  $("aAll").onchange = () =>
    $("aRows")
      .querySelectorAll("[data-sel]")
      .forEach((c) => (c.checked = $("aAll").checked));
  document.querySelectorAll("[data-bulk]").forEach(
    (b) =>
      (b.onclick = async () => {
        const ids = [...$("aRows").querySelectorAll("[data-sel]:checked")].map(
          (c) => c.dataset.sel,
        );
        if (!ids.length) return toast("Tick some rows first", "error");
        try {
          const n = await rpc("admin_review_structures", {
            p_ids: ids,
            p_status: b.dataset.bulk,
          });
          toast(`${n} updated`, "success");
          await load();
        } catch (e) {
          toast(e.message, "error");
        }
      }),
  );
  function edit(r) {
    const f = (k, label, area) =>
      `<div class="field"><label for="e_${k}">${label}</label>${area ? `<textarea id="e_${k}">${esc(r[k] || "")}</textarea>` : `<input id="e_${k}" value="${esc(r[k] || "")}">`}</div>`;
    openSheet(
      `Edit: ${r.name}`,
      `${f("name", "Name")}${f("description", "Description", 1)}${f("location", "Location", 1)}${f("function", "Function", 1)}${f("important_features", "Important features", 1)}
      <div class="field"><label for="e_rev">Medical review</label><select id="e_rev">${["PENDING", "APPROVED", "REJECTED"].map((x) => opt(x, titleCase(x), x === r.review_status)).join("")}</select></div>
      <button class="btn" id="e_save">Save</button>`,
    );
    $("e_save").onclick = async () => {
      const patch = {};
      [
        "name",
        "description",
        "location",
        "function",
        "important_features",
      ].forEach((k) => (patch[k] = $("e_" + k).value.trim() || null));
      if (!patch.name) return toast("Name is required", "error");
      try {
        await db(
          supabase.from("anatomy_structures").update(patch).eq("id", r.id),
        );
        await rpc("admin_review_structures", {
          p_ids: [r.id],
          p_status: $("e_rev").value,
        });
        closeSheet();
        toast("Saved", "success");
        await load();
      } catch (e) {
        toast(e.message, "error");
      }
    };
  }
  $("aAdd").onclick = () => {
    const groups = rows.filter((r) => !r.model_object_id);
    openSheet(
      "Add structure",
      `<div class="field"><label for="n_name">Name</label><input id="n_name"></div><div class="field"><label for="n_par">Parent group (optional)</label><select id="n_par"><option value="">(top level)</option>${groups.map((g) => opt(g.id, g.name)).join("")}</select></div>
      <div class="field"><label for="n_obj">3D object name (optional, must match the node name in the GLB)</label><input id="n_obj"></div><button class="btn" id="n_save">Add</button>`,
    );
    $("n_save").onclick = async () => {
      const name = $("n_name").value.trim();
      if (!name) return toast("Name is required", "error");
      try {
        await db(
          supabase
            .from("anatomy_structures")
            .insert({
              name,
              system_id: $("aSys").value,
              parent_id: $("n_par").value || null,
              model_object_id: $("n_obj").value.trim() || null,
              model_file_path:
                rows.find((r) => r.model_file_path)?.model_file_path ?? null,
              review_status: "PENDING",
            }),
        );
        closeSheet();
        toast("Added (pending review)", "success");
        await load();
      } catch (e) {
        toast(e.message, "error");
      }
    };
  };
  if (qp.get("review")) $("aRev").value = qp.get("review");
  await load();
}

// ======================================================================
// MODELS (Storage + which file each system uses)
// ======================================================================
async function models() {
  const [systems, structs] = await Promise.all([
    db(
      supabase.from("anatomy_systems").select("id,name").order("display_order"),
    ),
    db(
      supabase
        .from("anatomy_structures")
        .select("system_id,model_file_path,model_object_id")
        .limit(10000),
    ),
  ]);
  const per = new Map(
    systems.map((s) => [s.id, { paths: new Map(), total: 0, withObj: 0 }]),
  );
  structs.forEach((r) => {
    const e = per.get(r.system_id);
    if (!e) return;
    e.total++;
    if (r.model_object_id) e.withObj++;
    const k = r.model_file_path || "";
    e.paths.set(k, (e.paths.get(k) || 0) + 1);
  });
  $("root").innerHTML = `<h1>3D models</h1>
    <section class="card"><h2>Model file used by each system</h2><p class="muted small">Learn and Assessment load <code>anatomy-models/&lt;path&gt;</code> for every structure row of a system. Use <b>Test</b> to check the file really opens.</p>
      <div class="tblwrap"><table class="tbl"><thead><tr><th>System</th><th>Structures</th><th>Current path(s)</th><th>Set new path for the whole system</th><th></th></tr></thead><tbody>
      ${systems
        .map((s) => {
          const e = per.get(s.id),
            cur = [...e.paths].filter(([k]) => k).sort((a, b) => b[1] - a[1]);
          return `<tr><td><b>${esc(s.name)}</b></td><td>${e.total} <span class="muted small">(${e.withObj} with 3D object)</span></td>
        <td class="small">${cur.map(([k, n]) => `<code>${esc(k)}</code> &times;${n} <button class="btn link" data-test="${esc(k)}">Test</button>`).join("<br>") || '<span class="muted">none</span>'}${e.paths.has("") ? `<br><span class="muted">${e.paths.get("")} without path</span>` : ""}</td>
        <td><input data-path="${s.id}" placeholder="folder/file.glb" value="${esc(cur[0]?.[0] || "")}"></td><td class="nowrap"><button class="btn small" data-apply="${s.id}">Apply</button> <button class="btn small secondary" data-clear="${s.id}">Clear</button></td></tr>`;
        })
        .join("")}</tbody></table></div>
      <p class="small muted" id="testOut"></p></section>
    <section class="card"><h2>Upload a model</h2><div class="row"><input id="upFolder" placeholder="folder (e.g. Nervous)" style="max-width:220px"><input id="upFile" type="file" accept=".glb,.gltf,.bin" style="max-width:340px"><button class="btn" id="upBtn">Upload</button></div>
      <p class="hint">Use a single <b>.glb</b> file. A <code>.gltf</code> needs its <code>.bin</code> next to it; a GLB does not.</p>
      <p class="hint">Replacing a model? Upload it under a new name (e.g. <code>skeleton-v2.glb</code>) and Apply that path. Overwriting the same name can keep serving the old file from the CDN and browsers for a while.</p></section>
    <section class="card"><h2>Storage browser</h2><div class="row"><button class="btn secondary small" id="stRoot">Root</button><span id="stPath" class="muted"></span></div><div class="tblwrap"><table class="tbl"><thead><tr><th>Name</th><th>Size</th><th></th></tr></thead><tbody id="stRows"></tbody></table></div></section>`;
  const bucket = supabase.storage.from("anatomy-models");
  const test = async (path) => {
    $("testOut").textContent = `Testing ${path}...`;
    try {
      const r = await fetch(getModelUrl(path), { method: "HEAD" });
      $("testOut").innerHTML = r.ok
        ? `<b style="color:var(--ok)">OK</b> ${esc(path)} (${r.status}, ${r.headers.get("content-length") ? (r.headers.get("content-length") / 1048576).toFixed(1) + " MB" : "size unknown"})${/\.gltf$/i.test(path) ? " &mdash; .gltf also needs its .bin file" : ""}`
        : `<b style="color:var(--err)">Failed (${r.status})</b> ${esc(path)}: the file does not exist at that exact path (names are case-sensitive).`;
    } catch (e) {
      $("testOut").textContent = "Network error: " + e.message;
    }
  };
  document
    .querySelectorAll("[data-test]")
    .forEach((b) => (b.onclick = () => test(b.dataset.test)));
  document.querySelectorAll("[data-apply]").forEach(
    (b) =>
      (b.onclick = async () => {
        const path = document
          .querySelector(`[data-path="${b.dataset.apply}"]`)
          .value.trim();
        if (!path) return toast("Enter a path", "error");
        if (
          !(await confirmBox(
            `Point every structure of this system at <code>${esc(path)}</code>?`,
            { ok: "Apply" },
          ))
        )
          return;
        try {
          await db(
            supabase
              .from("anatomy_structures")
              .update({ model_file_path: path })
              .eq("system_id", b.dataset.apply),
          );
          toast("Updated", "success");
          models();
        } catch (e) {
          toast(e.message, "error");
        }
      }),
  );
  document.querySelectorAll("[data-clear]").forEach(
    (b) =>
      (b.onclick = async () => {
        if (
          !(await confirmBox(
            "Remove the model path from this system? Learn will show no 3D model for it.",
            { ok: "Clear" },
          ))
        )
          return;
        try {
          await db(
            supabase
              .from("anatomy_structures")
              .update({ model_file_path: null })
              .eq("system_id", b.dataset.clear),
          );
          toast("Cleared", "success");
          models();
        } catch (e) {
          toast(e.message, "error");
        }
      }),
  );
  $("upBtn").onclick = async () => {
    const f = $("upFile").files[0];
    if (!f) return toast("Choose a file", "error");
    const folder = $("upFolder")
      .value.trim()
      .replace(/^\/+|\/+$/g, "");
    $("upBtn").disabled = true;
    try {
      const path = (folder ? folder + "/" : "") + f.name;
      const { error } = await bucket.upload(path, f, {
        upsert: true,
        cacheControl: "86400", // browsers keep it a day (default is 1 hour); new versions should use a new file name
        contentType: f.name.endsWith(".glb") ? "model/gltf-binary" : undefined,
      });
      if (error) throw error;
      toast("Uploaded " + path, "success");
      browse(folder);
    } catch (e) {
      toast(e.message, "error");
    } finally {
      $("upBtn").disabled = false;
    }
  };
  async function browse(path = "") {
    $("stPath").textContent = "/" + path;
    const { data, error } = await bucket.list(path, {
      limit: 200,
      sortBy: { column: "name", order: "asc" },
    });
    if (error) {
      $("stRows").innerHTML =
        `<tr><td colspan="3" class="msg error">${esc(error.message)}</td></tr>`;
      return;
    }
    $("stRows").innerHTML =
      (path
        ? `<tr><td><a href="#" data-dir="${esc(path.split("/").slice(0, -1).join("/"))}">&larr; up</a></td><td></td><td></td></tr>`
        : "") +
        data
          .filter((o) => o.name !== ".emptyFolderPlaceholder")
          .map((o) => {
            const isDir = !o.id,
              full = (path ? path + "/" : "") + o.name;
            return `<tr><td>${isDir ? `<a href="#" data-dir="${esc(full)}">&#128193; ${esc(o.name)}</a>` : esc(o.name)}</td><td>${isDir ? "" : ((o.metadata?.size || 0) / 1048576).toFixed(2) + " MB"}</td>
        <td class="nowrap">${isDir ? "" : `<button class="btn small secondary" data-use="${esc(full)}">Copy path</button> <button class="btn small secondary" data-test="${esc(full)}">Test</button> <button class="btn small danger" data-rm="${esc(full)}">Delete</button>`}</td></tr>`;
          })
          .join("") || '<tr><td colspan="3" class="empty">Empty.</td></tr>';
    $("stRows")
      .querySelectorAll("[data-dir]")
      .forEach(
        (a) =>
          (a.onclick = (e) => {
            e.preventDefault();
            browse(a.dataset.dir);
          }),
      );
    $("stRows")
      .querySelectorAll("[data-test]")
      .forEach((b) => (b.onclick = () => test(b.dataset.test)));
    $("stRows")
      .querySelectorAll("[data-use]")
      .forEach(
        (b) =>
          (b.onclick = () => {
            navigator.clipboard?.writeText(b.dataset.use);
            toast("Copied: " + b.dataset.use);
          }),
      );
    $("stRows")
      .querySelectorAll("[data-rm]")
      .forEach(
        (b) =>
          (b.onclick = async () => {
            if (
              !(await confirmBox(
                `Delete <code>${esc(b.dataset.rm)}</code>? Systems using it will stop loading.`,
                { ok: "Delete" },
              ))
            )
              return;
            const { error } = await bucket.remove([b.dataset.rm]);
            error
              ? toast(error.message, "error")
              : (toast("Deleted", "success"), browse(path));
          }),
      );
  }
  $("stRoot").onclick = () => browse("");
  browse("");
}

// ======================================================================
// ATTEMPTS
// ======================================================================
async function attempts() {
  const qp = new URLSearchParams(location.search);
  const [all, quizzes] = await Promise.all([
    rpc("admin_attempts", { p_quiz: qp.get("quiz"), p_user: qp.get("user") }),
    db(supabase.from("quizzes").select("id,title").order("title")),
  ]);
  $("root").innerHTML =
    `<h1>Attempts</h1>${qp.get("user") || qp.get("quiz") ? '<p><a href="attempts.html">&larr; Show all attempts</a></p>' : ""}
    <div class="filters"><input id="tText" type="search" placeholder="Search student..."><select id="tQuiz"><option value="">All quizzes</option>${quizzes.map((q) => opt(q.title, q.title)).join("")}</select>
      <select id="tSt"><option value="">Any status</option><option>COMPLETED</option><option>TIMEOUT</option><option>IN_PROGRESS</option></select><select id="tRes"><option value="">Passed and failed</option><option value="P">Passed</option><option value="F">Failed</option></select><button class="btn secondary" id="tCsv">Export CSV</button></div>
    <div class="card tblwrap" style="padding:0"><table class="tbl"><thead><tr><th>Started</th><th>Student</th><th>Quiz</th><th>Score</th><th>Time</th><th>Status</th><th></th></tr></thead><tbody id="tRows"></tbody></table></div><p class="small muted" id="tCount"></p>`;
  const view = () =>
    all.filter(
      (a) =>
        (!$("tQuiz").value || a.quiz === $("tQuiz").value) &&
        (!$("tSt").value || a.status === $("tSt").value) &&
        (!$("tRes").value ||
          (a.status !== "IN_PROGRESS" &&
            (a.passed ? "P" : "F") === $("tRes").value)) &&
        (!$("tText").value ||
          (a.student + " " + (a.email || ""))
            .toLowerCase()
            .includes($("tText").value.toLowerCase())),
    );
  const paint = () => {
    const v = view();
    $("tCount").textContent =
      `${v.length} attempt(s)` + (all.length >= 1000 ? " (latest 1000)" : "");
    $("tRows").innerHTML =
      v
        .map(
          (
            a,
          ) => `<tr><td class="small nowrap">${fmtDate(a.started_at)}</td><td>${esc(a.student)}<br><span class="muted small">${esc(a.email || "")}</span></td><td>${esc(a.quiz)}</td>
      <td>${a.status === "IN_PROGRESS" ? "-" : `<b>${pct(a.percentage)}</b> <span class="muted small">${a.score}/${a.total_points}</span> ${chip(a.passed ? "Passed" : "Failed", a.passed ? "ok" : "bad")}`}</td><td>${a.time_taken_seconds != null ? fmtDur(a.time_taken_seconds) : "-"}</td>
      <td>${chip(a.status, a.status === "COMPLETED" ? "ok" : a.status === "TIMEOUT" ? "mid" : "")}</td><td class="nowrap">${a.status !== "IN_PROGRESS" ? `<a class="btn small secondary" href="../student/result.html?attempt=${a.id}">View</a>` : ""} <button class="btn small danger" data-del="${a.id}">Delete</button></td></tr>`,
        )
        .join("") || '<tr><td colspan="7" class="empty">No attempts.</td></tr>';
    $("tRows")
      .querySelectorAll("[data-del]")
      .forEach(
        (b) =>
          (b.onclick = async () => {
            if (
              !(await confirmBox(
                "Delete this attempt and its answers? The student will get that attempt back.",
                { ok: "Delete" },
              ))
            )
              return;
            try {
              await db(
                supabase
                  .from("assessment_attempts")
                  .delete()
                  .eq("id", b.dataset.del),
              );
              all.splice(
                all.findIndex((a) => a.id === b.dataset.del),
                1,
              );
              paint();
              toast("Deleted", "success");
            } catch (e) {
              toast(e.message, "error");
            }
          }),
      );
  };
  ["tText", "tQuiz", "tSt", "tRes"].forEach((i) => ($(i).oninput = paint));
  paint();
  $("tCsv").onclick = () =>
    download("attempts.csv", [
      [
        "Started",
        "Student",
        "Email",
        "Quiz",
        "Status",
        "Percentage",
        "Score",
        "Total points",
        "Passed",
        "Time (s)",
      ],
      ...view().map((a) => [
        a.started_at,
        a.student,
        a.email,
        a.quiz,
        a.status,
        a.percentage,
        a.score,
        a.total_points,
        a.passed ? "Yes" : "No",
        a.time_taken_seconds,
      ]),
    ]);
}

// ======================================================================
// REPORTS
// ======================================================================
async function reports() {
  $("root").innerHTML =
    `<h1>Reports</h1><div class="filters noprint"><select id="rType"><option value="students">Student performance</option><option value="quizzes">Quiz summary</option><option value="topics">Topic-wise performance</option><option value="questions">Question difficulty (all questions)</option><option value="attempts">Attempts log</option></select>
    <input id="rFrom" type="date" aria-label="From (attempts log)"><input id="rTo" type="date" aria-label="To (attempts log)"><button class="btn" id="rRun">Run</button><button class="btn secondary" id="rCsv">Download CSV</button><button class="btn secondary" id="rPrint">Print / Save as PDF</button></div>
    <section class="card"><h2 id="rTitle"></h2><div class="tblwrap"><table class="tbl"><thead id="rHead"></thead><tbody id="rBody"></tbody></table></div></section>`;
  let table = { title: "", head: [], rows: [] };
  const run = async () => {
    const t = $("rType").value;
    $("rBody").innerHTML = '<tr><td class="muted">Loading...</td></tr>';
    try {
      if (t === "students") {
        const s = (await rpc("admin_student_stats")).filter(
          (p) => p.role === "STUDENT",
        );
        table = {
          title: "Student performance",
          head: [
            "Student",
            "Email",
            "Batches",
            "Attempts",
            "Average %",
            "Best %",
            "Quizzes passed",
            "Last active",
          ],
          rows: s.map((p) => [
            p.name,
            p.email,
            p.batches.join("; "),
            p.attempts,
            p.avg,
            p.best,
            p.passed,
            p.last_active ? fmtDate(p.last_active) : "",
          ]),
        };
      } else if (t === "quizzes") {
        const o = await rpc("admin_overview");
        table = {
          title: "Quiz summary",
          head: [
            "Quiz",
            "Status",
            "Attempts",
            "Average %",
            "Pass rate %",
            "Completion rate %",
          ],
          rows: o.per_quiz.map((q) => [
            q.title,
            q.status,
            q.attempts,
            q.avg,
            q.pass_rate,
            q.completion_rate,
          ]),
        };
      } else if (t === "topics") {
        const o = await rpc("admin_overview");
        table = {
          title: "Topic-wise performance (by anatomy system)",
          head: ["System", "Average accuracy %", "Answers"],
          rows: o.per_system.map((s) => [s.name, s.pct, s.answers]),
        };
      } else if (t === "questions") {
        const [qs, ans] = await Promise.all([
          db(
            supabase
              .from("questions")
              .select(
                "id,question_text,question_type,difficulty,system_id,anatomy_systems!questions_system_id_fkey(name)",
              )
              .eq("archived", false)
              .limit(5000),
          ),
          db(
            supabase
              .from("attempt_answers")
              .select(
                "question_id,is_correct,assessment_attempts!inner(status)",
              )
              .neq("assessment_attempts.status", "IN_PROGRESS")
              .limit(20000),
          ),
        ]);
        const m = new Map();
        ans.forEach((a) => {
          const e = m.get(a.question_id) || { n: 0, ok: 0 };
          e.n++;
          if (a.is_correct) e.ok++;
          m.set(a.question_id, e);
        });
        table = {
          title: "Question difficulty (share of students answering correctly)",
          head: [
            "Question",
            "Type",
            "System",
            "Set difficulty",
            "Times seen",
            "Correct %",
          ],
          rows: qs
            .map((q) => {
              const e = m.get(q.id);
              return [
                q.question_text,
                TYPE_LABEL[q.question_type],
                q.anatomy_systems?.name || "",
                q.difficulty,
                e?.n || 0,
                e ? Math.round((100 * e.ok) / e.n) : "",
              ];
            })
            .sort((a, b) => (a[5] === "") - (b[5] === "") || a[5] - b[5]),
        };
      } else {
        let a = await rpc("admin_attempts");
        const f = $("rFrom").value,
          to = $("rTo").value;
        if (f) a = a.filter((x) => x.started_at >= f);
        if (to) a = a.filter((x) => x.started_at < to + "T23:59:59.999");
        table = {
          title: "Attempts log",
          head: [
            "Started",
            "Student",
            "Quiz",
            "Status",
            "Percentage",
            "Score",
            "Total",
            "Passed",
            "Time (s)",
          ],
          rows: a.map((x) => [
            fmtDate(x.started_at),
            x.student,
            x.quiz,
            x.status,
            x.percentage,
            x.score,
            x.total_points,
            x.status === "IN_PROGRESS" ? "" : x.passed ? "Yes" : "No",
            x.time_taken_seconds,
          ]),
        };
      }
      $("rTitle").textContent = table.title + ` (${table.rows.length})`;
      $("rHead").innerHTML =
        `<tr>${table.head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr>`;
      $("rBody").innerHTML =
        table.rows
          .map(
            (r) =>
              `<tr>${r.map((c) => `<td>${esc(c ?? "")}</td>`).join("")}</tr>`,
          )
          .join("") ||
        `<tr><td colspan="${table.head.length}" class="empty">No data.</td></tr>`;
    } catch (e) {
      $("rBody").innerHTML =
        `<tr><td class="msg error">${esc(e.message)}</td></tr>`;
    }
  };
  $("rRun").onclick = run;
  $("rType").onchange = run;
  $("rPrint").onclick = () => print();
  $("rCsv").onclick = () =>
    download(table.title.replace(/\W+/g, "_") + ".csv", [
      table.head,
      ...table.rows,
    ]);
  run();
}

// ======================================================================
// QUIZZES (list + builder)
// ======================================================================
const toLocalInput = (iso) => {
  if (!iso) return "";
  const d = new Date(iso),
    p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : "");
const STATUS_CHIP = { DRAFT: "", PUBLISHED: "ok", UNPUBLISHED: "mid" };

async function quizzes() {
  const root = $("root");
  const qp = new URLSearchParams(location.search);
  async function list() {
    const rows = await db(
      supabase
        .from("quizzes")
        .select("*, quiz_questions(count), assessment_attempts(count)")
        .order("created_at", { ascending: false }),
    );
    root.innerHTML = `<div class="row sp"><h1>Quizzes</h1><button class="btn" id="qNew">+ New quiz</button></div>
      <div class="filters"><input id="qText" type="search" placeholder="Search quizzes..."><select id="qSt"><option value="">Any status</option><option>DRAFT</option><option>PUBLISHED</option><option>UNPUBLISHED</option></select></div>
      <div class="card tblwrap" style="padding:0"><table class="tbl"><thead><tr><th>Title</th><th>Status</th><th>Questions</th><th>Settings</th><th>Schedule</th><th>Attempts</th><th></th></tr></thead><tbody id="qRows"></tbody></table></div>`;
    const paint = () => {
      const v = rows.filter(
        (q) =>
          (!$("qSt").value || q.status === $("qSt").value) &&
          (!$("qText").value ||
            (q.title + (q.category || ""))
              .toLowerCase()
              .includes($("qText").value.toLowerCase())),
      );
      $("qRows").innerHTML =
        v
          .map(
            (
              q,
            ) => `<tr><td><b>${esc(q.title)}</b><br><span class="muted small">${esc(q.category || "")} ${chip(titleCase(q.audience))} ${chip(titleCase(q.difficulty), { EASY: "ok", MEDIUM: "mid", HARD: "bad" }[q.difficulty])}</span></td>
        <td>${chip(q.status, STATUS_CHIP[q.status])}</td><td>${q.quiz_questions[0]?.count ?? 0}</td>
        <td class="small">${fmtDur(q.duration_seconds)} &middot; pass ${pct(q.passing_score)}<br>${q.max_attempts ? q.max_attempts + " attempt(s)" : "unlimited attempts"}${q.immediate_feedback ? "<br>instant feedback" : ""}</td>
        <td class="small">${q.start_at ? "from " + fmtDay(q.start_at) : "no start"}<br>${q.end_at ? "until " + fmtDay(q.end_at) : "no end"}</td><td>${q.assessment_attempts[0]?.count ?? 0}</td>
        <td class="nowrap"><button class="btn small secondary" data-edit="${q.id}">Edit</button> <a class="btn small secondary" href="../student/assessment.html?preview=${q.id}" target="_blank" rel="noopener">Preview</a>
          <button class="btn small ${q.status === "PUBLISHED" ? "secondary" : ""}" data-pub="${q.id}|${q.status === "PUBLISHED" ? "UNPUBLISHED" : "PUBLISHED"}">${q.status === "PUBLISHED" ? "Unpublish" : "Publish"}</button>
          <button class="btn small secondary" data-dup="${q.id}">Duplicate</button> <button class="btn small danger" data-del="${q.id}">Delete</button></td></tr>`,
          )
          .join("") ||
        '<tr><td colspan="7" class="empty">No quizzes yet. Create one.</td></tr>';
      $("qRows")
        .querySelectorAll("[data-edit]")
        .forEach((b) => (b.onclick = () => editor(b.dataset.edit)));
      $("qRows")
        .querySelectorAll("[data-pub]")
        .forEach(
          (b) =>
            (b.onclick = async () => {
              const [id, st] = b.dataset.pub.split("|");
              try {
                await rpc("admin_set_quiz_status", {
                  p_quiz: id,
                  p_status: st,
                });
                toast(
                  st === "PUBLISHED" ? "Published" : "Unpublished",
                  "success",
                );
                list();
              } catch (e) {
                toast(e.message, "error");
              }
            }),
        );
      $("qRows")
        .querySelectorAll("[data-dup]")
        .forEach(
          (b) =>
            (b.onclick = async () => {
              try {
                const d = await loadDraft(b.dataset.dup);
                d.id = null;
                d.title += " (copy)";
                await rpc("admin_save_quiz", { p: payload(d) });
                toast("Duplicated as a draft", "success");
                list();
              } catch (e) {
                toast(e.message, "error");
              }
            }),
        );
      $("qRows")
        .querySelectorAll("[data-del]")
        .forEach(
          (b) =>
            (b.onclick = async () => {
              const q = rows.find((x) => x.id === b.dataset.del),
                n = q.assessment_attempts[0]?.count ?? 0;
              if (
                !(await confirmBox(
                  `Delete <b>${esc(q.title)}</b>?${n ? ` <b>${n} student attempt(s) and their results will be deleted too.</b> Consider Unpublish instead.` : ""} Questions stay in the bank.`,
                  { ok: "Delete" },
                ))
              )
                return;
              try {
                await db(supabase.from("quizzes").delete().eq("id", q.id));
                toast("Deleted", "success");
                list();
              } catch (e) {
                toast(e.message, "error");
              }
            }),
        );
    };
    ["qText", "qSt"].forEach((i) => ($(i).oninput = paint));
    paint();
    $("qNew").onclick = () => editor(null);
  }

  async function loadDraft(id) {
    const [z, qq, as] = await Promise.all([
      db(supabase.from("quizzes").select("*").eq("id", id).single()),
      db(
        supabase
          .from("quiz_questions")
          .select("question_id,display_order")
          .eq("quiz_id", id)
          .order("display_order"),
      ),
      db(
        supabase
          .from("quiz_assignments")
          .select("user_id,batch_id")
          .eq("quiz_id", id),
      ),
    ]);
    return {
      id: z.id,
      status: z.status,
      title: z.title,
      description: z.description || "",
      category: z.category || "",
      system_id: z.system_id || "",
      audience: z.audience,
      difficulty: z.difficulty,
      duration_minutes: Math.round(z.duration_seconds / 60),
      passing_score: z.passing_score,
      max_attempts: z.max_attempts ?? "",
      immediate_feedback: z.immediate_feedback,
      shuffle_questions: z.shuffle_questions,
      shuffle_options: z.shuffle_options,
      show_correct_answers: z.show_correct_answers,
      start_at: toLocalInput(z.start_at),
      end_at: toLocalInput(z.end_at),
      question_ids: qq.map((x) => x.question_id),
      assign_mode: as.length ? "SELECT" : "ALL",
      assign_users: as.filter((a) => a.user_id).map((a) => a.user_id),
      assign_batches: as.filter((a) => a.batch_id).map((a) => a.batch_id),
    };
  }
  const payload = (d) => ({
    id: d.id || null,
    title: d.title,
    description: d.description,
    category: d.category,
    system_id: d.system_id || null,
    audience: d.audience,
    difficulty: d.difficulty,
    duration_seconds: Math.round(Number(d.duration_minutes) * 60),
    passing_score: Number(d.passing_score),
    max_attempts: d.max_attempts === "" ? null : Number(d.max_attempts),
    immediate_feedback: d.immediate_feedback,
    shuffle_questions: d.shuffle_questions,
    shuffle_options: d.shuffle_options,
    show_correct_answers: d.show_correct_answers,
    start_at: fromLocalInput(d.start_at),
    end_at: fromLocalInput(d.end_at),
    question_ids: d.question_ids,
    assign_users: d.assign_mode === "SELECT" ? d.assign_users : [],
    assign_batches: d.assign_mode === "SELECT" ? d.assign_batches : [],
  });

  async function editor(id) {
    const [systems, people, batches] = await Promise.all([
      db(
        supabase
          .from("anatomy_systems")
          .select("id,name")
          .order("display_order"),
      ),
      rpc("admin_student_stats"),
      db(supabase.from("batches").select("id,name").order("name")),
    ]);
    const students = people.filter((p) => p.role === "STUDENT");
    const d = id
      ? await loadDraft(id)
      : {
          id: null,
          status: "DRAFT",
          title: "",
          description: "",
          category: "",
          system_id: "",
          audience: "ALL",
          difficulty: "MEDIUM",
          duration_minutes: 20,
          passing_score: 60,
          max_attempts: "",
          immediate_feedback: false,
          shuffle_questions: false,
          shuffle_options: false,
          show_correct_answers: true,
          start_at: "",
          end_at: "",
          question_ids: [],
          assign_mode: "ALL",
          assign_users: [],
          assign_batches: [],
        };
    const qcache = new Map();
    async function cacheQs(ids) {
      const need = ids.filter((i) => !qcache.has(i));
      if (!need.length) return;
      (
        await db(
          supabase
            .from("questions")
            .select(
              "id,question_text,question_type,points,difficulty,review_status,system_id",
            )
            .in("id", need),
        )
      ).forEach((q) => qcache.set(q.id, q));
    }
    await cacheQs(d.question_ids);
    const sel = (k, opts) =>
      `<select data-k="${k}">${opts.map(([v, t]) => opt(v, t, String(d[k]) === String(v))).join("")}</select>`;
    const chk = (k, label, hint) =>
      `<label class="chk"><input type="checkbox" data-k="${k}" ${d[k] ? "checked" : ""}> ${label}</label>${hint ? `<div class="hint" style="margin:-2px 0 6px 24px">${hint}</div>` : ""}`;
    root.innerHTML = `<div class="row sp"><h1>${id ? "Edit quiz" : "New quiz"} ${id ? chip(d.status, STATUS_CHIP[d.status]) : ""}</h1><button class="btn secondary" id="qBack">&larr; Back to quizzes</button></div>
      <div class="grid two" style="align-items:start">
      <section class="card"><h2>Basics</h2>
        <div class="field"><label>Title *</label><input data-k="title" maxlength="140"></div><div class="field"><label>Description</label><textarea data-k="description"></textarea></div>
        <div class="row2"><div class="field"><label>Anatomy category</label><input data-k="category" list="catList" placeholder="e.g. Upper limb"><datalist id="catList">${systems.map((s) => `<option>${esc(s.name)}</option>`).join("")}</datalist></div>
          <div class="field"><label>Main system</label><select data-k="system_id"><option value="">(none)</option>${systems.map((s) => opt(s.id, s.name, s.id === d.system_id)).join("")}</select></div></div>
        <div class="row2"><div class="field"><label>Target audience</label>${sel(
          "audience",
          [
            ["ALL", "Everyone"],
            ["SCHOOL", "School students"],
            ["MEDICAL", "Medical graduates"],
          ],
        )}</div>
          <div class="field"><label>Difficulty</label>${sel("difficulty", [
            ["EASY", "Easy"],
            ["MEDIUM", "Medium"],
            ["HARD", "Hard"],
          ])}</div></div></section>
      <section class="card"><h2>Rules</h2>
        <div class="row2"><div class="field"><label>Duration (minutes) *</label><input type="number" min="1" data-k="duration_minutes"></div><div class="field"><label>Passing score (%)</label><input type="number" min="0" max="100" data-k="passing_score"></div></div>
        <div class="field"><label>Attempts allowed per student</label><input type="number" min="1" data-k="max_attempts" placeholder="blank = unlimited"></div>
        ${chk("immediate_feedback", "Immediate feedback", "Students see right/wrong after each question and cannot change it.")}${chk("shuffle_questions", "Shuffle questions")}${chk("shuffle_options", "Shuffle answer options")}
        ${chk("show_correct_answers", "Show correct answers and explanations after submission", "Turn off for exams you will reuse.")}
        <div class="row2"><div class="field"><label>Opens</label><input type="datetime-local" data-k="start_at"></div><div class="field"><label>Closes</label><input type="datetime-local" data-k="end_at"></div></div>
        <div class="hint">Blank = always open. The timer never runs past the closing time.</div></section></div>
      <section class="card" style="margin-top:14px"><h2>Assign to</h2>
        <label class="chk"><input type="radio" name="am" value="ALL" ${d.assign_mode === "ALL" ? "checked" : ""}> All students</label>
        <label class="chk"><input type="radio" name="am" value="SELECT" ${d.assign_mode === "SELECT" ? "checked" : ""}> Selected batches and students</label>
        <div id="assignBox" ${d.assign_mode === "ALL" ? "hidden" : ""}><div class="grid two"><div><h3>Batches</h3>${batches.map((b) => `<label class="chk"><input type="checkbox" data-b="${b.id}" ${d.assign_batches.includes(b.id) ? "checked" : ""}> ${esc(b.name)}</label>`).join("") || '<p class="muted small">No batches yet (Users &rarr; Batches).</p>'}</div>
          <div><h3>Students</h3><input id="stFilter" type="search" placeholder="Filter..."><div id="stList" style="max-height:200px;overflow:auto"></div></div></div></div></section>
      <section class="card" style="margin-top:14px"><div class="row sp"><h2>Questions <span class="muted small" id="qSummary"></span></h2><button class="btn" id="qAdd">+ Add from question bank</button></div><div id="qList"></div></section>
      <div class="row" style="margin-top:14px;position:sticky;bottom:0;background:var(--bg);padding:10px 0"><button class="btn" id="qSave">Save</button><button class="btn secondary" id="qPrev">Save &amp; preview</button>
        ${id ? `<button class="btn ${d.status === "PUBLISHED" ? "secondary" : ""}" id="qPub">${d.status === "PUBLISHED" ? "Unpublish" : "Publish"}</button>` : ""}<button class="btn secondary" id="qCancel">Cancel</button><span class="muted small" id="qMsg"></span></div>`;
    // two-way binding
    root.querySelectorAll("[data-k]").forEach((el) => {
      const k = el.dataset.k;
      if (el.type === "checkbox") el.checked = !!d[k];
      else if (el.tagName !== "SELECT") el.value = d[k] ?? "";
      el.oninput = () =>
        (d[k] = el.type === "checkbox" ? el.checked : el.value);
    });
    root.querySelectorAll("[name=am]").forEach(
      (r) =>
        (r.onchange = () => {
          d.assign_mode = r.value;
          $("assignBox").hidden = r.value === "ALL";
        }),
    );
    root.querySelectorAll("[data-b]").forEach(
      (c) =>
        (c.onchange = () => {
          d.assign_batches = c.checked
            ? [...d.assign_batches, c.dataset.b]
            : d.assign_batches.filter((x) => x !== c.dataset.b);
        }),
    );
    const paintStudents = () => {
      const t = $("stFilter").value.toLowerCase();
      $("stList").innerHTML =
        students
          .filter((s) => (s.name + (s.email || "")).toLowerCase().includes(t))
          .map(
            (s) =>
              `<label class="chk"><input type="checkbox" data-s="${s.id}" ${d.assign_users.includes(s.id) ? "checked" : ""}> ${esc(s.name)}</label>`,
          )
          .join("") || '<p class="muted small">No students.</p>';
      $("stList")
        .querySelectorAll("input")
        .forEach(
          (c) =>
            (c.onchange = () => {
              d.assign_users = c.checked
                ? [...d.assign_users, c.dataset.s]
                : d.assign_users.filter((x) => x !== c.dataset.s);
            }),
        );
    };
    $("stFilter").oninput = paintStudents;
    paintStudents();

    function paintQs() {
      const list = d.question_ids.map((i) => qcache.get(i)).filter(Boolean),
        total = list.reduce((a, q) => a + q.points, 0),
        unapproved = list.filter((q) => q.review_status !== "APPROVED").length;
      $("qSummary").textContent =
        `${list.length} question(s), ${total} points${unapproved ? `, ${unapproved} not approved yet` : ""}`;
      $("qList").innerHTML = list.length
        ? `<table class="tbl"><tbody>${list
            .map(
              (
                q,
                i,
              ) => `<tr><td>${i + 1}</td><td>${esc(q.question_text.slice(0, 110))}<br>${chip(TYPE_LABEL[q.question_type])} ${chip(q.review_status, REVIEW_CHIP[q.review_status])}</td><td>${q.points} pt</td>
        <td class="nowrap"><button class="btn small secondary" data-up="${i}" aria-label="Move up">&uarr;</button> <button class="btn small secondary" data-dn="${i}" aria-label="Move down">&darr;</button> <button class="btn small danger" data-rm="${i}" aria-label="Remove">&times;</button></td></tr>`,
            )
            .join("")}</tbody></table>`
        : '<p class="empty">No questions yet. Add some from the question bank.</p>';
      const mv = (i, j) => {
        if (j < 0 || j >= d.question_ids.length) return;
        [d.question_ids[i], d.question_ids[j]] = [
          d.question_ids[j],
          d.question_ids[i],
        ];
        paintQs();
      };
      $("qList")
        .querySelectorAll("[data-up]")
        .forEach(
          (b) => (b.onclick = () => mv(+b.dataset.up, +b.dataset.up - 1)),
        );
      $("qList")
        .querySelectorAll("[data-dn]")
        .forEach(
          (b) => (b.onclick = () => mv(+b.dataset.dn, +b.dataset.dn + 1)),
        );
      $("qList")
        .querySelectorAll("[data-rm]")
        .forEach(
          (b) =>
            (b.onclick = () => {
              d.question_ids.splice(+b.dataset.rm, 1);
              paintQs();
            }),
        );
    }
    paintQs();

    $("qAdd").onclick = async () => {
      const all = await db(
        supabase
          .from("questions")
          .select(
            "id,question_text,question_type,points,difficulty,review_status,system_id,tags",
          )
          .eq("archived", false)
          .order("created_at", { ascending: false })
          .limit(2000),
      );
      const body = openSheet(
        "Add questions from the bank",
        `<div class="filters"><input id="pText" type="search" placeholder="Search text or tag..."><select id="pSys"><option value="">Any system</option>${systems.map((s) => opt(s.id, s.name)).join("")}</select>
        <select id="pType"><option value="">Any type</option>${TYPES.map((t) => opt(t, TYPE_LABEL[t])).join("")}</select><select id="pDiff"><option value="">Any difficulty</option><option>EASY</option><option>MEDIUM</option><option>HARD</option></select>
        <select id="pRev"><option value="">Any review status</option><option value="APPROVED">Approved</option><option value="PENDING">Pending</option></select></div>
        <div style="max-height:50vh;overflow:auto"><table class="tbl"><tbody id="pRows"></tbody></table></div><div class="row" style="margin-top:10px"><button class="btn" id="pDone">Add selected</button><span class="muted small" id="pCount"></span></div>`,
      );
      const chosen = new Set();
      const paint = () => {
        const t = $("pText").value.toLowerCase();
        const v = all.filter(
          (q) =>
            !d.question_ids.includes(q.id) &&
            (!$("pSys").value || q.system_id === $("pSys").value) &&
            (!$("pType").value || q.question_type === $("pType").value) &&
            (!$("pDiff").value || q.difficulty === $("pDiff").value) &&
            (!$("pRev").value || q.review_status === $("pRev").value) &&
            (!t ||
              q.question_text.toLowerCase().includes(t) ||
              q.tags.some((x) => x.includes(t))),
        );
        $("pRows").innerHTML =
          v
            .map(
              (q) =>
                `<tr><td><input type="checkbox" data-p="${q.id}" ${chosen.has(q.id) ? "checked" : ""}></td><td>${esc(q.question_text.slice(0, 120))}<br>${chip(TYPE_LABEL[q.question_type])} ${chip(titleCase(q.difficulty))} ${chip(q.review_status, REVIEW_CHIP[q.review_status])}</td><td>${q.points} pt</td></tr>`,
            )
            .join("") ||
          '<tr><td class="empty">No matching questions.</td></tr>';
        $("pCount").textContent = `${v.length} shown, ${chosen.size} selected`;
        $("pRows")
          .querySelectorAll("input")
          .forEach(
            (c) =>
              (c.onchange = () => {
                c.checked
                  ? chosen.add(c.dataset.p)
                  : chosen.delete(c.dataset.p);
                $("pCount").textContent =
                  `${v.length} shown, ${chosen.size} selected`;
              }),
          );
      };
      ["pText", "pSys", "pType", "pDiff", "pRev"].forEach(
        (i) => ($(i).oninput = paint),
      );
      paint();
      $("pDone").onclick = async () => {
        all.forEach((q) => qcache.set(q.id, q));
        d.question_ids.push(...chosen);
        closeSheet();
        paintQs();
      };
    };

    async function save() {
      if (!d.title.trim()) throw new Error("Title is required");
      if (!(Number(d.duration_minutes) > 0))
        throw new Error("Duration must be positive");
      if (d.start_at && d.end_at && new Date(d.end_at) <= new Date(d.start_at))
        throw new Error("The closing time must be after the opening time");
      if (
        d.assign_mode === "SELECT" &&
        !d.assign_users.length &&
        !d.assign_batches.length
      )
        throw new Error(
          "Choose at least one batch or student, or assign to all students",
        );
      const newId = await rpc("admin_save_quiz", { p: payload(d) });
      d.id = newId;
      return newId;
    }
    const act = (fn) => async () => {
      try {
        await fn();
      } catch (e) {
        toast(e.message, "error");
      }
    };
    $("qSave").onclick = act(async () => {
      await save();
      toast("Saved", "success");
      list();
    });
    $("qPrev").onclick = act(async () => {
      const i = await save();
      window.open(
        `../student/assessment.html?preview=${i}`,
        "_blank",
        "noopener",
      );
      toast("Saved. Preview opened in a new tab.");
    });
    if ($("qPub"))
      $("qPub").onclick = act(async () => {
        const i = await save();
        await rpc("admin_set_quiz_status", {
          p_quiz: i,
          p_status: d.status === "PUBLISHED" ? "UNPUBLISHED" : "PUBLISHED",
        });
        toast("Done", "success");
        list();
      });
    $("qBack").onclick = $("qCancel").onclick = () => list();
  }

  if (qp.get("edit")) return editor(qp.get("edit"));
  if (qp.get("new")) return editor(null);
  await list();
}

// ======================================================================
// QUESTIONS (bank + editor with 3D structure picking, preview, validation)
// ======================================================================
let editorStage = null,
  editorScene = null; // one WebGL viewer is reused for every editor session

async function questions() {
  const root = $("root"),
    qp = new URLSearchParams(location.search);
  const systems = await db(
    supabase.from("anatomy_systems").select("id,name").order("display_order"),
  );
  const sysName = new Map(systems.map((s) => [s.id, s.name]));

  // ---------------- bank ----------------
  async function list() {
    const rows = await db(
      supabase
        .from("questions")
        .select("*, quiz_questions(count)")
        .order("created_at", { ascending: false })
        .limit(3000),
    );
    const tags = [...new Set(rows.flatMap((r) => r.tags))].sort();
    root.innerHTML = `<div class="row sp"><h1>Question bank</h1><button class="btn" id="nNew">+ New question</button></div>
      <div class="filters"><input id="fText" type="search" placeholder="Search questions..."><select id="fSys"><option value="">Any system</option>${systems.map((s) => opt(s.id, s.name)).join("")}</select>
        <select id="fDiff"><option value="">Any difficulty</option><option>EASY</option><option>MEDIUM</option><option>HARD</option></select><select id="fType"><option value="">Any type</option>${TYPES.map((t) => opt(t, TYPE_LABEL[t])).join("")}</select>
        <select id="fTag"><option value="">Any tag</option>${tags.map((t) => opt(t, t)).join("")}</select>
        <select id="fRev"><option value="">Any review status</option>${["PENDING", "APPROVED", "REJECTED"].map((r) => opt(r, titleCase(r), r === qp.get("review"))).join("")}</select>
        <select id="fArc"><option value="0">Active</option><option value="1">Archived</option></select></div>
      <div class="row noprint" style="margin-bottom:8px"><button class="btn small secondary" data-bulk="APPROVED">Approve selected</button><button class="btn small secondary" data-bulk="REJECTED">Reject selected</button><button class="btn small secondary" data-bulk="PENDING">Mark pending</button><span class="muted small" id="fCount"></span></div>
      <div class="card tblwrap" style="padding:0"><table class="tbl"><thead><tr><th><input type="checkbox" id="fAll" aria-label="Select all"></th><th>Question</th><th>System</th><th>Difficulty</th><th>Review</th><th>Used</th><th></th></tr></thead><tbody id="fRows"></tbody></table></div>`;
    const view = () =>
      rows.filter(
        (r) =>
          (!$("fSys").value || r.system_id === $("fSys").value) &&
          (!$("fDiff").value || r.difficulty === $("fDiff").value) &&
          (!$("fType").value || r.question_type === $("fType").value) &&
          (!$("fTag").value || r.tags.includes($("fTag").value)) &&
          (!$("fRev").value || r.review_status === $("fRev").value) &&
          r.archived === ($("fArc").value === "1") &&
          (!$("fText").value ||
            r.question_text
              .toLowerCase()
              .includes($("fText").value.toLowerCase())),
      );
    const paint = () => {
      const v = view();
      $("fCount").textContent = `${v.length} question(s)`;
      $("fRows").innerHTML =
        v
          .slice(0, 300)
          .map(
            (
              r,
            ) => `<tr><td><input type="checkbox" data-sel="${r.id}"></td><td>${esc(r.question_text.slice(0, 130))}<br>${chip(TYPE_LABEL[r.question_type])} ${r.tags.map((t) => chip("#" + t)).join(" ")}</td>
        <td class="small">${esc(sysName.get(r.system_id) || "")}</td><td>${chip(titleCase(r.difficulty), { EASY: "ok", MEDIUM: "mid", HARD: "bad" }[r.difficulty])}</td><td>${chip(r.review_status, REVIEW_CHIP[r.review_status])}</td><td>${r.quiz_questions[0]?.count ?? 0} quiz(zes)</td>
        <td class="nowrap"><button class="btn small secondary" data-edit="${r.id}">Edit</button> <button class="btn small secondary" data-dup="${r.id}">Duplicate</button>
          <button class="btn small secondary" data-arc="${r.id}">${r.archived ? "Restore" : "Archive"}</button> <button class="btn small danger" data-del="${r.id}">Delete</button></td></tr>`,
          )
          .join("") ||
        '<tr><td colspan="7" class="empty">No questions match.</td></tr>';
      const on = (sel, fn) =>
        $("fRows")
          .querySelectorAll(sel)
          .forEach((b) => (b.onclick = () => fn(b)));
      on("[data-edit]", (b) => editor(b.dataset.edit));
      on("[data-dup]", (b) => editor(b.dataset.dup, true));
      on("[data-arc]", async (b) => {
        const r = rows.find((x) => x.id === b.dataset.arc);
        try {
          await db(
            supabase
              .from("questions")
              .update({ archived: !r.archived })
              .eq("id", r.id),
          );
          list();
        } catch (e) {
          toast(e.message, "error");
        }
      });
      on("[data-del]", async (b) => {
        if (
          !(await confirmBox(
            "Delete this question permanently? It is removed from every quiz.",
            { ok: "Delete" },
          ))
        )
          return;
        try {
          await db(supabase.from("questions").delete().eq("id", b.dataset.del));
          toast("Deleted", "success");
          list();
        } catch (e) {
          toast(
            /foreign key|violates/i.test(e.message)
              ? "Students have already answered this question. Archive it instead."
              : e.message,
            "error",
          );
        }
      });
    };
    ["fText", "fSys", "fDiff", "fType", "fTag", "fRev", "fArc"].forEach(
      (i) => ($(i).oninput = paint),
    );
    paint();
    $("fAll").onchange = () =>
      $("fRows")
        .querySelectorAll("[data-sel]")
        .forEach((c) => (c.checked = $("fAll").checked));
    document.querySelectorAll("[data-bulk]").forEach(
      (b) =>
        (b.onclick = async () => {
          const ids = [
            ...$("fRows").querySelectorAll("[data-sel]:checked"),
          ].map((c) => c.dataset.sel);
          if (!ids.length) return toast("Tick some questions first", "error");
          try {
            const n = await rpc("admin_review_questions", {
              p_ids: ids,
              p_status: b.dataset.bulk,
            });
            toast(`${n} updated`, "success");
            list();
          } catch (e) {
            toast(e.message, "error");
          }
        }),
    );
    $("nNew").onclick = () => editor(null);
  }

  // ---------------- editor ----------------
  const blank = () => ({
    id: null,
    question_text: "",
    question_type: "MULTIPLE_CHOICE",
    points: 1,
    difficulty: "MEDIUM",
    system_id: "",
    tags: "",
    explanation: "",
    reference_material: "",
    image_path: "",
    camera: null,
    highlight_color: "#ff9f1c",
    options: [0, 1, 2, 3].map(() => ({ option_text: "", is_correct: false })),
    target_ids: [],
    correct_ids: [],
    alt_ids: [],
    correct_system_id: "",
    system_choices: [],
    label_ids: [],
    distractor_ids: [],
    multi_ids: [],
    items: [{ text: "" }, { text: "" }, { text: "" }],
  });
  async function fromRow(id) {
    const r = await db(
        supabase
          .from("questions")
          .select("*, question_options(*)")
          .eq("id", id)
          .single(),
      ),
      d = blank();
    Object.assign(d, {
      id: r.id,
      question_text: r.question_text,
      question_type: r.question_type,
      points: r.points,
      difficulty: r.difficulty,
      system_id: r.system_id || "",
      tags: r.tags.join(", "),
      explanation: r.explanation || "",
      reference_material: r.reference_material || "",
      image_path: r.image_path || "",
      camera: r.camera,
      highlight_color: r.highlight_color,
      correct_system_id: r.correct_system_id || "",
      status: r.review_status,
    });
    const o = [...r.question_options].sort(
      (a, b) => a.display_order - b.display_order,
    );
    if (o.length)
      d.options = o.map((x) => ({
        id: x.id,
        option_text: x.option_text,
        is_correct: x.is_correct,
      }));
    d.target_ids = r.payload.target_structure_ids || [];
    d.system_choices = r.payload.system_choices || [];
    d.label_ids = r.payload.labels || [];
    d.distractor_ids = r.payload.distractor_ids || [];
    if (r.payload.items)
      d.items = r.payload.items.map((x) => ({ text: x.text }));
    if (r.question_type === "FIND_STRUCTURE") {
      d.correct_ids = r.correct_structure_id ? [r.correct_structure_id] : [];
      d.alt_ids = (r.answer_key.structure_ids || []).filter(
        (x) => x !== r.correct_structure_id,
      );
    }
    if (r.question_type === "MULTI_STRUCTURE")
      d.multi_ids = r.answer_key.structure_ids || [];
    return d;
  }
  const toSave = (d, approve = false) => {
    const t = d.question_type,
      p = {
        id: d.id,
        question_text: d.question_text,
        question_type: t,
        points: Number(d.points) || 1,
        difficulty: d.difficulty,
        system_id: d.system_id || null,
        tags: d.tags
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
        explanation: d.explanation,
        reference_material: d.reference_material,
        image_path: d.image_path || null,
        camera: d.camera,
        highlight_color: d.highlight_color,
        approve,
        payload: {},
        answer_key: {},
      };
    if (t === "MULTIPLE_CHOICE" || t === "IDENTIFY_3D")
      p.options = d.options.map((o) => ({
        id: o.id || null,
        option_text: o.option_text,
        is_correct: !!o.is_correct,
      }));
    if (t === "IDENTIFY_3D" || t === "SYSTEM_IDENTIFICATION")
      p.payload.target_structure_ids = d.target_ids;
    if (t === "FIND_STRUCTURE") {
      p.correct_structure_id = d.correct_ids[0] || null;
      p.answer_key.structure_ids = d.alt_ids;
    }
    if (t === "SYSTEM_IDENTIFICATION") {
      p.correct_system_id = d.correct_system_id || null;
      p.payload.system_choices = d.system_choices;
    }
    if (t === "LABEL_ANATOMY") {
      p.payload.labels = d.label_ids;
      p.payload.distractor_ids = d.distractor_ids;
    }
    if (t === "MULTI_STRUCTURE") p.answer_key.structure_ids = d.multi_ids;
    if (t === "SEQUENCE")
      p.payload.items = d.items.map((i) => ({ text: i.text }));
    return p;
  };

  async function editor(id, duplicate = false) {
    const d = id ? await fromRow(id) : blank();
    if (duplicate) {
      d.id = null;
      d.question_text += " (copy)";
    }
    root.innerHTML = `<div class="row sp"><h1>${d.id ? "Edit question" : duplicate ? "Duplicate question" : "New question"}</h1><button class="btn secondary" id="eBack">&larr; Back to bank</button></div>
      ${d.id ? '<p class="hint">Saving changes resets the medical-review approval. Students\' past results will show the updated wording.</p>' : ""}
      <div class="editor"><div><section class="card" id="eForm"></section><section class="card" id="ePreviewCard" hidden><div class="row sp"><h3>Student preview</h3><button class="btn small secondary" id="ePreviewX">Close preview</button></div>
        <p class="hint">This is exactly what a student sees. Answers are not saved.</p><div id="previewPane" style="display:flex;flex-direction:column;gap:12px"></div></section>
        <div class="row" style="margin-top:14px"><button class="btn" id="eSave">Save</button><button class="btn" id="eApprove">Save &amp; approve</button><button class="btn secondary" id="eValidate">Validate</button><button class="btn secondary" id="ePreview">Preview as student</button><button class="btn secondary" id="eCancel">Cancel</button></div>
        <div id="eMsg" style="margin-top:8px"></div></div>
      <div><div class="row small" id="sysToggles" style="margin-bottom:6px"></div><div id="stageHost"></div><p class="hint" id="pickHint">Choose "Pick in 3D" on a structure field to select by clicking the model. Ctrl + drag selects several.</p>
        <div class="row"><button class="btn small secondary" id="camSet">Save current camera</button><button class="btn small secondary" id="camGo">Go to saved camera</button><button class="btn small secondary" id="camClr">Clear camera</button><span class="muted small" id="camInfo"></span></div></div></div>`;

    // shared 3D scene (created once)
    if (!editorStage) {
      editorStage = document.createElement("div");
      editorStage.id = "stage";
    }
    $("stageHost").appendChild(editorStage);
    if (!editorScene) {
      try {
        editorScene = await mountScene(editorStage);
      } catch (e) {
        toast("3D scene failed: " + e.message, "error");
      }
    }
    const sc = editorScene;
    if (sc) {
      sc.handlers = {};
      sc.viewer.setMarks([]);
      sc.clearPins();
    }
    const withModels = sc ? sc.systemsWithModels() : [];
    const visible = new Set(
      d.system_id && withModels.includes(d.system_id)
        ? [d.system_id]
        : withModels.slice(0, 1),
    );
    async function showSystems() {
      if (!sc) return;
      sc.setStatus(
        visible.size
          ? "Loading 3D model..."
          : "No 3D model available. Upload one in Models.",
      );
      const failed = await sc.ensure([...visible]);
      sc.setStatus(
        failed.length
          ? `Could not load: ${failed.join(", ")}`
          : visible.size
            ? ""
            : "No 3D model available. Upload one in Models.",
      );
      sc.show([...visible]);
    }
    $("sysToggles").innerHTML =
      '<span class="muted">Show in 3D:</span>' +
      systems
        .filter((s) => withModels.includes(s.id))
        .map(
          (s) =>
            `<label class="chk"><input type="checkbox" data-vs="${s.id}" ${visible.has(s.id) ? "checked" : ""}> ${esc(s.name)}</label>`,
        )
        .join("");
    $("sysToggles")
      .querySelectorAll("input")
      .forEach(
        (c) =>
          (c.onchange = () => {
            c.checked
              ? visible.add(c.dataset.vs)
              : visible.delete(c.dataset.vs);
            showSystems();
          }),
      );
    showSystems();

    // ---- pickers ----
    let active = null;
    const pickers = {};
    const rowsOf = (ids) => ids.map((i) => sc?.byId.get(i)).filter(Boolean);
    const PICK = {
      IDENTIFY_3D: [
        [
          "target_ids",
          "Structure(s) to highlight",
          true,
          () => d.highlight_color,
        ],
      ],
      SYSTEM_IDENTIFICATION: [
        [
          "target_ids",
          "Structure(s) to highlight",
          true,
          () => d.highlight_color,
        ],
      ],
      FIND_STRUCTURE: [
        [
          "correct_ids",
          "Correct structure (student must click it, or any part of it)",
          false,
          () => "#2ecc71",
        ],
        ["alt_ids", "Also accept (optional)", true, () => "#2ec4b6"],
      ],
      MULTI_STRUCTURE: [
        ["multi_ids", "Correct structures (select all)", true, () => "#2ecc71"],
      ],
      LABEL_ANATOMY: [
        [
          "label_ids",
          "Structures to label (numbered in the order added)",
          true,
          (i) => PALETTE[i % 12],
        ],
        [
          "distractor_ids",
          "Extra wrong names (distractors, optional)",
          true,
          () => "#888888",
        ],
      ],
    };
    function refreshMarks() {
      if (!sc) return;
      const items = [];
      (PICK[d.question_type] || []).forEach(([k, , , col]) =>
        d[k].forEach((id, i) => {
          const r = sc.byId.get(id);
          if (r && k !== "distractor_ids")
            items.push(...sc.itemsFor([r], col(i)));
        }),
      );
      sc.viewer.setMarks(items);
      sc.setPins([]);
      if (d.question_type === "LABEL_ANATOMY")
        sc.setPins(
          d.label_ids.map((id, i) => ({
            n: i + 1,
            color: PALETTE[i % 12],
            items: sc.itemsFor(rowsOf([id])),
          })),
        );
    }
    function addTo(key, multi, row) {
      if (!row) return;
      const arr = d[key];
      if (!multi) d[key] = [row.id];
      else
        d[key] = arr.includes(row.id)
          ? arr.filter((x) => x !== row.id)
          : [...arr, row.id];
      if (
        !visible.has(row.system_id) &&
        sc.systemsWithModels().includes(row.system_id)
      ) {
        visible.add(row.system_id);
        showSystems();
      }
      pickers[key]?.paint();
      refreshMarks();
    }
    function bindPick() {
      if (!sc) return;
      sc.handlers = {};
      if (active) {
        const [key, , multi] = active;
        sc.handlers.pick = (row) => addTo(key, multi, row);
        sc.handlers.box = (rows) => {
          if (multi)
            rows.forEach((r) => {
              if (!d[key].includes(r.id)) d[key] = [...d[key], r.id];
            });
          pickers[key].paint();
          refreshMarks();
        };
      }
      $("pickHint").textContent = active
        ? `Click a structure on the model to add or remove it: ${active[1]}`
        : 'Choose "Pick in 3D" on a structure field to select by clicking the model. Ctrl + drag selects several.';
    }
    function buildPicker(host, cfg) {
      const [key, label, multi] = cfg;
      host.innerHTML = `<div class="field"><label>${esc(label)}</label><div class="chips" data-chips></div><div class="row" style="margin-top:6px"><input data-q placeholder="Search structures by name..." style="flex:1;min-width:160px"><button class="btn small secondary" data-3d>Pick in 3D</button></div><div class="tree" data-res hidden></div></div>`;
      const chipsEl = host.querySelector("[data-chips]"),
        res = host.querySelector("[data-res]"),
        inp = host.querySelector("[data-q]"),
        b3 = host.querySelector("[data-3d]");
      const paint = () => {
        chipsEl.innerHTML =
          rowsOf(d[key])
            .map(
              (r, i) =>
                `<span class="chip brand">${key === "label_ids" ? i + 1 + ". " : ""}${esc(r.name)} <small>${esc(sysName.get(r.system_id) || "")}</small><button data-rm="${r.id}" aria-label="Remove">&times;</button></span>`,
            )
            .join("") || '<span class="muted small">None selected</span>';
        chipsEl.querySelectorAll("[data-rm]").forEach(
          (b) =>
            (b.onclick = () => {
              d[key] = d[key].filter((x) => x !== b.dataset.rm);
              paint();
              refreshMarks();
            }),
        );
        b3.classList.toggle("secondary", active?.[0] !== key);
        b3.textContent =
          active?.[0] === key ? "Picking... (click to stop)" : "Pick in 3D";
      };
      inp.oninput = debounce(() => {
        const t = inp.value.trim().toLowerCase();
        if (t.length < 2) {
          res.hidden = true;
          return;
        }
        const found = (sc?.all || [])
          .filter((r) => r.name.toLowerCase().includes(t))
          .slice(0, 40);
        res.hidden = false;
        res.innerHTML =
          found
            .map(
              (r) =>
                `<div class="it" data-id="${r.id}">${esc(r.name)} <small>${esc(sysName.get(r.system_id) || "")}${r.model_object_id ? "" : " (group)"}</small></div>`,
            )
            .join("") || '<div class="it muted">No match</div>';
        res.querySelectorAll("[data-id]").forEach(
          (el) =>
            (el.onclick = () => {
              addTo(key, multi, sc.byId.get(el.dataset.id));
              if (!multi) {
                res.hidden = true;
                inp.value = "";
              }
            }),
        );
      });
      b3.onclick = () => {
        active = active?.[0] === key ? null : cfg;
        Object.values(pickers).forEach((p) => p.paint());
        bindPick();
      };
      pickers[key] = { paint };
      paint();
    }

    // ---- form ----
    const field = (k, label, tag = "input", extra = "") =>
      `<div class="field"><label>${label}</label><${tag} data-k="${k}" ${extra}>${tag === "textarea" ? "</textarea>" : ""}</div>`;
    function renderForm() {
      active = null;
      Object.keys(pickers).forEach((k) => delete pickers[k]);
      const t = d.question_type;
      $("eForm").innerHTML =
        `<div class="row2"><div class="field"><label>Question type</label><select data-k="question_type">${TYPES.map((x) => opt(x, TYPE_LABEL[x], x === t)).join("")}</select></div>
          <div class="field"><label>Points</label><input type="number" min="1" max="100" data-k="points"></div></div>
        ${field("question_text", "Question *", "textarea")}
        <div class="row2"><div class="field"><label>Anatomy system</label><select data-k="system_id"><option value="">(none)</option>${systems.map((s) => opt(s.id, s.name, s.id === d.system_id)).join("")}</select></div>
          <div class="field"><label>Difficulty</label><select data-k="difficulty">${["EASY", "MEDIUM", "HARD"].map((x) => opt(x, titleCase(x), x === d.difficulty)).join("")}</select></div></div>
        ${field("tags", "Tags (comma separated)", "input", 'placeholder="upper limb, bones"')}
        <div id="typeBlock"></div>
        <div class="row2"><div class="field"><label>Highlight colour</label><input type="color" data-k="highlight_color" style="height:38px;padding:2px"></div>
          <div class="field"><label>Question image (optional)</label><input type="file" id="imgFile" accept="image/*"></div></div>
        <div id="imgBox" class="row small"></div>
        ${field("explanation", "Explanation (shown after submission)", "textarea")}${field("reference_material", "Reference material (text or link)", "textarea")}`;
      $("eForm")
        .querySelectorAll("[data-k]")
        .forEach((el) => {
          const k = el.dataset.k;
          if (el.tagName !== "SELECT") el.value = d[k] ?? "";
          el.oninput = () => {
            d[k] = el.value;
            if (k === "question_type") {
              renderForm();
              refreshMarks();
              bindPick();
            }
            if (k === "highlight_color") refreshMarks();
          };
        });
      const tb = $("typeBlock"),
        mk = (id) => {
          const h = document.createElement("div");
          h.id = id;
          tb.appendChild(h);
          return h;
        };
      if (t === "MULTIPLE_CHOICE" || t === "IDENTIFY_3D") {
        if (t === "IDENTIFY_3D")
          buildPicker(mk("pk_target"), PICK.IDENTIFY_3D[0]);
        const box = mk("optBox");
        const paintO = () => {
          box.innerHTML = `<label>Answer options (select the correct one)</label>${d.options.map((o, i) => `<div class="optrow"><input type="radio" name="corr" ${o.is_correct ? "checked" : ""} data-c="${i}" aria-label="Correct"><input data-o="${i}" value="${esc(o.option_text)}" placeholder="Option ${i + 1}"><button class="btn small danger" data-x="${i}" aria-label="Remove">&times;</button></div>`).join("")}<button class="btn small secondary" id="addOpt">+ Add option</button>`;
          box
            .querySelectorAll("[data-c]")
            .forEach(
              (r) =>
                (r.onchange = () =>
                  d.options.forEach(
                    (o, i) => (o.is_correct = i === +r.dataset.c),
                  )),
            );
          box
            .querySelectorAll("[data-o]")
            .forEach(
              (x) =>
                (x.oninput = () =>
                  (d.options[+x.dataset.o].option_text = x.value)),
            );
          box.querySelectorAll("[data-x]").forEach(
            (x) =>
              (x.onclick = () => {
                d.options.splice(+x.dataset.x, 1);
                paintO();
              }),
          );
          $("addOpt").onclick = () => {
            if (d.options.length < 8) {
              d.options.push({ option_text: "", is_correct: false });
              paintO();
            }
          };
        };
        paintO();
      }
      if (t === "SYSTEM_IDENTIFICATION") {
        buildPicker(mk("pk_target"), PICK.SYSTEM_IDENTIFICATION[0]);
        mk("sysBlock").innerHTML =
          `<div class="field"><label>Correct system *</label><select data-k="correct_system_id"><option value="">Choose...</option>${systems.map((s) => opt(s.id, s.name, s.id === d.correct_system_id)).join("")}</select></div>
          <div class="field"><label>Systems offered as choices (none ticked = all)</label>${systems.map((s) => `<label class="chk"><input type="checkbox" data-sc="${s.id}" ${d.system_choices.includes(s.id) ? "checked" : ""}> ${esc(s.name)}</label>`).join("")}</div>`;
        $("sysBlock").querySelector("select").onchange = (e) =>
          (d.correct_system_id = e.target.value);
        $("sysBlock")
          .querySelectorAll("[data-sc]")
          .forEach(
            (c) =>
              (c.onchange = () => {
                d.system_choices = c.checked
                  ? [...d.system_choices, c.dataset.sc]
                  : d.system_choices.filter((x) => x !== c.dataset.sc);
              }),
          );
      }
      (PICK[t] || [])
        .filter(() => t !== "IDENTIFY_3D" && t !== "SYSTEM_IDENTIFICATION")
        .forEach((cfg) => buildPicker(mk("pk_" + cfg[0]), cfg));
      if (t === "SEQUENCE") {
        const box = mk("seqBox");
        const paintS = () => {
          box.innerHTML = `<label>Items in the CORRECT order (students see them shuffled)</label>${d.items.map((it, i) => `<div class="optrow" style="grid-template-columns:24px 1fr auto"><b>${i + 1}</b><input data-i="${i}" value="${esc(it.text)}" placeholder="Item ${i + 1}"><span class="nowrap"><button class="btn small secondary" data-u="${i}">&uarr;</button> <button class="btn small secondary" data-d="${i}">&darr;</button> <button class="btn small danger" data-x="${i}">&times;</button></span></div>`).join("")}<button class="btn small secondary" id="addItem">+ Add item</button>`;
          const mv = (i, j) => {
            if (j < 0 || j >= d.items.length) return;
            [d.items[i], d.items[j]] = [d.items[j], d.items[i]];
            paintS();
          };
          box
            .querySelectorAll("[data-i]")
            .forEach(
              (x) => (x.oninput = () => (d.items[+x.dataset.i].text = x.value)),
            );
          box
            .querySelectorAll("[data-u]")
            .forEach(
              (x) => (x.onclick = () => mv(+x.dataset.u, +x.dataset.u - 1)),
            );
          box
            .querySelectorAll("[data-d]")
            .forEach(
              (x) => (x.onclick = () => mv(+x.dataset.d, +x.dataset.d + 1)),
            );
          box.querySelectorAll("[data-x]").forEach(
            (x) =>
              (x.onclick = () => {
                d.items.splice(+x.dataset.x, 1);
                paintS();
              }),
          );
          $("addItem").onclick = () => {
            if (d.items.length < 10) {
              d.items.push({ text: "" });
              paintS();
            }
          };
        };
        paintS();
      }
      const paintImg = () => {
        $("imgBox").innerHTML = d.image_path
          ? `<img src="${esc(modelUrlFor("quiz-media", d.image_path))}" alt="" style="max-height:80px;border-radius:6px"> <button class="btn small danger" id="imgRm">Remove image</button>`
          : "";
        if ($("imgRm"))
          $("imgRm").onclick = () => {
            d.image_path = "";
            paintImg();
          };
      };
      paintImg();
      $("imgFile").onchange = async () => {
        const f = $("imgFile").files[0];
        if (!f) return;
        if (f.size > 3 * 1048576)
          return toast("Image must be under 3 MB", "error");
        const path = `questions/${crypto.randomUUID()}-${f.name.replace(/[^\w.-]+/g, "_")}`;
        const { error } = await supabase.storage
          .from("quiz-media")
          .upload(path, f);
        if (error) return toast(error.message, "error");
        d.image_path = path;
        paintImg();
        toast("Image attached", "success");
      };
    }
    renderForm();
    refreshMarks();
    const camInfo = () =>
      ($("camInfo").textContent = d.camera
        ? "Camera saved"
        : "No camera saved (auto-framed)");
    camInfo();
    $("camSet").onclick = () => {
      if (!sc) return;
      d.camera = sc.viewer.getCameraState();
      camInfo();
      toast("Camera saved for this question", "success");
    };
    $("camGo").onclick = () => d.camera && sc?.viewer.setCameraState(d.camera);
    $("camClr").onclick = () => {
      d.camera = null;
      camInfo();
    };

    // ---- validate / preview / save ----
    const msg = (html, cls = "") =>
      ($("eMsg").innerHTML = html
        ? `<div class="feedback ${cls}">${html}</div>`
        : "");
    async function validate() {
      const errs = await rpc("admin_validate_question", { p: toSave(d) });
      msg(
        errs.length
          ? `<b>Fix these first:</b><ul>${errs.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>`
          : "<b>Looks good.</b> This question can be saved.",
        errs.length ? "bad" : "ok",
      );
      return !errs.length;
    }
    const objs = (ids) =>
      sc
        .itemsFor(rowsOf(ids))
        .flatMap((i) => i.names.map((o) => ({ s: i.key, o })));
    const shuffled = (a) => [...a].sort(() => Math.random() - 0.5);
    function studentShape() {
      const t = d.question_type,
        q = {
          id: "preview",
          type: t,
          text: d.question_text,
          points: Number(d.points) || 1,
          image_path: d.image_path || null,
          camera: d.camera,
          color: d.highlight_color,
          system_id: d.system_id || null,
        };
      if (t === "MULTIPLE_CHOICE" || t === "IDENTIFY_3D")
        q.options = d.options.map((o, i) => ({
          id: "o" + i,
          text: o.option_text,
        }));
      if (t === "IDENTIFY_3D" || t === "SYSTEM_IDENTIFICATION")
        q.highlight = objs(d.target_ids);
      if (t === "SYSTEM_IDENTIFICATION")
        q.systems = systems.filter(
          (s) => !d.system_choices.length || d.system_choices.includes(s.id),
        );
      if (t === "LABEL_ANATOMY") {
        q.pins = d.label_ids.map((id, i) => ({
          n: i + 1,
          objects: objs([id]),
        }));
        q.wordbank = shuffled([
          ...new Set([...d.label_ids, ...d.distractor_ids]),
        ]).map((id) => ({ id, text: sc.byId.get(id)?.name || "?" }));
      }
      if (t === "SEQUENCE")
        q.items = shuffled(
          d.items.map((it, i) => ({ id: "i" + i, text: it.text })),
        );
      return q;
    }
    let pv = null;
    $("ePreview").onclick = async () => {
      try {
        if (!(await validate())) return;
        if (!sc && IS3D.has(d.question_type))
          return toast("3D scene unavailable", "error");
        $("ePreviewCard").hidden = false;
        $("eForm").hidden = true;
        pv = new QuestionView($("previewPane"), sc);
        await pv.render(studentShape(), { index: 1, total: 1, onAnswer() {} });
      } catch (e) {
        toast(e.message, "error");
      }
    };
    $("ePreviewX").onclick = () => {
      $("ePreviewCard").hidden = true;
      $("eForm").hidden = false;
      pv = null;
      renderForm();
      refreshMarks();
      bindPick();
    };
    $("eValidate").onclick = () =>
      validate().catch((e) => toast(e.message, "error"));
    const save = async (approve) => {
      try {
        const qid = await rpc("admin_save_question", { p: toSave(d, approve) });
        d.id = qid;
        toast(
          approve ? "Saved and approved" : "Saved (pending review)",
          "success",
        );
        list();
      } catch (e) {
        msg(esc(e.message), "bad");
      }
    };
    $("eSave").onclick = () => save(false);
    $("eApprove").onclick = () => save(true);
    $("eBack").onclick = $("eCancel").onclick = () => {
      if (sc) {
        sc.handlers = {};
        sc.viewer.setMarks([]);
        sc.clearPins();
      }
      list();
    };
  }

  if (qp.get("edit")) return editor(qp.get("edit"));
  if (qp.get("new")) return editor(null);
  await list();
}

const PAGES = {
  dashboard,
  users,
  anatomy,
  models,
  quizzes,
  questions,
  attempts,
  reports,
};
