// DoUpload API – Empfänger-Konten (Code erstellen) und Absender (Code eingeben)
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const RESEND = Deno.env.get("RESEND_API_KEY") ?? "";
const FROM = Deno.env.get("EMAIL_FROM") ?? "DoUpload <onboarding@resend.dev>";
const BUCKET = "uploads";
const MAX_ATTACH = 30 * 1024 * 1024; // darüber: Download-Links statt Anhänge

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });
const fail = (msg: string, status = 400) => json({ error: msg }, status);

const ALPH = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function genCode() {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(b, (x) => ALPH[x % ALPH.length]).join("");
}
function slug(s: string) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss")
    .replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
}
const esc = (s: string) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
function b64(buf: Uint8Array) {
  let s = ""; const CH = 0x8000;
  for (let i = 0; i < buf.length; i += CH) s += String.fromCharCode(...buf.subarray(i, i + CH));
  return btoa(s);
}

/* ---------- Konten: Passwort-Hash (PBKDF2) und Sitzungen ---------- */
const hex = (b: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
async function hashPw(pw: string, saltHex: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  const salt = new Uint8Array(saltHex.match(/../g)!.map((h) => parseInt(h, 16)));
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, key, 256));
}
async function newSession(accountId: string) {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  await sb.from("sessions").insert({ token, account_id: accountId });
  return token;
}
async function accountByToken(token: unknown) {
  if (typeof token !== "string" || token.length !== 64) return null;
  const { data } = await sb.from("sessions").select("expires_at, account:accounts(id,email,name)").eq("token", token).maybeSingle();
  if (!data || new Date(data.expires_at) < new Date()) return null;
  return data.account as any as { id: string; email: string; name: string };
}
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function recipientByCode(code: unknown) {
  if (typeof code !== "string" || !/^[A-Z0-9]{6}$/.test(code.toUpperCase())) return null;
  const { data } = await sb.from("recipients")
    .select("id,name,code,status,expires_at,request:requests(id,advisor_name,advisor_email,title,lang,docs)")
    .eq("code", code.toUpperCase()).maybeSingle();
  if (!data || new Date(data.expires_at) < new Date()) return null;
  return data as any;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return fail("POST only", 405);
  try {
    const ct = req.headers.get("content-type") ?? "";

    /* ---------- Upload (multipart) ---------- */
    if (ct.includes("multipart/form-data")) {
      const fd = await req.formData();
      const r = await recipientByCode(fd.get("code"));
      if (!r) return fail("Code unbekannt", 404);
      if (r.status === "done") return fail("Bereits gesendet", 409);
      const doc = Number(fd.get("doc"));
      const file = fd.get("file");
      if (!(file instanceof File) || !Number.isInteger(doc) || doc < 0 || doc >= r.request.docs.length) return fail("Ungültig");
      if (!/^(image\/|application\/pdf)/.test(file.type)) return fail("Nur Bilder oder PDF");
      const path = `${r.id}/${doc}_${crypto.randomUUID()}`;
      const { error } = await sb.storage.from(BUCKET).upload(path, file, { contentType: file.type });
      if (error) return fail(error.message, 500);
      const { data: up, error: e2 } = await sb.from("uploads")
        .insert({ recipient_id: r.id, doc_index: doc, path, filename: file.name, mime: file.type, size: file.size })
        .select("id").single();
      if (e2) return fail(e2.message, 500);
      return json({ id: up.id });
    }

    const body = await req.json();
    const a = body.action;

    /* ---------- Empfänger-Konten ---------- */
    if (a === "register") {
      const email = String(body.email ?? "").trim().toLowerCase(), name = String(body.name ?? "").trim().slice(0, 80);
      const pw = String(body.password ?? "");
      if (!EMAIL_RE.test(email)) return fail("Bitte eine gültige E-Mail-Adresse angeben.");
      if (pw.length < 8) return fail("Das Passwort muss mindestens 8 Zeichen haben.");
      if (!name) return fail("Bitte Ihren Namen angeben.");
      const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
      const { data: acc, error } = await sb.from("accounts")
        .insert({ email, name, salt, pass_hash: await hashPw(pw, salt) }).select("id,email,name").single();
      if (error) return fail(error.code === "23505" ? "Diese E-Mail ist schon registriert. Bitte anmelden." : error.message, 409);
      // frühere Test-Anfragen mit dieser E-Mail übernehmen
      await sb.from("requests").update({ account_id: acc.id }).is("account_id", null).eq("advisor_email", email);
      return json({ token: await newSession(acc.id), name: acc.name, email: acc.email });
    }

    if (a === "login") {
      const email = String(body.email ?? "").trim().toLowerCase();
      const { data: acc } = await sb.from("accounts").select("id,email,name,salt,pass_hash").eq("email", email).maybeSingle();
      if (!acc || (await hashPw(String(body.password ?? ""), acc.salt)) !== acc.pass_hash) return fail("E-Mail oder Passwort falsch.", 401);
      return json({ token: await newSession(acc.id), name: acc.name, email: acc.email });
    }

    if (a === "logout") { if (typeof body.token === "string") await sb.from("sessions").delete().eq("token", body.token); return json({ ok: true }); }

    if (["me", "create", "list", "files", "delete"].includes(a)) {
      const acc = await accountByToken(body.token);
      if (!acc) return fail("Bitte neu anmelden.", 401);

      if (a === "me") return json({ name: acc.name, email: acc.email });

      if (a === "create") {
        const q = body.request ?? {};
        const people: string[] = (q.people ?? []).map((s: string) => String(s).trim()).filter(Boolean).slice(0, 200);
        const docs = (q.docs ?? []).filter((d: any) => d?.title?.trim()).slice(0, 30)
          .map((d: any) => ({ title: String(d.title).trim(), hint: String(d.hint ?? "").trim(), ...(Number.isInteger(d.tpl) ? { tpl: d.tpl } : {}) }));
        if (!people.length || !docs.length) return fail("Personen und Dokumente angeben");
        const { data: rq, error } = await sb.from("requests").insert({
          account_id: acc.id, advisor_name: acc.name, advisor_email: acc.email,
          title: String(q.title ?? "").trim(), lang: String(q.lang ?? ""), docs,
        }).select("id").single();
        if (error) return fail(error.message, 500);
        const rows = people.map((name) => ({ request_id: rq.id, name, code: genCode() }));
        const { data: rec, error: e3 } = await sb.from("recipients").insert(rows).select("name,code");
        if (e3) return fail(e3.message, 500);
        return json({ id: rq.id, recipients: rec });
      }

      if (a === "list") {
        const { data, error } = await sb.from("requests")
          .select("id,created_at,advisor_name,title,lang,docs,recipients(id,name,code,status,lang,done_at,email_status,expires_at,uploads(count))")
          .eq("account_id", acc.id).order("created_at", { ascending: false }).limit(100);
        if (error) return fail(error.message, 500);
        return json({ requests: data });
      }

      if (a === "files") {
        const { data: rc } = await sb.from("recipients").select("id,name,request:requests(account_id,docs)").eq("code", String(body.code ?? "")).maybeSingle();
        if (!rc || (rc as any).request.account_id !== acc.id) return fail("Nicht gefunden", 404);
        const docs = (rc as any).request.docs as { title: string }[];
        const { data: ups } = await sb.from("uploads").select("*").eq("recipient_id", rc.id).order("doc_index").order("created_at");
        const out = [];
        for (const u of ups ?? []) {
          const same = (ups ?? []).filter((x: any) => x.doc_index === u.doc_index);
          const k = same.indexOf(u);
          const ext = (u.filename.match(/\.[A-Za-z0-9]+$/)?.[0] ?? (u.mime === "application/pdf" ? ".pdf" : ".jpg")).toLowerCase();
          const nice = `${String(u.doc_index + 1).padStart(2, "0")}_${slug(docs[u.doc_index]?.title ?? "Dokument")}_${slug(rc.name) || "Kunde"}${same.length > 1 ? "_Teil" + (k + 1) : ""}${ext}`;
          const { data: su } = await sb.storage.from(BUCKET).createSignedUrl(u.path, 3600, { download: nice });
          out.push({ doc: u.doc_index, name: nice, size: u.size, url: su?.signedUrl });
        }
        return json({ files: out });
      }

      if (a === "delete") {
        const { data: rq } = await sb.from("requests").select("id,recipients(id)").eq("id", String(body.id ?? "")).eq("account_id", acc.id).maybeSingle();
        if (!rq) return fail("Nicht gefunden", 404);
        const ids = ((rq as any).recipients ?? []).map((x: any) => x.id);
        if (ids.length) {
          const { data: ups } = await sb.from("uploads").select("path").in("recipient_id", ids);
          if (ups?.length) await sb.storage.from(BUCKET).remove(ups.map((u: any) => u.path));
        }
        await sb.from("requests").delete().eq("id", rq.id);
        return json({ ok: true });
      }
    }

    /* ---------- Kunde ---------- */
    const r = await recipientByCode(body.code);
    if (!r) return fail("Code unbekannt", 404);

    if (a === "get") {
      return json({
        name: r.name, status: r.status,
        request: { advisorName: r.request.advisor_name, title: r.request.title, lang: r.request.lang, docs: r.request.docs },
      });
    }

    if (a === "remove") {
      const { data: up } = await sb.from("uploads").select("id,path").eq("id", body.id).eq("recipient_id", r.id).maybeSingle();
      if (up) { await sb.storage.from(BUCKET).remove([up.path]); await sb.from("uploads").delete().eq("id", up.id); }
      return json({ ok: true });
    }

    if (a === "submit") {
      if (r.status === "done") return json({ ok: true, already: true });
      const docs = r.request.docs as { title: string }[];
      const { data: ups } = await sb.from("uploads").select("*").eq("recipient_id", r.id).order("created_at");
      const byDoc = docs.map((_, i) => (ups ?? []).filter((u: any) => u.doc_index === i));
      if (byDoc.some((l) => !l.length)) return fail("Es fehlen noch Dokumente");

      // Dateinamen für den Berater (deutsch, eindeutig)
      const files = byDoc.flatMap((list, i) => list.map((u: any, k: number) => {
        const ext = (u.filename.match(/\.[A-Za-z0-9]+$/)?.[0] ?? (u.mime === "application/pdf" ? ".pdf" : ".jpg")).toLowerCase();
        return { ...u, nice: `${String(i + 1).padStart(2, "0")}_${slug(docs[i].title)}_${slug(r.name) || "Kunde"}${list.length > 1 ? "_Teil" + (k + 1) : ""}${ext}` };
      }));
      const total = files.reduce((s, f) => s + f.size, 0);

      let attachments: any[] = [], links = "";
      if (total <= MAX_ATTACH) {
        for (const f of files) {
          const { data, error } = await sb.storage.from(BUCKET).download(f.path);
          if (error) return fail(error.message, 500);
          attachments.push({ filename: f.nice, content: b64(new Uint8Array(await data.arrayBuffer())) });
        }
      } else {
        for (const f of files) {
          const { data } = await sb.storage.from(BUCKET).createSignedUrl(f.path, 7 * 24 * 3600, { download: f.nice });
          links += `<li><a href="${data?.signedUrl}">${esc(f.nice)}</a></li>`;
        }
      }

      const subject = `Unterlagen ${r.name}${r.request.title ? " – " + r.request.title : ""} (Code ${r.code})`;
      const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;color:#14212b">
        <p>Hallo ${esc(r.request.advisor_name)},</p>
        <p><b>${esc(r.name)}</b> hat alle angeforderten Unterlagen hochgeladen${r.request.title ? ` (${esc(r.request.title)})` : ""}:</p>
        <ol>${docs.map((d, i) => `<li>${esc(d.title)} – ${byDoc[i].length} Datei(en)</li>`).join("")}</ol>
        ${links ? `<p>Die Dateien sind zu groß für den Anhang. Download (7 Tage gültig):</p><ul>${links}</ul>` : `<p>Die Dateien hängen an dieser E-Mail. Sie finden sie außerdem unter „Mein Bereich“.</p>`}
        <p style="color:#5d6b78;font-size:13px">Code ${esc(r.code)} · Sprache des Kunden: ${esc(body.lang ?? "")}</p></div>`;

      let emailOk = false;
      if (RESEND) {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: FROM, to: [r.request.advisor_email], subject, html, attachments }),
        });
        emailOk = res.ok;
        if (!res.ok) console.error("Resend:", res.status, await res.text());
      }
      // Dateien bleiben im Bereich des Empfängers abrufbar – auch wenn die E-Mail nicht ankommt.
      await sb.from("recipients").update({ status: "done", done_at: new Date().toISOString(), lang: body.lang ?? null, email_status: emailOk ? "sent" : "failed" }).eq("id", r.id);
      return json({ ok: true });
    }

    return fail("Unbekannte Aktion");
  } catch (e) {
    return fail(String((e as Error).message ?? e), 500);
  }
});
