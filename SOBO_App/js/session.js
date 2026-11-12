// Session guards + small UI helpers shared by every student/admin page.
import { getCurrentProfile } from "./auth.js";
import { supabase } from "./supabase.js";
import { logout } from "./auth.js";
const root = (p) => new URL("../" + p, import.meta.url).href;

export async function requireAuth() {
  const profile = await getCurrentProfile();
  if (!profile) {
    location.replace(root("login.html"));
    throw new Error("Not authenticated");
  }
  return profile;
}
export async function requireStudent() {
  const p = await requireAuth();
  if (p.role !== "STUDENT") {
    location.replace(root("admin/dashboard.html"));
    throw new Error("Students only");
  }
  return p;
}
export async function requireAdmin() {
  const p = await requireAuth();
  if (p.role !== "ADMIN") {
    location.replace(root("student/dashboard.html"));
    throw new Error("Admins only");
  }
  return p;
}
// UI guard only. Real enforcement is RLS + SECURITY DEFINER functions in the database.

// ---------- helpers ----------
export const $ = (id) => document.getElementById(id);
export const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const fmtDate = (iso) =>
  iso
    ? new Date(iso).toLocaleString([], {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "-";
export const fmtDay = (iso) =>
  iso ? new Date(iso).toLocaleDateString([], { dateStyle: "medium" }) : "-";
export const fmtDur = (sec) => {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600),
    m = Math.floor((sec % 3600) / 60),
    s = sec % 60;
  return h
    ? `${h}h ${m}m`
    : m
      ? `${m}m ${String(s).padStart(2, "0")}s`
      : `${s}s`;
};
export const pct = (n) =>
  n == null ? "-" : `${Number(n).toFixed(Number(n) % 1 ? 1 : 0)}%`;
export const titleCase = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/^\w|\s\w/g, (c) => c.toUpperCase());
export const modelUrlFor = (bucket, path) =>
  supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl;

// Calls a database function and throws a readable Error.
export async function rpc(name, args = {}) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message || "Request failed");
  return data;
}

export function toast(msg, kind = "") {
  let box = $("toasts");
  if (!box) {
    box = document.createElement("div");
    box.id = "toasts";
    document.body.appendChild(box);
  }
  const t = document.createElement("div");
  t.className = "toast " + kind;
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => t.remove(), kind === "error" ? 6000 : 3000);
}

// ---------- navigation ----------
const NAV = {
  STUDENT: [
    ["dashboard", "Dashboard"],
    ["learn", "Learn"],
    ["assessment", "Assessment"],
    ["history", "History"],
    ["profile", "Profile"],
  ],
  ADMIN: [
    ["dashboard", "Dashboard"],
    ["users", "Users"],
    ["anatomy", "Anatomy"],
    ["models", "Models"],
    ["quizzes", "Quizzes"],
    ["questions", "Questions"],
    ["attempts", "Attempts"],
    ["reports", "Reports"],
  ],
};
// ---------- level / XP pill in the top bar (students only) ----------
// The gamification block comes from my_dashboard; it is cached for a minute per tab so moving
// between pages does not repeat the request.
const XP_TTL = 60000;
const xpKey = () => "navxp:" + (currentProfileId || "");
let currentProfileId = null;
function readXPCache() {
  try {
    const c = JSON.parse(sessionStorage.getItem(xpKey()) || "null");
    return c && Date.now() - c.t < XP_TTL ? c.g : null;
  } catch {
    return null;
  }
}
// Draws the pill from a gamification object ({ level, xp, next_level_xp, level_progress }) and caches it.
export function setNavXP(g) {
  if (!g) return;
  try {
    sessionStorage.setItem(xpKey(), JSON.stringify({ t: Date.now(), g }));
  } catch {}
  const el = $("navXp");
  if (!el) return;
  const prog = Math.max(0, Math.min(100, Number(g.level_progress) || 0));
  const toNext =
    g.next_level_xp != null ? `${g.next_level_xp - g.xp} XP to level ${g.level + 1}` : "";
  el.innerHTML = `<span class="lvl">Lv ${esc(g.level)}</span><span class="xpbar" aria-hidden="true"><i style="width:${prog}%"></i></span><span class="pts">${esc(g.xp)} XP</span>`;
  el.title = `Level ${g.level} · ${g.xp} XP${toNext ? " · " + toNext : ""}`;
  el.hidden = false;
}
// Forces the next page (or a later call) to fetch fresh numbers, e.g. after a quiz is submitted.
export function invalidateNavXP() {
  try {
    sessionStorage.removeItem(xpKey());
  } catch {}
}
async function loadNavXP() {
  const cached = readXPCache();
  if (cached) return setNavXP(cached);
  try {
    setNavXP((await rpc("my_dashboard"))?.gamification);
  } catch (e) {
    console.warn("XP unavailable", e);
  }
}

// Renders the top bar into <nav class="top" id="nav">. `active` is the page name, e.g. "assessment".
// opts.xp = false skips the XP request (the caller will pass the numbers to setNavXP itself).
export function mountNav(profile, active, { xp = true } = {}) {
  currentProfileId = profile.id;
  const nav = $("nav");
  if (!nav) return;
  const base = profile.role === "ADMIN" ? root("admin/") : root("student/");
  nav.className = "top";
  const initials =
    String(profile.name || "?")
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0])
      .join("")
      .toUpperCase() || "?";
  nav.innerHTML =
    `<a class="brand" href="${base}dashboard.html"><span class="logo">A</span><span class="nm">Anatomy Learning</span></a>` +
    `<div class="links">${NAV[profile.role]
      .map(
        ([k, label]) =>
          `<a href="${base}${k}.html" ${k === active ? 'aria-current="page"' : ""}>${label}</a>`,
      )
      .join("")}</div>` +
    `<span class="sp"></span>${profile.role === "STUDENT" ? `<a class="xp" id="navXp" href="${base}profile.html" hidden></a>` : ""}<span class="who"><span class="avatar">${esc(initials)}</span><span class="nm">${esc(profile.name)}</span>${profile.role === "ADMIN" ? '<span class="role">Admin</span>' : ""}</span><a href="#" id="out">Logout</a>`;
  $("out").onclick = (e) => {
    e.preventDefault();
    logout();
  };
  if (profile.role === "STUDENT") {
    const cached = readXPCache();
    if (cached) setNavXP(cached);
    else if (xp) loadNavXP();
  }
}

// ---------- tiny charts (no library) ----------
// points: [{ label, value (0..max) }]
export function lineChart(el, points, { max = 100, suffix = "%" } = {}) {
  if (!points.length) {
    el.innerHTML = '<p class="muted">No data yet.</p>';
    return;
  }
  const W = 560,
    H = 190,
    L = 34,
    R = 10,
    T = 12,
    B = 26,
    n = points.length;
  const x = (i) =>
      L + (n === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (n - 1)),
    y = (v) => T + (1 - Math.min(Math.max(v, 0), max) / max) * (H - T - B);
  const grid = [0, 25, 50, 75, 100]
    .map((g) => {
      const v = (g / 100) * max;
      return `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="gl"/><text x="${L - 4}" y="${y(v) + 4}" text-anchor="end">${Math.round(v)}</text>`;
    })
    .join("");
  const line = points.map((p, i) => `${x(i)},${y(p.value)}`).join(" ");
  const dots = points
    .map(
      (p, i) =>
        `<circle cx="${x(i)}" cy="${y(p.value)}" r="4"><title>${esc(p.label)}: ${p.value}${suffix}</title></circle>`,
    )
    .join("");
  const step = Math.ceil(n / 6),
    xl = points
      .map((p, i) =>
        i % step === 0
          ? `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${esc(String(p.short ?? i + 1))}</text>`
          : "",
      )
      .join("");
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="linechart" role="img" aria-label="Trend chart">${grid}<polyline points="${line}" fill="none"/>${dots}${xl}</svg>`;
}
// rows: [{ label, value, note? }] -> horizontal bars
export function barChart(
  el,
  rows,
  { max = 100, suffix = "%", good = 70, warn = 50 } = {},
) {
  if (!rows.length) {
    el.innerHTML = '<p class="muted">No data yet.</p>';
    return;
  }
  el.innerHTML = rows
    .map((r) => {
      const v = Number(r.value) || 0,
        c = v >= good ? "ok" : v >= warn ? "mid" : "bad";
      return `<div class="bar"><span class="bl">${esc(r.label)}</span><span class="bt"><i class="${c}" style="width:${Math.min(100, (v / max) * 100)}%"></i></span><span class="bv">${v}${suffix}${r.note ? ` <small>${esc(r.note)}</small>` : ""}</span></div>`;
    })
    .join("");
}

// ---------- CSV ----------
export function downloadCSV(filename, rows) {
  const cell = (v) => {
    v = v == null ? "" : String(v);
    return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  const blob = new Blob(
    ["﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n")],
    { type: "text/csv;charset=utf-8" },
  );
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// Confirm dialog (promise). Uses <dialog>; falls back to window.confirm.
export function confirmBox(html, { ok = "OK", cancel = "Cancel" } = {}) {
  return new Promise((resolve) => {
    if (!window.HTMLDialogElement) {
      resolve(confirm(html.replace(/<[^>]+>/g, " ")));
      return;
    }
    const d = document.createElement("dialog");
    d.className = "confirm";
    d.innerHTML = `<div>${html}</div><div class="row2"><button class="btn secondary" value="no">${esc(cancel)}</button><button class="btn" value="yes">${esc(ok)}</button></div>`;
    d.addEventListener("click", (e) => {
      const v = e.target.closest("button")?.value;
      if (v) {
        d.close();
        resolve(v === "yes");
      }
    });
    d.addEventListener("cancel", () => resolve(false));
    d.addEventListener("close", () => d.remove());
    document.body.appendChild(d);
    d.showModal();
  });
}
