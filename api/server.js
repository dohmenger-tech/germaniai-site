// GermanIAI API — responde preguntas con las IA de la familia GermanIAI.
// Requiere la variable de entorno ANTHROPIC_API_KEY (se carga en Render, nunca en el código).
const http = require('http');
const { ias, familias } = require('./catalogo.json');

const PORT = process.env.PORT || 10000;
const KEY = process.env.ANTHROPIC_API_KEY;
const MAX_POR_HORA = +process.env.MAX_POR_HORA || 15;      // preguntas por IP por hora
const MAX_POR_DIA = +process.env.MAX_POR_DIA || 300;        // tope global diario (control de costo)
const MAX_TOKENS = +process.env.MAX_TOKENS || 2500;
const MAX_BUSQUEDAS = +process.env.MAX_BUSQUEDAS || 5;      // búsquedas web por pregunta
const ORIGENES = (process.env.ORIGENES || 'https://germaniai.com,http://germaniai.com,https://www.germaniai.com,http://www.germaniai.com,https://dohmenger-tech.github.io').split(',');

const GH_TOKEN = process.env.GITHUB_TOKEN;                   // token de GitHub con acceso sólo a los dos repositorios
const GH_PUBLICO = process.env.GITHUB_REPO || 'dohmenger-tech/germaniai-site';        // archivo público (lo aprobado)
const GH_PRIVADO = process.env.GITHUB_PRIVADO || 'dohmenger-tech/germaniai-pendientes'; // repositorio PRIVADO (pendientes de revisión)
const ADMIN_CLAVE = process.env.ADMIN_CLAVE;                 // contraseña del panel de revisión

// Primer filtro automático (la revisión humana es la que decide): quita correos, teléfonos, DNI y CUIT.
function anonimizar(t) {
  return String(t)
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[correo omitido]')
    .replace(/\b\d{2}-?\d{7,8}-?\d\b/g, '[CUIT/CUIL omitido]')
    .replace(/\b\d{1,2}\.?\d{3}\.?\d{3}\b/g, '[número omitido]')
    .replace(/(\+?\d[\d\s().-]{7,}\d)/g, '[teléfono omitido]');
}
function slug(t) { return String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'consulta'; }

async function gh(metodo, repo, path, cuerpo) {
  const r = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${GH_TOKEN}`, 'User-Agent': 'germaniai-api', Accept: 'application/vnd.github+json' },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok && r.status !== 404) console.error('GitHub', metodo, path, r.status, JSON.stringify(j).slice(0, 200));
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
function claveOk(req) {
  const c = String(req.headers['x-clave'] || '');
  if (!ADMIN_CLAVE || c.length !== ADMIN_CLAVE.length) return false;
  return require('crypto').timingSafeEqual(Buffer.from(c), Buffer.from(ADMIN_CLAVE));
}

let MODELO = process.env.MODEL || null;
async function elegirModelo() {
  if (MODELO) return MODELO;
  try {
    const r = await fetch('https://api.anthropic.com/v1/models?limit=50', { headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01' } });
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

function sistema(n) {
  const m = ias.find(x => x.n === n);
  if (!m) return `Sos GermanIAI, la IA rectora de DohmenGer Psiquiatría (Dr. Germán Dohmen Lampasona), en germaniai.com. Coordinás una familia de ${ias.length} IA especializadas (${ias.map(x => x.nombre).join(', ')}). Identificá la materia, nombrá al comienzo la especialista que responde ("Responde: DepresIA") y contestá como ella.\n${REGLAS}`;
  return `Sos ${m.nombre}, IA especializada de la familia GermanIAI (germaniai.com, DohmenGer Psiquiatría). Familia: ${familias[m.fam]}.\nAlcance: ${m.alcance}\nFuentes de referencia: ${m.fuentes}${m.especial ? `\nRegla especial: ${m.especial}` : ''}\n${REGLAS}`;
}

const porIp = new Map(); let dia = new Date().toDateString(), usosDia = 0;
function permitido(ip) {
  const hoy = new Date().toDateString(); if (hoy !== dia) { dia = hoy; usosDia = 0; }
  if (usosDia >= MAX_POR_DIA) return 'Se alcanzó el límite diario de preguntas. Probá mañana.';
  const ahora = Date.now(), lista = (porIp.get(ip) || []).filter(t => ahora - t < 3600e3);
  if (lista.length >= MAX_POR_HORA) return 'Hiciste muchas preguntas seguidas. Esperá un rato y volvé a intentar.';
  lista.push(ahora); porIp.set(ip, lista); usosDia++; return null;
}

function cors(req, res) {
  const o = req.headers.origin;
  if (o && ORIGENES.includes(o)) res.setHeader('Access-Control-Allow-Origin', o);
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Clave');
}
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }

http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.method === 'GET' && req.url.startsWith('/admin/api/pendientes')) {
    if (!claveOk(req)) return json(res, 401, { error: 'Clave incorrecta.' });
    return json(res, 200, { pendientes: await listarPendientes() });
  }
  if (req.method === 'GET' && req.url.startsWith('/admin')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex' });
    return res.end(require('fs').readFileSync(__dirname + '/admin.html'));
  }
  if (req.method === 'POST' && req.url.startsWith('/admin/api/')) {
    if (!claveOk(req)) return json(res, 401, { error: 'Clave incorrecta.' });
    let b = ''; req.on('data', c => { b += c; if (b.length > 60000) req.destroy(); });
    return req.on('end', async () => {
      try {
        const d = JSON.parse(b || '{}'); const id = String(d.id || '').replace(/[^a-z0-9-]/gi, '');
        if (!id) return json(res, 400, { error: 'Falta el id.' });
        if (req.url.startsWith('/admin/api/aprobar')) { const u = await aprobar(id, d); return u ? json(res, 200, { ok: true, enlace: u }) : json(res, 500, { error: 'No se pudo publicar.' }); }
        if (req.url.startsWith('/admin/api/descartar')) return (await descartar(id)) ? json(res, 200, { ok: true }) : json(res, 500, { error: 'No se pudo descartar.' });
        json(res, 404, { error: 'Acción desconocida.' });
      } catch (e) { console.error(e); json(res, 500, { error: 'Error interno.' }); }
    });
  }
  if (req.method === 'GET') return json(res, 200, { ok: true, configurada: !!KEY, ias: ias.length });
  if (req.method !== 'POST' || !req.url.startsWith('/chat')) return json(res, 404, { error: 'No encontrado' });
  let body = ''; req.on('data', c => { body += c; if (body.length > 20000) req.destroy(); });
  req.on('end', async () => {
    try {
      if (!KEY) return json(res, 503, { error: 'La IA todavía no tiene su clave configurada.' });
      const { ia, pregunta, historial, publicar: quierePublicar } = JSON.parse(body || '{}');
      if (!pregunta || !String(pregunta).trim()) return json(res, 400, { error: 'Escribí una pregunta.' });
      if (String(pregunta).length > 4000) return json(res, 400, { error: 'La pregunta es demasiado larga (máximo 4000 caracteres).' });
      const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      const lim = permitido(ip); if (lim) return json(res, 429, { error: lim });
      const msgs = [];
      (Array.isArray(historial) ? historial.slice(-6) : []).forEach(t => { if (t && t.q && t.a) { msgs.push({ role: 'user', content: String(t.q).slice(0, 4000) }); msgs.push({ role: 'assistant', content: String(t.a).slice(0, 8000) }); } });
      msgs.push({ role: 'user', content: String(pregunta) });
      const modelo = await elegirModelo();
      const tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: MAX_BUSQUEDAS }];
      let contenido = [], j = null;
      for (let vuelta = 0; vuelta < 3; vuelta++) {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({ model: modelo, max_tokens: MAX_TOKENS, system: sistema(ia ? +ia : null), messages: msgs, tools })
        });
        j = await r.json();
        if (!r.ok) { console.error('API', r.status, JSON.stringify(j).slice(0, 500)); return json(res, 502, { error: 'La IA no pudo responder en este momento. Probá de nuevo en unos minutos.' }); }
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
        const m = ias.find(x => x.n === (ia ? +ia : null));
        const ahora = new Date();
        const reg = { id: ahora.toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-' + slug(pregunta), fecha: ahora.toISOString(), ia: m ? m.nombre : 'GermanIAI', pregunta: anonimizar(pregunta), respuesta: anonimizar(texto), fuentes, modelo };
        try { pendiente = await guardarPendiente(reg); } catch (e) { console.error('pendiente', e.message); }
      }
      json(res, 200, { respuesta: texto, fuentes, busquedas, modelo, pendiente });
    } catch (e) { console.error(e); json(res, 500, { error: 'Error interno. Probá de nuevo.' }); }
  });
}).listen(PORT, () => console.log('GermanIAI API escuchando en', PORT));
