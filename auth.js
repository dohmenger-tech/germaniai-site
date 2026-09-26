// Sesión compartida por todas las páginas de germaniai.com
(function () {
  const C = window.GIA || {};
  let sb = null;
  // La URL y la clave pública de Supabase las entrega el servidor (así todo se configura en un solo lugar: Render)
  const ready = (async () => {
    try {
      if (!(C.SUPABASE_URL && C.SUPABASE_ANON)) { const r = await fetch(C.API + '/config'); const j = await r.json(); C.SUPABASE_URL = j.url; C.SUPABASE_ANON = j.anon; }
      if (C.SUPABASE_URL && C.SUPABASE_ANON && window.supabase) { sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON); sb.auth.onAuthStateChange(() => pintarBarra()); }
    } catch (e) { }
    window.GIAauth.sb = sb;
  })();
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  async function sesion() { await ready; if (!sb) return null; const { data } = await sb.auth.getSession(); return data.session; }
  async function token() { const s = await sesion(); return s ? s.access_token : null; }
  async function entrar(proveedor) {
    await ready;
    if (!sb) return alertaBarra('El ingreso se habilita en cuanto termine la configuración.');
    await sb.auth.signInWithOAuth({ provider: proveedor, options: { redirectTo: location.origin + location.pathname } });
  }
  async function entrarEmail(email) {
    await ready;
    if (!sb) return alertaBarra('El ingreso se habilita en cuanto termine la configuración.');
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
    alertaBarra(error ? 'No se pudo enviar el enlace: ' + error.message : 'Te enviamos un enlace de ingreso a ' + email + '. Abrilo desde tu correo.');
  }
  async function salir() { if (sb) await sb.auth.signOut(); location.reload(); }
  function alertaBarra(t) { const a = document.getElementById('giaAviso'); if (a) { a.textContent = t; a.hidden = false; } }
  async function pintarBarra() {
    const b = document.getElementById('giaBarra'); if (!b) return;
    const s = await sesion();
    if (s) {
      const email = s.user.email || '';
      const admin = email.toLowerCase() === (C.ADMIN || '').toLowerCase();
      b.innerHTML = `<span class="gia-yo">${esc(email)}</span> <a href="cuenta.html">Mi cuenta</a>${admin ? ' <a href="panel.html"><b>Panel</b></a>' : ''} <button type="button" id="giaSalir">Salir</button>`;
      document.getElementById('giaSalir').onclick = salir;
    } else {
      b.innerHTML = `<button type="button" class="gia-g" id="giaG">Ingresar con Google</button> <button type="button" id="giaM">Microsoft / Hotmail</button> <button type="button" id="giaE">Otro correo</button>`;
      document.getElementById('giaG').onclick = () => entrar('google');
      document.getElementById('giaM').onclick = () => entrar('azure');
      document.getElementById('giaE').onclick = () => { const f = document.getElementById('giaEmailForm'); if (f) f.hidden = !f.hidden; };
      const f = document.getElementById('giaEmailForm');
      if (f) f.onsubmit = e => { e.preventDefault(); entrarEmail(document.getElementById('giaEmail').value.trim()); };
    }
  }
  window.GIAauth = { sb: null, ready, sesion, token, salir, pintarBarra, esc };
  document.addEventListener('DOMContentLoaded', pintarBarra);
})();
