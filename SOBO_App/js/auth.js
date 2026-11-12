import { supabase } from "./supabase.js";

export async function register(name, email, password) {
  // Role is NOT sent from the client: a DB trigger always creates STUDENT profiles.
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { name } },
  });
  if (error) throw error;
  return data; // data.session is null if email confirmation is enabled
}
export async function login(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (error) throw error;
  return data.user;
}
export async function logout() {
  const { error } = await supabase.auth.signOut();
  if (error) console.error(error);
  location.href = new URL("../login.html", import.meta.url).href;
}
export async function getCurrentUser() {
  const { data, error } = await supabase.auth.getUser();
  if (error) return null;
  return data.user;
}
export async function getCurrentProfile() {
  const user = await getCurrentUser();
  if (!user) return null;
  const { data, error } = await supabase
    .from("profiles")
    .select("id,name,role,created_at")
    .eq("id", user.id)
    .single();
  if (error) {
    console.error(error);
    return null;
  }
  return { ...data, email: user.email };
}
export const homeFor = (role) =>
  role === "ADMIN" ? "admin/dashboard.html" : "student/dashboard.html";
