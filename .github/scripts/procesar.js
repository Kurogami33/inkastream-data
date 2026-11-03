const fs = require('fs');

const CAMPOS = {
  'Tipo': 'tipo',
  'Título': 'titulo',
  'Año': 'anio',
  'ID de TMDB': 'tmdb',
  'Enlace (URL)': 'url',
  'Temporada': 'temporada',
  'Episodio': 'episodio',
  'Etiqueta (idioma/calidad)': 'etiqueta',
  'Logo del canal (URL)': 'logo',
  'Grupo del canal': 'grupo',
  'Confirmación': 'confirmacion',
};

function parsear(cuerpo) {
  const datos = {};
  for (const parte of cuerpo.split(/^### /m).slice(1)) {
    const salto = parte.indexOf('\n');
    if (salto < 0) continue;
    const clave = CAMPOS[parte.slice(0, salto).trim()];
    let valor = parte.slice(salto + 1).trim();
    if (valor === '_No response_') valor = '';
    if (clave) datos[clave] = valor;
  }
  return datos;
}

function limpiarUrl(texto) {
  let u;
  try { u = new URL(texto); } catch { return null; }
  if (!['http:', 'https:'].includes(u.protocol)) return null;
  const h = u.hostname.toLowerCase();
  if (h.startsWith('[') || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return null;
  if (/^(0|10|127)\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return null;
  return u.toString();
}

function limpiarTexto(t) {
  return String(t).replace(/[\r\n"]+/g, ' ').trim();
}

async function responde(url) {
  for (const metodo of ['HEAD', 'GET']) {
    try {
      const r = await fetch(url, {
        method: metodo,
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
        headers: { Range: 'bytes=0-1023', 'User-Agent': 'INKASTREAM-bot' },
      });
      if (r.body) r.body.cancel().catch(() => {});
      if (r.status < 400) return true;
    } catch (e) { /* intentar el siguiente método */ }
  }
  return false;
}

module.exports = async ({ context, core }) => {
  const falla = (m) => {
    core.setOutput('ok', 'false');
    core.setOutput('mensaje', '❌ ' + m);
  };
  try {
    const issue = context.payload.issue;
    const usuario = issue.user.login;
    const d = parsear(issue.body || '');
    const bloqueo = JSON.parse(fs.readFileSync('blocklist.json', 'utf8'));

    if (bloqueo.usuarios.map((x) => x.toLowerCase()).includes(usuario.toLowerCase())) {
      return falla('Tu usuario no puede enviar aportes.');
    }
    if (!/\[x\]/i.test(d.confirmacion || '')) {
      return falla('Debes confirmar que tienes derecho a compartir el enlace.');
    }
    if (!['Película', 'Serie', 'Canal'].includes(d.tipo)) return falla('Tipo no válido.');

    const titulo = limpiarTexto(d.titulo || '').slice(0, 150);
    if (!titulo) return falla('Falta el título.');

    const url = limpiarUrl(d.url || '');
    if (!url) return falla('El enlace no es válido. Debe empezar con http:// o https://');
    const host = new URL(url).hostname.toLowerCase();
    if (bloqueo.dominios.some((x) => host === x || host.endsWith('.' + x))) {
      return falla('Ese dominio no está permitido.');
    }
    if (!(await responde(url))) {
      return falla('El enlace no responde. Revisa que funcione y envía el aporte de nuevo.');
    }

    const catalogo = JSON.parse(fs.readFileSync('catalog.json', 'utf8'));
    let m3u = fs.readFileSync('channels.m3u', 'utf8');
    const repetida =
      catalogo.items.some((i) => i.sources.some((s) => s.url === url)) ||
      m3u.split('\n').includes(url);
    if (repetida) return falla('Ese enlace ya existe en INKASTREAM.');

    const hoy = new Date().toISOString().slice(0, 10);

    if (d.tipo === 'Canal') {
      let logo = '';
      if (d.logo) {
        logo = limpiarUrl(d.logo);
        if (!logo) return falla('El logo no es una URL válida.');
      }
      const grupo = limpiarTexto(d.grupo || '').slice(0, 40) || 'General';
      if (!m3u.endsWith('\n')) m3u += '\n';
      m3u += `#EXTINF:-1 tvg-logo="${logo}" group-title="${grupo}",${titulo}\n${url}\n`;
      fs.writeFileSync('channels.m3u', m3u);
    } else {
      const esSerie = d.tipo === 'Serie';
      if (!/^\d{1,9}$/.test(d.tmdb || '')) return falla('El ID de TMDB debe ser un número.');
      if (!/^\d{4}$/.test(d.anio || '')) return falla('El año debe tener 4 dígitos.');
      const tmdb = Number(d.tmdb);
      const tipo = esSerie ? 'series' : 'movie';

      const fuente = {
        url,
        label: limpiarTexto(d.etiqueta || '').slice(0, 40),
        addedBy: usuario,
        addedAt: hoy,
      };
      if (esSerie) {
        if (!/^\d{1,4}$/.test(d.temporada || '') || !/^\d{1,4}$/.test(d.episodio || '')) {
          return falla('Para series indica temporada y episodio (números).');
        }
        fuente.season = Number(d.temporada);
        fuente.episode = Number(d.episodio);
      }

      let item = catalogo.items.find((i) => i.type === tipo && i.tmdb === tmdb);
      if (!item) {
        item = { type: tipo, tmdb, title: titulo, year: Number(d.anio), sources: [] };
        catalogo.items.push(item);
      }
      item.sources.push(fuente);
      catalogo.updated = hoy;
      fs.writeFileSync('catalog.json', JSON.stringify(catalogo, null, 2) + '\n');
    }

    core.setOutput('ok', 'true');
    core.setOutput('mensaje', '✅ ¡Gracias! Tu aporte ya está en INKASTREAM y aparecerá en la app en unos minutos.');
  } catch (e) {
    core.error(String(e));
    falla('Error interno. Un mantenedor lo revisará.');
  }
};
