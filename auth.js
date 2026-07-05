// =============================================================
//  auth.js - Login e sessao do Farol
// =============================================================
//  Protege o painel com usuario e senha. As credenciais ficam em
//  variaveis de ambiente (NUNCA no codigo):
//    AUTH_USER       -> usuario de acesso
//    AUTH_PASSWORD   -> senha de acesso
//    SESSION_SECRET  -> segredo para assinar o cookie de sessao
//
//  Se AUTH_USER e AUTH_PASSWORD nao estiverem definidos, o painel
//  fica SEM login (aberto) — entao defina-os na Render para ativar.
// =============================================================

import crypto from "node:crypto";

const AUTH_USER = process.env.AUTH_USER || "";
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || "";
export const authEnabled = !!(AUTH_USER && AUTH_PASSWORD);

const COOKIE = "farol_session";
const SESSION_DAYS = 7;
// Se nao houver SESSION_SECRET fixo, gera um aleatorio (as sessoes caem
// a cada reinicio do servidor, exigindo novo login — funciona, mas o
// ideal e definir um SESSION_SECRET fixo na Render).
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

if (!authEnabled) {
  console.warn(
    "  [auth] AVISO: AUTH_USER/AUTH_PASSWORD nao definidos — painel SEM login."
  );
}

function sign(value) {
  return crypto.createHmac("sha256", SECRET).update(value).digest("base64url");
}

function makeToken() {
  const exp = Date.now() + SESSION_DAYS * 86400 * 1000;
  const payload = Buffer.from(`${AUTH_USER}.${exp}`).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  if (!token || typeof token !== "string") return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  const expected = sign(payload);
  if (sig.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  const decoded = Buffer.from(payload, "base64url").toString();
  const exp = Number(decoded.split(".").pop());
  return Number.isFinite(exp) && exp > Date.now();
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (header) {
    for (const part of header.split(";")) {
      const i = part.indexOf("=");
      if (i > -1) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
  }
  return out;
}

export function isAuthed(req) {
  if (!authEnabled) return true; // sem credenciais configuradas -> aberto
  return verifyToken(parseCookies(req)[COOKIE]);
}

// Cookie de sessao: HttpOnly (JS nao le), SameSite=Lax, Secure (HTTPS).
function sessionCookie(token, maxAgeSec) {
  return (
    `${COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${maxAgeSec}; ` +
    `SameSite=Lax; Secure`
  );
}

export function handleLogin(req, res) {
  const { user, password } = req.body || {};
  if (
    authEnabled &&
    typeof user === "string" &&
    typeof password === "string" &&
    safeEqual(user, AUTH_USER) &&
    safeEqual(password, AUTH_PASSWORD)
  ) {
    res.setHeader("Set-Cookie", sessionCookie(makeToken(), SESSION_DAYS * 86400));
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, error: "Usuário ou senha incorretos." });
}

export function handleLogout(_req, res) {
  res.setHeader("Set-Cookie", sessionCookie("", 0));
  res.json({ ok: true });
}

export function loginPageHtml() {
  return `<!DOCTYPE html>
<html lang="pt-BR"><head>
<meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Farol — Acesso</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
<style>
  :root{--bg:#0E1420;--surface:#18202F;--surface-2:#1F2A3D;--border:#2B3850;--text:#E9EEF7;--muted:#8593AC;--faint:#5C6982;--accent:#6E8FF5;--alert:#FF5B6E;}
  *{box-sizing:border-box;} html,body{margin:0;height:100%;}
  body{background:radial-gradient(1100px 560px at 80% -10%,rgba(110,143,245,.12),transparent 60%),var(--bg);color:var(--text);font-family:"Inter",system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:34px 30px;width:100%;max-width:360px;box-shadow:0 24px 60px rgba(0,0,0,.35);}
  .brand{display:flex;align-items:center;gap:12px;margin-bottom:24px;}
  .beacon{width:30px;height:30px;position:relative;flex:none;}
  .beacon span{position:absolute;inset:0;margin:auto;width:9px;height:9px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 0 rgba(110,143,245,.6);animation:ping 2.4s ease-out infinite;}
  @keyframes ping{0%{box-shadow:0 0 0 0 rgba(110,143,245,.55);}70%{box-shadow:0 0 0 14px rgba(110,143,245,0);}100%{box-shadow:0 0 0 0 rgba(110,143,245,0);}}
  h1{font-family:"Space Grotesk",sans-serif;font-size:21px;margin:0;line-height:1;}
  .sub{font-size:11.5px;color:var(--muted);letter-spacing:.04em;text-transform:uppercase;}
  label{display:block;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--faint);margin:16px 0 6px;}
  input{width:100%;background:var(--surface-2);color:var(--text);border:1px solid var(--border);border-radius:9px;padding:11px 13px;font-size:14px;font-family:inherit;outline:none;transition:border-color .15s;}
  input:focus{border-color:var(--accent);}
  button{width:100%;margin-top:22px;background:var(--accent);color:#0b1020;border:none;border-radius:9px;padding:12px;font-weight:600;font-size:14px;cursor:pointer;font-family:inherit;transition:filter .15s;}
  button:hover{filter:brightness(1.08);} button:disabled{opacity:.6;cursor:wait;}
  .err{color:var(--alert);font-size:13px;margin-top:14px;min-height:18px;}
</style></head>
<body>
  <form class="card" id="f" autocomplete="on">
    <div class="brand"><div class="beacon"><span></span></div><div><h1>Farol</h1><div class="sub">Acesso restrito</div></div></div>
    <label for="user">Usuário</label>
    <input id="user" name="user" type="text" autocomplete="username" required autofocus />
    <label for="password">Senha</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required />
    <button id="btn" type="submit">Entrar</button>
    <div class="err" id="err"></div>
  </form>
<script>
  const f=document.getElementById("f"),btn=document.getElementById("btn"),err=document.getElementById("err");
  f.addEventListener("submit",async(e)=>{
    e.preventDefault(); err.textContent=""; btn.disabled=true; btn.textContent="Entrando…";
    try{
      const r=await fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({user:document.getElementById("user").value,password:document.getElementById("password").value})});
      if(r.ok){ location.href="/"; return; }
      const d=await r.json().catch(()=>({})); err.textContent=d.error||"Não foi possível entrar.";
    }catch(_){ err.textContent="Erro de conexão. Tente de novo."; }
    btn.disabled=false; btn.textContent="Entrar";
  });
</script>
</body></html>`;
}
