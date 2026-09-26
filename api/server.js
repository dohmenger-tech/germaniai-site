// GermanIAI API — responde con la familia de IA, investiga en la web, guarda en Supabase
// y envía a Germán un correo para aprobar o descartar cada publicación.
// Variables de entorno (se cargan en Render, nunca en el código):
//   ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_ANON (pública), SUPABASE_SERVICE_KEY, FIRMA_SECRETA,
//   GMAIL_USUARIO (dohmenger@gmail.com), GMAIL_CLAVE_APP (contraseña de aplicación de Google)
const http = require('http');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { ias, familias } = require('./catalogo.json');

const E = process.env;
const PORT = E.PORT || 10000;
const ADMIN = 'dohmenger@gmail.com';
const MAX_POR_HORA = +E.MAX_POR_HORA || 15;
const MAX_POR_DIA = +E.MAX_POR_DIA || 300;
const MAX_TOKENS = +E.MAX_TOKENS || 2500;
const MAX_BUSQUEDAS = +E.MAX_BUSQUEDAS || 5;
const API_PUBLICA = E.API_PUBLICA || 'https://api.germaniai.com';
const ORIGENES = (E.ORIGENES || 'https://germaniai.com,https://www.germaniai.com,http://germaniai.com').split(',');

// ---------- utilidades ----------
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }
function html(res, code, cuerpo) { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex' }); res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GermanIAI</title><body style="font-family:system-ui;max-width:680px;margin:40px auto;padding:0 16px;line-height:1.5">${cuerpo}</body>`); }
function leerCuerpo(req, max = 20000) { return new Promise((ok, mal) => { let b = ''; req.on('data', c => { b += c; if (b.length > max) { mal(new Error('grande')); req.destroy(); } }); req.on('end', () => ok(b)); }); }
function firmar(id, accion) { return crypto.createHmac('sha256', E.FIRMA_SECRETA || 'x').update(id + ':' + accion).digest('hex').slice(0, 32); }
function firmaOk(id, accion, t) { const f = firmar(id, accion); return t && t.length === f.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(f)); }
// Primer filtro automático de datos personales (la revisión humana decide)
function anonimizar(t) {
  return String(t)
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[correo omitido]')
    .replace(/\b\d{2}-?\d{7,8}-?\d\b/g, '[CUIT/CUIL omitido]')
    .replace(/\b\d{1,2}\.?\d{3}\.?\d{3}\b/g, '[número omitido]')
    .replace(/(\+?\d[\d\s().-]{7,}\d)/g, '[teléfono omitido]');
}

// ---------- Supabase (REST con clave de servicio: sólo en el servidor) ----------
async function sb(metodo, ruta, cuerpo, extra = {}) {
  const r = await fetch(`${E.SUPABASE_URL}/rest/v1/${ruta}`, {
    method: metodo,
    headers: { apikey: E.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${E.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...extra },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error('Supabase ' + r.status + ' ' + JSON.stringify(j).slice(0, 200));
  return j;
}
async function usuarioDeToken(req) {
  const a = req.headers.authorization || '';
  if (!a.startsWith('Bearer ') || !E.SUPABASE_URL) return null;
  const r = await fetch(`${E.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: E.SUPABASE_SERVICE_KEY, Authorization: a } });
  return r.ok ? r.json() : null;
}

// ---------- correo ----------
const correo = (E.GMAIL_USUARIO && E.GMAIL_CLAVE_APP) ? nodemailer.createTransport({ service: 'gmail', auth: { user: E.GMAIL_USUARIO, pass: E.GMAIL_CLAVE_APP } }) : null;
async function avisarAprobacion(inv) {
  if (!correo) return;
  const ap = `${API_PUBLICA}/revisar?id=${inv.id}&accion=aprobar&t=${firmar(inv.id, 'aprobar')}`;
  const de = `${API_PUBLICA}/revisar?id=${inv.id}&accion=descartar&t=${firmar(inv.id, 'descartar')}`;
  const fuentes = (inv.fuentes || []).map(f => `<li><a href="${esc(f.url)}">${esc(f.titulo)}</a></li>`).join('');
  await correo.sendMail({
    from: `GermanIAI <${E.GMAIL_USUARIO}>`, to: ADMIN,
    subject: `[GermanIAI · revisar] ${inv.ia} — ${inv.pregunta.slice(0, 70)}`,
    html: `<div style="font-family:Arial;max-width:720px"><p><b>Nueva investigación para revisar</b> · ${esc(inv.ia)} · ${esc(inv.familia || '')} / ${esc(inv.tema || '')}</p>
<p><b>Pregunta:</b><br>${esc(inv.pregunta)}</p><p><b>Respuesta:</b></p><div style="white-space:pre-wrap;border-left:3px solid #1B5E7A;padding-left:10px">${esc(inv.respuesta)}</div>
<p><b>Fuentes:</b></p><ol>${fuentes}</ol>
<p><a href="${ap}" style="background:#2E9C7C;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">APROBAR Y PUBLICAR</a> &nbsp; <a href="${de}" style="background:#E8603F;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">DESCARTAR</a></p>
<p style="color:#666;font-size:12px">También podés corregirla antes de publicar en https://germaniai.com/panel.html</p></div>`
  });
}

// ---------- IA ----------
let MODELO = E.MODEL || null;
async function elegirModelo() {
  if (MODELO) return MODELO;
  try {
    const r = await fetch('https://api.anthropic.com/v1/models?limit=50', { headers: { 'x-api-key': E.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' } });
    const ids = ((await r.json()).data || []).map(m => m.id);
    MODELO = ids.find(id => /sonnet/i.test(id)) || ids[0];
  } catch (e) { console.error('modelos', e.message); }
  return MODELO;
}
const REGLAS = `Investigación obligatoria:
- Antes de responder, buscá en la web y verificá en las MEJORES fuentes disponibles y actuales. No respondas sólo de memoria cuando el dato pueda haber cambiado.
- Jerarquía de fuentes: 1) oficiales primarias (boletines oficiales y textos legales vigentes: InfoLEG, SAIJ, BOE, Planalto, EUR-Lex, Congress.gov; OMS, ministerios de salud, ANMAT, FDA, EMA); 2) guías clínicas de sociedades científicas (APA, NICE, CANMAT, WFSBP) y revisiones sistemáticas (Cochrane, PubMed); 3) literatura académica revisada por pares; 4) enciclopedias académicas; 5) prensa seria sólo como último recurso. Evitá blogs, foros y sitios comerciales.
- Si las fuentes se contradicen, decilo y explicá cuál prevalece.
Reglas:
- Español rioplatense (voseo), profundidad de especialista, claro y ordenado.
- Marcá las afirmaciones relevantes como DATO, INFERENCIA, ESTIMACIÓN u OPINIÓN.
- Información general: cerrá recordando que no reemplaza la consulta médica ni el asesoramiento legal personalizado. No des diagnósticos ni indicaciones de medicación personalizadas.
- Si la persona expresa riesgo para su vida o la de otros, priorizá su seguridad: 911 o 107 (Argentina), 135 / 0800-345-1435 (Centro de Asistencia al Suicida) o la emergencia local.
- Última línea, sola y exacta: TEMA: <tema en 1 a 4 palabras>`;
function sistema(n) {
  const m = ias.find(x => x.n === n);
  if (!m) return `Sos GermanIAI, la IA rectora de DohmenGer (germaniai.com). Coordinás ${ias.length} IA especializadas (${ias.map(x => x.nombre).join(', ')}). Identificá la materia, escribí al comienzo "Responde: <nombre de la IA>" y contestá como ella.\n${REGLAS}`;
  return `Sos ${m.nombre}, IA especializada de la familia GermanIAI (germaniai.com). Familia: ${familias[m.fam]}.\nAlcance: ${m.alcance}\nFuentes de referencia: ${m.fuentes}${m.especial ? `\nRegla especial: ${m.especial}` : ''}\n${REGLAS}`;
}

const porIp = new Map(); let dia = new Date().toDateString(), usosDia = 0;
function permitido(ip) {
  const hoy = new Date().toDateString(); if (hoy !== dia) { dia = hoy; usosDia = 0; }
  if (usosDia >= MAX_POR_DIA) return 'Se alcanzó el límite diario de preguntas. Probá mañana.';
  const ahora = Date.now(), l = (porIp.get(ip) || []).filter(t => ahora - t < 3600e3);
  if (l.length >= MAX_POR_HORA) return 'Hiciste muchas preguntas seguidas. Esperá un rato.';
  l.push(ahora); porIp.set(ip, l); usosDia++; return null;
}

async function responder(req, res) {
  if (!E.ANTHROPIC_API_KEY) return json(res, 503, { error: 'La IA todavía no está configurada.' });
  const { ia, pregunta, historial, publicar } = JSON.parse(await leerCuerpo(req) || '{}');
  if (!pregunta || !String(pregunta).trim()) return json(res, 400, { error: 'Escribí una pregunta.' });
  if (String(pregunta).length > 4000) return json(res, 400, { error: 'Máximo 4000 caracteres.' });
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const lim = permitido(ip); if (lim) return json(res, 429, { error: lim });
  const usuario = await usuarioDeToken(req).catch(() => null);

  const msgs = [];
  (Array.isArray(historial) ? historial.slice(-6) : []).forEach(t => { if (t?.q && t?.a) { msgs.push({ role: 'user', content: String(t.q).slice(0, 4000) }); msgs.push({ role: 'assistant', content: String(t.a).slice(0, 8000) }); } });
  msgs.push({ role: 'user', content: String(pregunta) });
  const modelo = await elegirModelo();
  const tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: MAX_BUSQUEDAS }];
  let contenido = [];
  for (let v = 0; v < 3; v++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': E.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: modelo, max_tokens: MAX_TOKENS, system: sistema(ia ? +ia : null), messages: msgs, tools })
    });
    const j = await r.json();
    if (!r.ok) { console.error('API', r.status, JSON.stringify(j).slice(0, 300)); return json(res, 502, { error: 'La IA no pudo responder ahora. Probá en unos minutos.' }); }
    contenido = contenido.concat(j.content || []);
    if (j.stop_reason !== 'pause_turn') break;
    msgs.push({ role: 'assistant', content: j.content });
  }
  let texto = contenido.filter(c => c.type === 'text').map(c => c.text).join('');
  let tema = null; const mt = texto.match(/\n?TEMA:\s*(.+)\s*$/i); if (mt) { tema = mt[1].trim().slice(0, 60); texto = texto.slice(0, mt.index).trim(); }
  const vistas = new Map();
  contenido.forEach(c => (c.citations || []).forEach(ci => { if (ci.url && !vistas.has(ci.url)) vistas.set(ci.url, ci.title || ci.url); }));
  const fuentes = [...vistas].map(([url, titulo]) => ({ url, titulo }));
  const busquedas = contenido.filter(c => c.type === 'server_tool_use').length;
  const m = ias.find(x => x.n === (ia ? +ia : null));
  const iaNombre = m ? m.nombre : ((texto.match(/Responde:\s*([^\s\n.]+)/) || [])[1] || 'GermanIAI');
  const fam = m ? familias[m.fam] : (ias.find(x => x.nombre === iaNombre) ? familias[ias.find(x => x.nombre === iaNombre).fam] : null);

  let guardada = null, pendiente = false;
  if (E.SUPABASE_URL) {
    try {
      const quiere = publicar === true;
      const [inv] = await sb('POST', 'investigaciones', {
        usuario_id: usuario?.id || null, ia: iaNombre, familia: fam, tema,
        pregunta: quiere ? anonimizar(pregunta) : String(pregunta), respuesta: quiere ? anonimizar(texto) : texto,
        fuentes, busquedas, modelo, autoriza_publicar: quiere, estado: quiere ? 'pendiente' : 'privada'
      });
      guardada = inv.id;
      if (quiere) { pendiente = true; avisarAprobacion(inv).catch(e => console.error('correo', e.message)); }
    } catch (e) { console.error('guardar', e.message); }
  }
  json(res, 200, { respuesta: texto, fuentes, busquedas, tema, ia: iaNombre, pendiente, id: guardada });
}

async function cambiarEstado(id, accion, cambios = {}) {
  const estado = accion === 'aprobar' ? 'aprobada' : 'descartada';
  const cuerpo = { estado, revisada_at: new Date().toISOString() };
  if (cambios.pregunta) cuerpo.pregunta = String(cambios.pregunta).slice(0, 4000);
  if (cambios.respuesta) cuerpo.respuesta = String(cambios.respuesta).slice(0, 30000);
  if (cambios.tema) cuerpo.tema = String(cambios.tema).slice(0, 60);
  const r = await sb('PATCH', `investigaciones?id=eq.${encodeURIComponent(id)}&estado=eq.pendiente`, cuerpo);
  return Array.isArray(r) && r.length > 0;
}

// ---------- servidor ----------
http.createServer(async (req, res) => {
  const o = req.headers.origin;
  if (o && ORIGENES.includes(o)) res.setHeader('Access-Control-Allow-Origin', o);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'POST' && url.pathname === '/chat') return await responder(req, res);

    // Enlaces del correo: GET muestra confirmación (los escáneres de correo no aprueban solos); POST ejecuta.
    if (url.pathname === '/revisar') {
      const id = url.searchParams.get('id') || '', accion = url.searchParams.get('accion'), t = url.searchParams.get('t');
      if (!/^[0-9a-f-]{36}$/.test(id) || !['aprobar', 'descartar'].includes(accion) || !firmaOk(id, accion, t)) return html(res, 403, '<h2>Enlace inválido o vencido.</h2>');
      if (req.method === 'GET') return html(res, 200, `<h2>¿Confirmás ${accion === 'aprobar' ? 'APROBAR Y PUBLICAR' : 'DESCARTAR'} esta investigación?</h2><form method="post"><button style="font-size:18px;padding:12px 22px;border:0;border-radius:10px;color:#fff;background:${accion === 'aprobar' ? '#2E9C7C' : '#E8603F'}">Confirmar</button></form><p><a href="https://germaniai.com/panel.html">O revisala y corregila en el panel</a></p>`);
      const ok = await cambiarEstado(id, accion);
      return html(res, 200, ok ? (accion === 'aprobar' ? '<h2>Publicada.</h2><p><a href="https://germaniai.com/libro.html">Ver en el libro</a></p>' : '<h2>Descartada.</h2>') : '<h2>Ya estaba revisada.</h2>');
    }

    // Panel: sólo con sesión de dohmenger@gmail.com
    if (req.method === 'POST' && url.pathname === '/panel/revisar') {
      const u = await usuarioDeToken(req);
      if (!u || (u.email || '').toLowerCase() !== ADMIN) return json(res, 403, { error: 'Sólo el administrador.' });
      const d = JSON.parse(await leerCuerpo(req, 60000) || '{}');
      if (!/^[0-9a-f-]{36}$/.test(d.id || '') || !['aprobar', 'descartar'].includes(d.accion)) return json(res, 400, { error: 'Datos inválidos.' });
      return json(res, 200, { ok: await cambiarEstado(d.id, d.accion, d) });
    }

    if (req.method === 'GET' && url.pathname === '/config') return json(res, 200, { url: E.SUPABASE_URL || '', anon: E.SUPABASE_ANON || '' });
    if (req.method === 'GET') return json(res, 200, { ok: true, ia: !!E.ANTHROPIC_API_KEY, base: !!E.SUPABASE_URL, correo: !!correo, ias: ias.length });
    json(res, 404, { error: 'No encontrado' });
  } catch (e) { console.error(e); json(res, 500, { error: 'Error interno. Probá de nuevo.' }); }
}).listen(PORT, () => console.log('GermanIAI API en', PORT));
