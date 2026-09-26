// GermanIAI API — chat privado con usuario y contraseña, biblioteca privada y archivo revisado.
//
// Variables de entorno (se cargan en Render, nunca en el código):
//   ANTHROPIC_API_KEY  clave de la API de Anthropic (obligatoria para el chat)
//   ADMIN_USUARIO      usuario del titular (por defecto «dohmenger»)
//   ADMIN_CLAVE        contraseña del titular: entra al chat, a la biblioteca y al panel /admin
//   SESION_SECRETO     firma de las sesiones (Render la genera sola)
//   GITHUB_TOKEN       opcional: biblioteca privada, usuarios adicionales y archivo público
//   GITHUB_PRIVADO     repositorio privado (pendientes, usuarios, biblioteca)
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ias, familias } = require('./catalogo.json');

const VERSION = '2026-09-26';
const PORT = process.env.PORT || 10000;
const KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC = (process.env.ANTHROPIC_BASE || 'https://api.anthropic.com').replace(/\/$/, '');
const MAX_POR_HORA = +process.env.MAX_POR_HORA || 15;                  // preguntas por usuario por hora
const MAX_POR_HORA_TITULAR = +process.env.MAX_POR_HORA_TITULAR || 60;  // preguntas del titular por hora
const MAX_POR_DIA = +process.env.MAX_POR_DIA || 300;                    // tope diario de los demás usuarios (control de costo)
const MAX_TOKENS = +process.env.MAX_TOKENS || 2500;
const MAX_BUSQUEDAS = +process.env.MAX_BUSQUEDAS || 5;                  // búsquedas web por pregunta
const ORIGENES = (process.env.ORIGENES || 'https://germaniai.com,http://germaniai.com,https://www.germaniai.com,http://www.germaniai.com,https://dohmenger-tech.github.io').split(',').map(s => s.trim()).filter(Boolean);

const GITHUB_API = (process.env.GITHUB_API || 'https://api.github.com').replace(/\/$/, '');
const GH_TOKEN = process.env.GITHUB_TOKEN;                                              // token con acceso sólo a los dos repositorios
const GH_PUBLICO = process.env.GITHUB_REPO || 'dohmenger-tech/germaniai-site';          // archivo público (lo aprobado)
const GH_PRIVADO = process.env.GITHUB_PRIVADO || 'dohmenger-tech/germaniai-pendientes'; // repositorio PRIVADO

const ADMIN_USUARIO = (process.env.ADMIN_USUARIO || 'dohmenger').trim().toLowerCase();
const ADMIN_CLAVE = process.env.ADMIN_CLAVE;
const SECRETO = process.env.SESION_SECRETO || crypto.randomBytes(32).toString('hex'); // sin la variable, las sesiones se pierden al reiniciar
const SESION_MS = (+process.env.SESION_DIAS || 30) * 86400e3;
const BIBLIOTECA_DIR = process.env.BIBLIOTECA_DIR || '/etc/secrets';   // archivos secretos de Render (alternativa a GitHub)
const DIRECTIVA_DOC = process.env.DIRECTIVA_DOC || 'GermanIAI.md';

// ───────────────────────── utilidades ─────────────────────────
const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const iguales = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const espera = ms => new Promise(r => setTimeout(r, ms));
function ipDe(req) { return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(); }
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
function leerCuerpo(req, max) {
  return new Promise((ok, mal) => {
    let b = '', largo = false;
    req.on('data', c => { if (largo) return; b += c; if (b.length > max) { largo = true; mal(Object.assign(new Error('Demasiado grande'), { code: 413 })); } });
    req.on('end', () => { if (largo) return; try { ok(JSON.parse(b || '{}')); } catch (e) { mal(Object.assign(new Error('JSON inválido'), { code: 400 })); } });
    req.on('error', mal);
  });
}

// Primer filtro automático (la revisión humana es la que decide): quita correos, teléfonos, DNI y CUIT.
function anonimizar(t) {
  return String(t)
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[correo omitido]')
    .replace(/\b\d{2}-?\d{7,8}-?\d\b/g, '[CUIT/CUIL omitido]')
    .replace(/\b\d{1,2}\.?\d{3}\.?\d{3}\b/g, '[número omitido]')
    .replace(/(\+?\d[\d\s().-]{7,}\d)/g, '[teléfono omitido]');
}
function slug(t) { return String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'consulta'; }

// ───────────────────────── GitHub ─────────────────────────
async function gh(metodo, repo, ruta, cuerpo, crudo) {
  const r = await fetch(`${GITHUB_API}/repos/${repo}/contents/${ruta}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${GH_TOKEN}`, 'User-Agent': 'germaniai-api', Accept: crudo ? 'application/vnd.github.raw+json' : 'application/vnd.github+json' },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined
  });
  if (crudo && r.ok) return { ok: true, status: r.status, texto: await r.text() };
  const j = await r.json().catch(() => ({}));
  if (!r.ok && r.status !== 404) console.error('GitHub', metodo, ruta, r.status, JSON.stringify(j).slice(0, 200));
  return { ok: r.ok, status: r.status, j };
}
const b64 = o => Buffer.from(JSON.stringify(o, null, 1)).toString('base64');
const deB64 = t => JSON.parse(Buffer.from(t, 'base64').toString('utf8'));

async function guardarPendiente(reg) {
  if (!GH_TOKEN) return false;
  const r = await gh('PUT', GH_PRIVADO, `pendientes/${reg.id}.json`, { message: `Pendiente: ${reg.pregunta.slice(0, 60)}`, content: b64(reg) });
  return r.ok;
}
async function listarPendientes() {
  if (!GH_TOKEN) return [];
  const r = await gh('GET', GH_PRIVADO, 'pendientes');
  if (!r.ok || !Array.isArray(r.j)) return [];
  const archivos = r.j.filter(f => f.name.endsWith('.json')).sort((a, b) => b.name.localeCompare(a.name)).slice(0, 50);
  const out = [];
  for (const f of archivos) { const x = await gh('GET', GH_PRIVADO, f.path); if (x.ok) out.push({ ...deB64(x.j.content), _sha: x.j.sha }); }
  return out;
}
async function aprobar(id, cambios) {
  const x = await gh('GET', GH_PRIVADO, `pendientes/${id}.json`); if (!x.ok) return false;
  const reg = deB64(x.j.content);
  if (cambios.pregunta) reg.pregunta = String(cambios.pregunta).slice(0, 4000);
  if (cambios.respuesta) reg.respuesta = String(cambios.respuesta).slice(0, 30000);
  reg.aprobada = new Date().toISOString();
  const p = await gh('PUT', GH_PUBLICO, `investigaciones/${id}.json`, { message: `Publicada: ${reg.pregunta.slice(0, 60)}`, content: b64(reg) });
  if (!p.ok) return false;
  await gh('DELETE', GH_PRIVADO, `pendientes/${id}.json`, { message: `Aprobada ${id}`, sha: x.j.sha });
  return `https://germaniai.com/archivo.html?id=${id}`;
}
async function descartar(id) {
  const x = await gh('GET', GH_PRIVADO, `pendientes/${id}.json`); if (!x.ok) return false;
  return (await gh('DELETE', GH_PRIVADO, `pendientes/${id}.json`, { message: `Descartada ${id}`, sha: x.j.sha })).ok;
}

// ───────────────────────── usuarios y sesiones ─────────────────────────
// El titular se define por variables de entorno. Los demás usuarios viven en el repositorio privado
// (usuarios/<usuario>.json) con la contraseña guardada como hash scrypt con sal; nunca en texto plano.
const USUARIO_OK = /^[a-z0-9._-]{3,32}$/;
function hashClave(clave, sal) { return crypto.scryptSync(String(clave), sal, 64).toString('hex'); }
// Marca de versión de la contraseña dentro de la sesión: si la contraseña cambia, las sesiones viejas dejan de valer.
// Es un HMAC con el secreto del servidor, así que la sesión no revela nada útil sobre la contraseña.
const marca = t => crypto.createHmac('sha256', SECRETO).update(String(t)).digest('hex').slice(0, 16);
const versionTitular = () => marca('titular:' + ADMIN_CLAVE);

const cacheUsuarios = new Map();
async function leerUsuario(u, fresco) {
  if (!GH_TOKEN || !USUARIO_OK.test(u)) return null;
  const c = cacheUsuarios.get(u);
  if (!fresco && c && Date.now() - c.t < 60e3) return c.reg;
  const x = await gh('GET', GH_PRIVADO, `usuarios/${u}.json`);
  const reg = x.ok ? { ...deB64(x.j.content), _sha: x.j.sha } : null;
  cacheUsuarios.set(u, { t: Date.now(), reg });
  return reg;
}
async function listarUsuarios() {
  if (!GH_TOKEN) return [];
  const r = await gh('GET', GH_PRIVADO, 'usuarios');
  if (!r.ok || !Array.isArray(r.j)) return [];
  const out = [];
  for (const f of r.j.filter(f => f.name.endsWith('.json'))) {
    const reg = await leerUsuario(f.name.replace(/\.json$/, ''), true);
    if (reg) out.push({ usuario: reg.usuario, nombre: reg.nombre || '', creado: reg.creado, activo: reg.activo !== false });
  }
  return out;
}
async function guardarUsuario(usuario, nombre, clave) {
  const previo = await leerUsuario(usuario, true);
  const sal = crypto.randomBytes(16).toString('hex');
  const reg = { usuario, nombre: String(nombre || '').slice(0, 80), sal, hash: hashClave(clave, sal), rol: 'usuario', activo: true, creado: previo?.creado || new Date().toISOString(), actualizado: new Date().toISOString() };
  const r = await gh('PUT', GH_PRIVADO, `usuarios/${usuario}.json`, { message: `${previo ? 'Nueva contraseña' : 'Alta'}: ${usuario}`, content: b64(reg), ...(previo ? { sha: previo._sha } : {}) });
  cacheUsuarios.delete(usuario);
  return r.ok;
}
async function borrarUsuario(usuario) {
  const reg = await leerUsuario(usuario, true); if (!reg) return false;
  const r = await gh('DELETE', GH_PRIVADO, `usuarios/${usuario}.json`, { message: `Baja: ${usuario}`, sha: reg._sha });
  cacheUsuarios.delete(usuario);
  return r.ok;
}

function firmar(datos) { const p = Buffer.from(JSON.stringify(datos)).toString('base64url'); return p + '.' + crypto.createHmac('sha256', SECRETO).update(p).digest('base64url'); }
function leerToken(t) {
  const [p, f] = String(t || '').split('.');
  if (!p || !f) return null;
  if (!iguales(f, crypto.createHmac('sha256', SECRETO).update(p).digest('base64url'))) return null;
  try { const d = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); return d && d.exp > Date.now() ? d : null; } catch (e) { return null; }
}
async function sesion(req) {
  const h = String(req.headers.authorization || '');
  const d = leerToken(h.startsWith('Bearer ') ? h.slice(7).trim() : '');
  if (!d) return null;
  if (d.r === 'titular') return ADMIN_CLAVE && d.u === ADMIN_USUARIO && d.v === versionTitular() ? { u: d.u, r: 'titular', n: 'Titular' } : null;
  const reg = await leerUsuario(d.u);
  return reg && reg.activo !== false && d.v === marca(reg.hash) ? { u: d.u, r: 'usuario', n: reg.nombre || d.u } : null;
}

// Límite de intentos fallidos: por IP y por IP+usuario, en ventanas de 15 minutos.
const fallos = new Map();
function contar(k) { const a = (fallos.get(k) || []).filter(t => Date.now() - t < 15 * 60e3); fallos.set(k, a); return a.length; }
function anotarFallo(k) { const a = fallos.get(k) || []; a.push(Date.now()); fallos.set(k, a); }
setInterval(() => { for (const k of fallos.keys()) if (!contar(k)) fallos.delete(k); }, 10 * 60e3).unref();

async function login(req, res) {
  const ip = ipDe(req);
  let d; try { d = await leerCuerpo(req, 4000); } catch (e) { return json(res, e.code || 400, { error: 'Solicitud inválida.' }); }
  const usuario = String(d.usuario || '').trim().toLowerCase(), clave = String(d.clave || '');
  if (contar('ip:' + ip) >= 20 || contar('iu:' + ip + ':' + usuario) >= 8) return json(res, 429, { error: 'Demasiados intentos fallidos. Esperá 15 minutos y probá de nuevo.' });
  let rol = null, version = null, nombre = null;
  if (ADMIN_CLAVE && usuario === ADMIN_USUARIO && iguales(sha(clave), sha(ADMIN_CLAVE))) { rol = 'titular'; version = versionTitular(); nombre = 'Titular'; }
  else if (USUARIO_OK.test(usuario) && usuario !== ADMIN_USUARIO) {
    const reg = await leerUsuario(usuario, true);
    if (reg && reg.activo !== false && iguales(hashClave(clave, reg.sal), reg.hash)) { rol = 'usuario'; version = marca(reg.hash); nombre = reg.nombre || usuario; }
  }
  if (!rol) {
    anotarFallo('ip:' + ip); anotarFallo('iu:' + ip + ':' + usuario);
    await espera(600);
    if (!ADMIN_CLAVE && usuario === ADMIN_USUARIO) return json(res, 503, { error: 'Falta configurar la contraseña del titular (ADMIN_CLAVE) en Render.' });
    return json(res, 401, { error: 'Usuario o contraseña incorrectos.' });
  }
  const token = firmar({ u: usuario, r: rol, v: version, exp: Date.now() + SESION_MS });
  console.log('Ingreso', usuario, rol, ip);
  return json(res, 200, { token, usuario, rol, nombre, vence: new Date(Date.now() + SESION_MS).toISOString() });
}

// ───────────────────────── biblioteca privada ─────────────────────────
// Documentos del titular: carpeta biblioteca/ del repositorio privado y, como alternativa, los
// archivos secretos de Render (/etc/secrets). Nunca se sirven sin sesión de titular.
const NOMBRE_DOC_OK = /^[\w .()áéíóúñÁÉÍÓÚÑ-]{1,120}\.(md|txt)$/i;
const cacheDocs = new Map();
async function listarBiblioteca() {
  const docs = [];
  if (GH_TOKEN) {
    const r = await gh('GET', GH_PRIVADO, 'biblioteca');
    if (r.ok && Array.isArray(r.j)) r.j.filter(f => f.type === 'file' && NOMBRE_DOC_OK.test(f.name)).forEach(f => docs.push({ nombre: f.name, bytes: f.size, origen: 'github' }));
  }
  try {
    for (const n of fs.readdirSync(BIBLIOTECA_DIR)) {
      if (NOMBRE_DOC_OK.test(n) && !docs.some(d => d.nombre === n)) docs.push({ nombre: n, bytes: fs.statSync(path.join(BIBLIOTECA_DIR, n)).size, origen: 'render' });
    }
  } catch (e) { /* sin archivos secretos */ }
  return docs.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}
async function leerDoc(nombre) {
  if (!NOMBRE_DOC_OK.test(nombre)) return null;
  const c = cacheDocs.get(nombre);
  if (c && Date.now() - c.t < 5 * 60e3) return c.texto;
  let texto = null;
  if (GH_TOKEN) { const x = await gh('GET', GH_PRIVADO, 'biblioteca/' + encodeURIComponent(nombre), null, true); if (x.ok) texto = x.texto; }
  if (texto === null) { try { texto = fs.readFileSync(path.join(BIBLIOTECA_DIR, path.basename(nombre)), 'utf8'); } catch (e) { /* no está */ } }
  if (texto !== null) cacheDocs.set(nombre, { t: Date.now(), texto });
  return texto;
}

// ───────────────────────── IA ─────────────────────────
let MODELO = process.env.MODEL || null;
async function elegirModelo() {
  if (MODELO) return MODELO;
  try {
    const r = await fetch(`${ANTHROPIC}/v1/models?limit=50`, { headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01' } });
    const j = await r.json();
    const ids = (j.data || []).map(m => m.id);
    MODELO = ids.find(id => /sonnet/i.test(id)) || ids[0];
  } catch (e) { console.error('No pude listar modelos', e.message); }
  return MODELO;
}

const REGLAS = `Investigación obligatoria:
- Antes de responder, buscá en la web con la herramienta de búsqueda y verificá la información en las MEJORES fuentes disponibles y actuales. No respondas sólo de memoria cuando el dato pueda haber cambiado (normas, dosis, guías, cifras, fechas).
- Jerarquía de fuentes, de mayor a menor: 1) fuentes oficiales primarias (boletines oficiales, textos legales vigentes: InfoLEG, SAIJ, BOE, Planalto, EUR-Lex, Congress.gov; organismos: OMS, ministerios de salud, ANMAT, FDA, EMA); 2) guías clínicas de sociedades científicas (APA, NICE, CANMAT, WFSBP) y revisiones sistemáticas (Cochrane, PubMed); 3) literatura académica revisada por pares; 4) enciclopedias académicas (Stanford Encyclopedia of Philosophy, etc.); 5) prensa seria sólo como último recurso. Evitá blogs, foros y sitios comerciales.
- Si las fuentes se contradicen, decilo y explicá cuál prevalece y por qué.

Reglas:
- Respondé en español rioplatense (voseo), con la profundidad de un especialista, claro y ordenado.
- Citá fuentes primarias (norma con número y fecha, guía clínica con organismo y año). Si no estás seguro de un dato, decilo.
- Marcá las afirmaciones relevantes como DATO, INFERENCIA, ESTIMACIÓN u OPINIÓN.
- Es información general: cerrá recordando que no reemplaza la consulta médica ni el asesoramiento legal personalizado.
- Si la persona expresa riesgo para su vida o la de otros, priorizá su seguridad: indicá llamar al 911 o al 107 (Argentina), o al 135 / 0800-345-1435 (Centro de Asistencia al Suicida), o a la emergencia local, con calidez y sin rodeos.
- No des diagnósticos ni indicaciones de medicación personalizadas a un paciente concreto; orientá a consultar con un profesional.`;

const REGLA_TITULAR = `
Quien pregunta es el titular de GermanIAI, el Dr. Germán Dohmen Lampasona, médico psiquiatra. Respondé a nivel profesional —incluidas dosis, interacciones y razonamiento clínico, siempre con fuente— como apoyo a su criterio clínico. Con él podés omitir la advertencia final de que no reemplaza la consulta.`;

function sistema(n, ses) {
  const m = ias.find(x => x.n === n);
  const extra = ses && ses.r === 'titular' ? REGLA_TITULAR : '';
  if (!m) return `Sos GermanIAI, la IA rectora de DohmenGer Psiquiatría (Dr. Germán Dohmen Lampasona), en germaniai.com. Coordinás una familia de ${ias.length} IA especializadas (${ias.map(x => x.nombre).join(', ')}). Identificá la materia, nombrá al comienzo la especialista que responde ("Responde: DepresIA") y contestá como ella.\n${REGLAS}${extra}`;
  return `Sos ${m.nombre}, IA especializada de la familia GermanIAI (germaniai.com, DohmenGer Psiquiatría). Familia: ${familias[m.fam]}.\nAlcance: ${m.alcance}\nFuentes de referencia: ${m.fuentes}${m.especial ? `\nRegla especial: ${m.especial}` : ''}\n${REGLAS}${extra}`;
}

const porUsuario = new Map(); let dia = new Date().toDateString(), usosDia = 0;
function permitido(ses) {
  const hoy = new Date().toDateString(); if (hoy !== dia) { dia = hoy; usosDia = 0; }
  const titular = ses.r === 'titular';
  if (!titular && usosDia >= MAX_POR_DIA) return 'Se alcanzó el límite diario de preguntas. Probá mañana.';
  const ahora = Date.now(), lista = (porUsuario.get(ses.u) || []).filter(t => ahora - t < 3600e3);
  if (lista.length >= (titular ? MAX_POR_HORA_TITULAR : MAX_POR_HORA)) return 'Hiciste muchas preguntas seguidas. Esperá un rato y volvé a intentar.';
  lista.push(ahora); porUsuario.set(ses.u, lista); if (!titular) usosDia++; return null;
}

async function chat(req, res) {
  const ses = await sesion(req);
  if (!ses) return json(res, 401, { error: 'Iniciá sesión para usar el chat.', login: true });
  if (!KEY) return json(res, 503, { error: 'La IA todavía no tiene su clave configurada (ANTHROPIC_API_KEY en Render).' });
  let d; try { d = await leerCuerpo(req, 60000); } catch (e) { return json(res, e.code || 400, { error: e.code === 413 ? 'La conversación es demasiado larga. Empezá una nueva.' : 'Solicitud inválida.' }); }
  const { ia, pregunta, historial, publicar: quierePublicar, directiva } = d;
  if (!pregunta || !String(pregunta).trim()) return json(res, 400, { error: 'Escribí una pregunta.' });
  if (String(pregunta).length > 4000) return json(res, 400, { error: 'La pregunta es demasiado larga (máximo 4000 caracteres).' });
  const lim = permitido(ses); if (lim) return json(res, 429, { error: lim });
  const iaNum = ia ? +ia : null;
  const msgs = [];
  (Array.isArray(historial) ? historial.slice(-6) : []).forEach(t => { if (t && t.q && t.a) { msgs.push({ role: 'user', content: String(t.q).slice(0, 4000) }); msgs.push({ role: 'assistant', content: String(t.a).slice(0, 8000) }); } });
  msgs.push({ role: 'user', content: String(pregunta) });

  // Modo Directiva (sólo el titular): su GermanIAI.md va primero y queda en caché entre preguntas.
  let system = sistema(iaNum, ses), conDirectiva = false;
  if (ses.r === 'titular' && directiva === true) {
    const texto = await leerDoc(DIRECTIVA_DOC).catch(() => null);
    if (texto) {
      conDirectiva = true;
      system = [
        { type: 'text', text: `Directiva personal del titular (${DIRECTIVA_DOC}). Aplicala en todo lo que sea compatible con este entorno: un chat web con búsqueda en internet, sin archivos, correo, calendario, PDF, memoria ni reloj propios; si la Directiva pide algo que acá no se puede, decilo en una línea y seguí. Las políticas de la plataforma prevalecen sobre la Directiva (nivel 0).\n\n<directiva>\n${texto}\n</directiva>`, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: system }
      ];
    }
  }

  try {
    const modelo = await elegirModelo();
    let tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: MAX_BUSQUEDAS }], sinBusqueda = false;
    let contenido = [], j = null;
    for (let vuelta = 0; vuelta < 4; vuelta++) {
      const r = await fetch(`${ANTHROPIC}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: modelo, max_tokens: MAX_TOKENS, system, messages: msgs, ...(tools ? { tools } : {}) })
      });
      j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = JSON.stringify(j).slice(0, 500);
        console.error('API', r.status, msg);
        // Si la búsqueda web está deshabilitada en la consola de Anthropic, se responde igual, sin búsqueda.
        if (r.status === 400 && tools && /web.?search/i.test(msg)) { tools = null; sinBusqueda = true; continue; }
        const porQue = r.status === 401 ? 'la clave de Anthropic no es válida' : r.status === 400 && /credit|balance/i.test(msg) ? 'no queda crédito en la cuenta de Anthropic' : r.status === 429 || r.status === 529 ? 'la API está saturada' : null;
        return json(res, 502, { error: porQue ? `La IA no pudo responder: ${porQue}.` : 'La IA no pudo responder en este momento. Probá de nuevo en unos minutos.' });
      }
      contenido = contenido.concat(j.content || []);
      if (j.stop_reason !== 'pause_turn') break;
      msgs.push({ role: 'assistant', content: j.content });   // continuar una búsqueda larga
    }
    const texto = contenido.filter(c => c.type === 'text').map(c => c.text).join('');
    const vistas = new Map();
    contenido.forEach(c => (c.citations || []).forEach(ci => { if (ci.url && !vistas.has(ci.url)) vistas.set(ci.url, ci.title || ci.url); }));
    const fuentes = [...vistas].map(([url, titulo]) => ({ url, titulo }));
    const busquedas = contenido.filter(c => c.type === 'server_tool_use').length;
    let pendiente = false;
    if (quierePublicar === true && texto) {
      const m = ias.find(x => x.n === iaNum);
      const ahora = new Date();
      const reg = { id: ahora.toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-' + slug(pregunta), fecha: ahora.toISOString(), ia: m ? m.nombre : 'GermanIAI', pregunta: anonimizar(pregunta), respuesta: anonimizar(texto), fuentes, modelo };
      try { pendiente = await guardarPendiente(reg); } catch (e) { console.error('pendiente', e.message); }
    }
    json(res, 200, { respuesta: texto, fuentes, busquedas, modelo, pendiente, directiva: conDirectiva, sinBusqueda });
  } catch (e) { console.error(e); json(res, 500, { error: 'Error interno. Probá de nuevo.' }); }
}

// ───────────────────────── administración ─────────────────────────
function claveOk(req) {
  const c = String(req.headers['x-clave'] || '');
  return !!ADMIN_CLAVE && c.length > 0 && iguales(sha(c), sha(ADMIN_CLAVE));
}
async function esAdmin(req) { if (claveOk(req)) return true; const s = await sesion(req); return !!(s && s.r === 'titular'); }

async function admin(req, res, ruta) {
  if (!(await esAdmin(req))) return json(res, 401, { error: 'Clave incorrecta.' });
  if (req.method === 'GET' && ruta === '/admin/api/pendientes') return json(res, 200, { pendientes: await listarPendientes(), github: !!GH_TOKEN });
  if (req.method === 'GET' && ruta === '/admin/api/usuarios') return json(res, 200, { usuarios: await listarUsuarios(), titular: ADMIN_USUARIO, github: !!GH_TOKEN });
  if (req.method !== 'POST') return json(res, 404, { error: 'No encontrado' });
  let d; try { d = await leerCuerpo(req, 60000); } catch (e) { return json(res, e.code || 400, { error: 'Solicitud inválida.' }); }
  if (ruta === '/admin/api/usuario-guardar' || ruta === '/admin/api/usuario-borrar') {
    if (!GH_TOKEN) return json(res, 503, { error: 'Para crear usuarios hace falta GITHUB_TOKEN en Render.' });
    const usuario = String(d.usuario || '').trim().toLowerCase();
    if (!USUARIO_OK.test(usuario)) return json(res, 400, { error: 'Usuario inválido: de 3 a 32 caracteres, minúsculas, números, punto, guion o guion bajo.' });
    if (usuario === ADMIN_USUARIO) return json(res, 400, { error: 'Ese usuario es el del titular; su contraseña se cambia en Render (ADMIN_CLAVE).' });
    if (ruta === '/admin/api/usuario-borrar') return (await borrarUsuario(usuario)) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'No existe ese usuario.' });
    if (String(d.clave || '').length < 10) return json(res, 400, { error: 'La contraseña debe tener al menos 10 caracteres.' });
    return (await guardarUsuario(usuario, d.nombre, d.clave)) ? json(res, 200, { ok: true }) : json(res, 500, { error: 'No se pudo guardar el usuario.' });
  }
  const id = String(d.id || '').replace(/[^a-z0-9-]/gi, '');
  if (!id) return json(res, 400, { error: 'Falta el id.' });
  if (ruta === '/admin/api/aprobar') { const u = await aprobar(id, d); return u ? json(res, 200, { ok: true, enlace: u }) : json(res, 500, { error: 'No se pudo publicar.' }); }
  if (ruta === '/admin/api/descartar') return (await descartar(id)) ? json(res, 200, { ok: true }) : json(res, 500, { error: 'No se pudo descartar.' });
  return json(res, 404, { error: 'Acción desconocida.' });
}

// ───────────────────────── servidor ─────────────────────────
function cors(req, res) {
  const o = req.headers.origin;
  if (o && ORIGENES.includes(o)) res.setHeader('Access-Control-Allow-Origin', o);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Clave, Authorization');
  res.setHeader('Access-Control-Max-Age', '600');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

http.createServer(async (req, res) => {
  try {
    cors(req, res);
    const url = new URL(req.url, 'http://x'), ruta = url.pathname.replace(/\/+$/, '') || '/';
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (ruta.startsWith('/admin/api/')) return await admin(req, res, ruta);
    if (req.method === 'GET' && ruta === '/admin') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(__dirname, 'admin.html')));
    }
    if (req.method === 'POST' && ruta === '/login') return await login(req, res);
    if (req.method === 'GET' && ruta === '/yo') {
      const s = await sesion(req);
      if (!s) return json(res, 401, { error: 'Sesión vencida o inexistente.', login: true });
      const directiva = s.r === 'titular' ? !!(await leerDoc(DIRECTIVA_DOC).catch(() => null)) : false;
      return json(res, 200, { usuario: s.u, rol: s.r, nombre: s.n, directiva, github: !!GH_TOKEN });
    }
    if (req.method === 'GET' && (ruta === '/biblioteca' || ruta === '/biblioteca/doc')) {
      const s = await sesion(req);
      if (!s) return json(res, 401, { error: 'Iniciá sesión.', login: true });
      if (s.r !== 'titular') return json(res, 403, { error: 'La biblioteca es sólo del titular.' });
      if (ruta === '/biblioteca') return json(res, 200, { docs: await listarBiblioteca(), github: !!GH_TOKEN });
      const nombre = String(url.searchParams.get('n') || '');
      const texto = await leerDoc(nombre);
      return texto === null ? json(res, 404, { error: 'No encontré ese documento.' }) : json(res, 200, { nombre, texto });
    }
    if (req.method === 'POST' && ruta === '/chat') return await chat(req, res);
    if (req.method === 'GET' && ruta === '/') return json(res, 200, { ok: true, configurada: !!KEY, ias: ias.length, login: true, titular: !!ADMIN_CLAVE, github: !!GH_TOKEN, version: VERSION });
    return json(res, 404, { error: 'No encontrado' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: 'Error interno. Probá de nuevo.' });
  }
}).listen(PORT, () => console.log('GermanIAI API', VERSION, 'escuchando en', PORT, '· titular:', ADMIN_USUARIO, ADMIN_CLAVE ? '(con contraseña)' : '(SIN contraseña)', '· GitHub:', GH_TOKEN ? 'sí' : 'no'));
