// Anatomy data logic (PostgreSQL + Storage). No Three.js here.
import { supabase } from "./supabase.js";

export async function loadSystems() {
  const { data, error } = await supabase
    .from("anatomy_systems")
    .select("id,name")
    .order("display_order");
  if (error) throw error;
  return data;
}
export function getModelUrl(path) {
  return supabase.storage.from("anatomy-models").getPublicUrl(path).data
    .publicUrl;
}

// Lightweight rows for the hierarchy tree and search (all systems at once).
// Fetched in pages: the API returns at most 1000 rows per request, so one request could silently cut the list short.
const PAGE = 1000;
export async function loadAllStructures() {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("anatomy_structures")
      .select("id,system_id,parent_id,name,model_object_id,model_file_path")
      .order("display_order")
      .order("name")
      .order("id") // stable order across pages
      .range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE) return rows;
  }
}
// Details are cached for the page's lifetime, so clicking the same structure again makes no request.
const structureCache = new Map(); // id -> Promise<row>
export function loadStructureById(id) {
  if (!structureCache.has(id)) {
    const job = (async () => {
      const { data, error } = await supabase
        .from("anatomy_structures")
        .select(
          "id,system_id,name,description,location,function,important_features,anatomy_systems(name)",
        )
        .eq("id", id)
        .single();
      if (error) throw error;
      return data;
    })();
    job.catch(() => structureCache.delete(id)); // never cache a failure
    structureCache.set(id, job);
  }
  return structureCache.get(id);
}

// ---------- Shared scene helpers (Learn, Assessment, Admin question editor) ----------
// Tissue colours: skeleton (bone/cartilage/teeth), muscle (muscle vs tendon), nerves
export function boneColor(name) {
  if (/cartilage/i.test(name)) return "#9fb39b";
  if (/incisor|canine|molar/i.test(name)) return "#f3ecd9";
  return "#e4c9a0";
}
export function muscleColor(name) {
  if (/tendon|aponeurosis|fascia|ligament|retinaculum|raphe|linea/i.test(name))
    return "#dccfbd";
  if (/cartilage/i.test(name)) return "#9fb39b";
  return "#b8482a";
}
export function nerveColor(name) {
  if (
    /nerve|ganglion|plexus|cauda equina|ramus|rami|branch|root of|fibres/i.test(
      name,
    )
  )
    return "#e3cc5a";
  return null;
}
// Per-system look. Systems not listed keep the materials from their own GLB file.
export const systemLook = {
  Skeleton: { colorFor: boneColor, matte: true, frontOnly: true },
  Muscular: { colorFor: muscleColor, matte: true, frontOnly: true },
  Nervous: { colorFor: nerveColor, matte: true },
};

// "system_id|model_object_id" -> structure row (same keys the viewer uses: model key = system id)
export const buildObjMap = (all) =>
  new Map(
    all
      .filter((r) => r.model_object_id)
      .map((r) => [r.system_id + "|" + r.model_object_id, r]),
  );

// Loads the models of the given systems into a viewer. Resolves { loaded, failed:[system names], total }.
export async function loadSceneModels(viewer, systems, all) {
  const jobs = systems
    .map((s) => ({
      s,
      path: all.find((r) => r.system_id === s.id && r.model_file_path)
        ?.model_file_path,
    }))
    .filter((j) => j.path);
  const res = await Promise.allSettled(
    jobs.map((j) =>
      viewer.addModel(j.s.id, getModelUrl(j.path), systemLook[j.s.name] || {}),
    ),
  );
  const failed = jobs
    .filter((_, i) => res[i].status === "rejected")
    .map((j) => j.s.name);
  if (failed.length)
    console.error(
      "Model load failures:",
      res.filter((r) => r.status === "rejected"),
    );
  return { loaded: jobs.length - failed.length, failed, total: jobs.length };
}

// Learning activity (feeds "Continue Learning" and weak-area recommendations). Never throws.
const lastLogged = new Map();
export async function logView(structure) {
  try {
    if (
      !structure?.id ||
      Date.now() - (lastLogged.get(structure.id) || 0) < 30000
    )
      return;
    lastLogged.set(structure.id, Date.now());
    await supabase
      .from("learning_activity")
      .insert({
        structure_id: structure.id,
        system_id: structure.system_id,
        kind: "VIEW",
      });
  } catch (e) {
    console.warn("activity log failed", e);
  }
}
