// WEBTOON plugin para Kino — lee www.webtoons.com (webcómic vertical oficial).
//
// Alcance: Inicio por géneros, Biblioteca, Favoritos, Historial, Buscar, detalle de
// obra con todos sus capítulos y lector vertical (tira y modo páginas), con progreso
// de lectura (capacidad "progress", apiVersion 22) y sincronía entre dispositivos
// (capacidad "shared").
//
// Cómo funciona por dentro:
// - screen() es una vista pura: solo arma el árbol desde kino.storage (JSON).
// - Nada bloquea la pantalla: cuando falta dato, la vista pone esqueletos y propone
//   una tarea en la cola; el temporizador "every" (event "tick") ejecuta UNA tarea
//   de red por ticke y luego pide un redibujado con { state: { rev } }.
// - Las imágenes de pstatic exigen cabecera Referer de webtoons.com (probado:
//   403 sin Referer, 200 con él): todo Image lleva headers.
// - El HTML de webtoons.com no es bien formado (etiquetas sin cerrar), así que el
//   scraping abre un bloque por marca de apertura y corta en su cierre.

const BASE = "https://www.webtoons.com";
const IMG_HEADERS = {
  Referer: BASE + "/",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
};
const FETCH_HEADERS = {
  "User-Agent": IMG_HEADERS["User-Agent"],
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9"
};

// Semillas de géneros (la lista real se lee de la propia página y se guarda en "gn:").
const SEMILLAS = ["drama", "fantasy", "romance", "action"];
const TODOS_SLUGS = [
  "drama", "fantasy", "romance", "action", "comedy", "slice_of_life", "thriller", "sf",
  "super_hero", "supernatural", "mystery", "sports", "historical", "adventure"
];

const TTL_SECCION = 12 * 60 * 60 * 1000; // 12 h
const TTL_DETALLE = 30 * 24 * 60 * 60 * 1000; // 30 d
const TTL_LECTURA = 6 * 60 * 60 * 1000; // 6 h
const MAX_ITEMS_SECCION = 18;
const MAX_CAPS_GUARDADOS = 150;
const MAX_FAV = 60;
const MAX_HIST = 40;
const MAX_BIB = 60;
const COOLDOWN_MS = 45000; // tras un fallo de red, no reintentar tan pronto

// ---------------------------------------------------------------------------
// Utilidades de texto y HTML
// ---------------------------------------------------------------------------

function dec(s) {
  if (s == null) return "";
  let out = String(s);
  try { out = decodeURIComponent(out); } catch (e) { /* texto crudo */ }
  return out
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d))
    .replace(/\s+/g, " ").trim();
}

function etiquetaEn(html, i) {
  let j = i + 1;
  if (j < html.length && (html[j] === "/" || html[j] === "!")) j++;
  let k = j;
  while (k < html.length && !/[\s>\/]/.test(html[k])) k++;
  return html.slice(j, k).toLowerCase();
}

// Recorre el HTML desde cada coincidencia de reApertura y pasa el texto del bloque.
function bloques(html, reApertura, cb) {
  reApertura.lastIndex = 0;
  let m;
  while ((m = reApertura.exec(html))) {
    const ini = m.index;
    const nombre = etiquetaEn(html, ini);
    const cierre = "</" + nombre + ">";
    let fin = html.indexOf(cierre, ini);
    if (fin < 0) fin = html.length; else fin += cierre.length;
    const r = cb(html.slice(ini, fin), m);
    if (r === false) break;
    reApertura.lastIndex = fin;
  }
}

function atributo(txt, nombre) {
  const m = txt.match(new RegExp("\\b" + nombre + '\\s*=\\s*"([^"]*)"', "i"));
  return m ? dec(m[1]) : "";
}

function atributoCrudo(txt, nombre) {
  const m = txt.match(new RegExp("\\b" + nombre + '\\s*=\\s*"([^"]*)"', "i"));
  return m ? m[1] : "";
}

// Texto (sin etiquetas) de la primera etiqueta que abre con reApertura dentro de txt.
function puro(txt, reApertura) {
  reApertura.lastIndex = 0;
  const m = reApertura.exec(txt);
  if (!m) return "";
  const nombre = etiquetaEn(txt, m.index);
  const cierre = "</" + nombre + ">";
  const fin = txt.indexOf(cierre, m.index);
  const bruto = txt.slice(m.index + m[0].length, fin < 0 ? txt.length : fin);
  return dec(bruto.replace(/<[^>]*>/g, " "));
}

function atrapar(fn) {
  try { return fn(); } catch (e) { return null; }
}

// ---------------------------------------------------------------------------
// Red y almacenamiento
// ---------------------------------------------------------------------------

async function get(url) {
  const r = await kino.fetch(url, { headers: FETCH_HEADERS });
  if (!r || typeof r.text !== "function" || !r.ok) {
    throw new Error("El sitio respondió " + (r ? r.status : "?") + " al abrir " + url.replace(/^https?:\/\//, "").slice(0, 60));
  }
  return r.text();
}

function sget(clave) {
  const bruto = kino.storage.get(clave);
  if (!bruto) return null;
  try { return JSON.parse(bruto); } catch (e) { return null; }
}

function sset(clave, valor, ttl) {
  const texto = JSON.stringify(valor);
  try {
    kino.storage.set(clave, texto, ttl ? { ttlMs: Math.floor(ttl) } : undefined);
    return true;
  } catch (e) {
    // Almacenamiento lleno (too_large): suelta cachés viejas y reintenta una vez.
    atrapar(() => {
      const claves = kino.storage.keys().filter((k) => k.indexOf("i:") === 0 || k.indexOf("d:") === 0 || k.indexOf("s:") === 0);
      claves.slice(0, Math.max(1, Math.ceil(claves.length / 2))).forEach((k) => atrapar(() => kino.storage.remove(k)));
    });
    try { kino.storage.set(clave, texto, ttl ? { ttlMs: Math.floor(ttl) } : undefined); return true; }
    catch (e2) { return false; }
  }
}

function sun(clave) { atrapar(() => kino.storage.remove(clave)); }

// ---------------------------------------------------------------------------
// Scraping
// ---------------------------------------------------------------------------

// Tarjeta de lista (géneros, búsqueda): href, title_no, poster, título, autor, métrica.
function parseTarjetas(html, marca) {
  const salida = [];
  const re = new RegExp('<a\\b[^>]*class="[^"]*' + marca + '[^"]*"[^>]*>', "gi");
  bloques(html, re, (bloque, m) => {
    const href = atributo(m[0], "href");
    const tno = atributo(m[0], "data-title-no") || (href.match(/title_no=(\d+)/) || [])[1] || "";
    if (!href || !tno) return;
    const tagImg = /<img\b[^>]*>/i.exec(bloque);
    const poster = tagImg ? atributoCrudo(tagImg[0], "src") : "";
    salida.push({
      titleNo: tno,
      href: href,
      poster: poster,
      title: puro(bloque, /<strong\b[^>]*class="[^"]*title[^"]*"[^>]*>/i) || dec((bloque.match(/alt="([^"]*)"/) || [])[1] || ""),
      author: puro(bloque, /<div\b[^>]*class="[^"]*author[^"]*"[^>]*>/i),
      metric: puro(bloque, /<div\b[^>]*class="[^"]*view_count[^"]*"[^>]*>/i)
    });
    if (salida.length >= 60) return false;
  });
  return salida;
}

// Los géneros del sitio (pestañas laterales), para los atajos.
function parseGeneros(html) {
  const salida = [];
  const re = /<a\b[^>]*class="[^"]*snb_tab[^"]*"[^>]*>/gi;
  bloques(html, re, (bloque, m) => {
    const href = atributo(m[0], "href");
    const slug = (href.match(/\/genres\/([a-z0-9_]+)/i) || [])[1];
    if (!slug) return;
    const label = puro(bloque, />([^<]*)$/) || slug.replace(/_/g, " ");
    if (!salida.some((x) => x.slug === slug)) salida.push({ slug: slug, label: label.toUpperCase() });
    return salida.length < 30 ? undefined : false;
  });
  return salida;
}

function parseSeccionGenero(html, genero) {
  const items = parseTarjetas(html, "_genre_title_a").slice(0, MAX_ITEMS_SECCION);
  if (!items.length) return null;
  let href = "";
  const mh = html.match(new RegExp('href="([^"]*\\/genres\\/' + genero + '[^"]*)"', "i"));
  if (mh) href = dec(mh[1]);
  let titulo = "";
  const mt = new RegExp('<a\\b[^>]*data-genre="' + genero.toUpperCase() + '"[^>]*>([\\s\\S]*?)<\\/a>', "i").exec(html);
  if (mt) titulo = dec(mt[1]);
  if (!titulo) titulo = genero.replace(/_/g, " ").toUpperCase();
  return { genero: genero, titulo: titulo, href: href, items: items, generos: parseGeneros(html) };
}

// Episodios de la página de lista (10 por página).
function parseEpisodios(html) {
  const salida = [];
  const re = /<li\b[^>]*class="[^"]*_episodeItem[^"]*"[^>]*>/gi;
  bloques(html, re, (li) => {
    const h = (li.match(/<a\b[^>]*href="([^"]+)"[^>]*>/i) || [])[1] || "";
    if (!h) return;
    const n = (li.match(/data-episode-no="(\d+)"/) || [])[1] || "";
    salida.push({
      n: n,
      p: h.replace(/&amp;/gi, "&"),   // el enlace del sitio, completo
      t: puro(li, /<span\b[^>]*class="[^"]*subj[^"]*"[^>]*>/i),
      d: puro(li, /<span\b[^>]*class="[^"]*date[^"]*"[^>]*>/i)
    });
    if (salida.length >= 40) return false;
  });
  // El sitio los lista del más reciente al más antiguo: aquí van del 1º al último.
  salida.sort((a, b) => Number(a.n) - Number(b.n));
  return salida;
}

function parsePaginaDetalle(html) {
  // Ojo: webtoons escribe a veces class=pg_page SIN comillas. El sitio solo
  // enseña diez números; si hay enlace "pg_next" es que hay más páginas.
  const re = /<a\b[^>]*class\s*=\s*["']?pg_page["']?[^>]*>([\s\S]*?)<\/a>/gi;
  let pagina = 1;
  let ultima = 1;
  let m;
  while ((m = re.exec(html))) {
    const n = parseInt(dec(m[1]).replace(/<[^>]*>/g, ""), 10);
    if (!isNaN(n) && n > ultima) ultima = n;
  }
  const cur = /aria-current="true"[^>]*>(?:<span>)?(\d+)/i.exec(html);
  if (cur) pagina = parseInt(cur[1], 10) || 1;
  const mas = /<a\b[^>]*class\s*=\s*["']?pg_next["']?/i.test(html);
  return { p: pagina, last: ultima, mas: mas };
}

// Detalle de una obra (Originales y Canvas comparten la estructura principal).
function parseDetalle(html) {
  const i = html.indexOf('id="_listUl"');
  const cab = i > 0 ? html.slice(0, i) : html;
  const titulo = puro(cab, /<h1\b[^>]*class="[^"]*subj[^"]*"[^>]*>/i) || puro(cab, /<h3\b[^>]*class="[^"]*subj[^"]*"[^>]*>/i);
  const genre = puro(cab, /<h2\b[^>]*class="[^"]*genre[^"]*"[^>]*>/i);
  let autor = "";
  const am = /<div\b[^>]*class="[^"]*author_area[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(cab);
  if (am) {
    const partes = [];
    const re = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
    let x;
    while ((x = re.exec(am[1]))) partes.push(dec(x[1]));
    const bruto = am[1].replace(/<button[\s\S]*?<\/button>/gi, " "); // quita el botón "author info"
    autor = partes.length ? partes.join(", ") : dec(bruto.replace(/<[^>]*>/g, " "));
  }
  const poster = (cab.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i) || [])[1] || "";
  return {
    titulo: titulo,
    genre: genre,
    autor: autor,
    poster: poster,
    likes: puro(cab, /<em\b[^>]*class="[^"]*cnt[^"]*"[^>]*>/i),
    summary: puro(cab, /<p\b[^>]*class="[^"]*summary[^"]*"[^>]*>/i)
  };
}

// Página del lector: imágenes de la tira, capítulos vecinos y vecinos anterior/siguiente.
function parseViewer(html) {
  const imgs = [];
  let w = 0;
  let h = 0;
  const re = /<img\b[^>]*class="[^"]*_images[^"]*"[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const u = atributoCrudo(m[0], "data-url") || atributoCrudo(m[0], "src");
    if (u && u.indexOf("http") === 0 && !/transparency|\.gif/i.test(u)) {
      if (!imgs.length) {
        w = parseInt(atributoCrudo(m[0], "width"), 10) || 0;
        h = parseInt(atributoCrudo(m[0], "height"), 10) || 0;
      }
      imgs.push(u);
    }
    if (imgs.length >= 300) break;
  }
  const prevM = /<a\b[^>]*class="[^"]*_prevEpisode[^"]*"[^>]*href="([^"]+)"/i.exec(html)
    || /<a\b[^>]*href="([^"]+)"[^>]*class="[^"]*_prevEpisode/i.exec(html);
  const nextM = /<a\b[^>]*class="[^"]*_nextEpisode[^"]*"[^>]*href="([^"]+)"/i.exec(html)
    || /<a\b[^>]*href="([^"]+)"[^>]*class="[^"]*_nextEpisode/i.exec(html);
  const ctxM = /(title_no=\d+)[^"]*?&episode_no=(\d+)/.exec(html);
  return {
    images: imgs,
    w: w,
    h: h,
    prev: prevM ? dec(prevM[1]) : "",
    next: nextM ? dec(nextM[1]) : "",
    titleNo: ctxM ? ctxM[1].split("=")[1] : "",
    curNo: ctxM ? ctxM[2] : ""
  };
}

// ---------------------------------------------------------------------------
// Navegación
// ---------------------------------------------------------------------------

function ruta(href) {
  const s = String(href || "").split("#")[0];
  const qi = s.indexOf("?");
  const path = qi >= 0 ? s.slice(0, qi) : s;
  const query = {};
  if (qi >= 0) {
    s.slice(qi + 1).split("&").forEach((kv) => {
      const i = kv.indexOf("=");
      if (i > 0) atrapar(() => { query[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1)); });
    });
  }
  return { path: path, query: query };
}

function urlListaDe(href) {
  const p = ruta(href);
  if (!p.query.title_no || !/\/list$/.test(p.path)) return "";
  return p.path + "?title_no=" + p.query.title_no;
}

function rutaDetalle(href) {
  const p = ruta(href);
  return p.query.title_no ? "/detail?title_no=" + p.query.title_no : "";
}

// El enlace del capítulo tal como lo da el sitio (absoluto o de raíz).
function urlLector(href) {
  const s = String(href || "").split("#")[0];
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  if (s.charAt(0) === "/") return BASE + s;
  return BASE + "/" + s;
}

// ---------------------------------------------------------------------------
// Listas: favoritos, historial y biblioteca (kino.storage + kino.shared)
// ---------------------------------------------------------------------------

const CLAVES = { fav: "l:fav", hist: "l:hist", bib: "l:bib" };
const COMPARTIDAS = { fav: "webtoon.fav", hist: "webtoon.hist", bib: "webtoon.bib" };

function leerLista(cual) {
  const v = sget(CLAVES[cual]);
  return Array.isArray(v) ? v : [];
}

function escribirLista(cual, arr) {
  sset(CLAVES[cual], arr);
  if (typeof kino.shared === "object" && kino.shared && typeof kino.shared.set === "function") {
    atrapar(() => kino.shared.set(COMPARTIDAS[cual], arr.slice(0, 40)));
  }
}

function restaurarListas() {
  if (typeof kino.shared !== "object" || !kino.shared || typeof kino.shared.get !== "function") return;
  Object.keys(CLAVES).forEach((cual) => {
    if (leerLista(cual).length) return;
    const otro = atrapar(() => kino.shared.get(COMPARTIDAS[cual]));
    if (Array.isArray(otro) && otro.length) sset(CLAVES[cual], otro.slice(0, 40));
  });
}

function esFav(t) { return leerLista("fav").some((x) => x.t === String(t)); }

function alternarFav(item) {
  let arr = leerLista("fav");
  const i = arr.findIndex((x) => x.t === String(item.t));
  if (i >= 0) arr.splice(i, 1);
  else arr = [{ t: String(item.t), titulo: item.titulo, poster: item.poster, genre: item.genre || "", href: item.href || "" }]
    .concat(arr).slice(0, MAX_FAV);
  escribirLista("fav", arr);
  return i < 0;
}

function anotarBiblioteca(item) {
  let arr = leerLista("bib").filter((x) => x.t !== String(item.t));
  arr.unshift({
    t: String(item.t), titulo: item.titulo, poster: item.poster, genre: item.genre || "",
    cap: String(item.cap || ""), href: item.href || "", p: item.p || "", fecha: Date.now()
  });
  escribirLista("bib", arr.slice(0, MAX_BIB));
}

function anotarHistorial(item) {
  let arr = leerLista("hist").filter((x) => x.t !== String(item.t));
  arr.unshift({
    t: String(item.t), titulo: item.titulo, poster: item.poster, genre: item.genre || "",
    cap: String(item.cap || ""), href: item.href || "", p: item.p || "",
    frac: typeof item.frac === "number" ? item.frac : 0, fecha: Date.now()
  });
  escribirLista("hist", arr.slice(0, MAX_HIST));
}

function historialDe(t) { return leerLista("hist").find((x) => x.t === String(t)) || null; }

// ---------------------------------------------------------------------------
// Progreso de lectura (capacidad "progress")
// ---------------------------------------------------------------------------

function hayProgress() { return typeof kino.progress === "object" && kino.progress && typeof kino.progress.set === "function"; }

async function guardarProgreso(t, e, intra) {
  const det = sget("d:" + t);
  const caps = capsActuales(t);
  const idx = caps ? caps.findIndex((c) => String(c.n) === String(e)) : -1;
  let fraccion = 0;
  if (caps && caps.length && idx >= 0) fraccion = Math.min(0.99, (idx + Math.max(0, Math.min(1, intra || 0))) / caps.length);
  const entrada = {
    id: "webtoon-" + t,
    title: det ? det.titulo : "",
    label: "Cap. " + e,
    labelEn: "Ch. " + e,
    poster: det ? det.poster : "",
    fraction: fraccion,
    resume: { t: String(t), e: String(e), src: (sget("v:") && sget("v:").src) || "" }
  };
  if (hayProgress()) {
    try { await kino.progress.set(entrada); } catch (err) { /* el progreso es best-effort */ }
  }
  sun("pl:");
}

function capsActuales(t) {
  const e = sget("e:");
  return e && e.t === String(t) ? e.caps : null;
}

// ---------------------------------------------------------------------------
// Trabajo pendiente: se deriva del route y del almacenamiento (nada en memoria),
// así cada ticke del temporizador sabe solo mirando qué falta en la vista.
// ---------------------------------------------------------------------------

const M = {
  tab: "inicio",
  modo: "tira",        // "tira" | "paginas"
  pagina: 0,
  pendiente: false,    // ¿hay tareas de red para el route actual?
  fallos: {},          // clave -> { hasta, msg, intentos }
  rev: 0,
  ruta: "",            // clave de la ruta pintada (reinicia la barra de carga)
  claves: "",          // tareas pendientes de la ruta (reinicia su espera)
  prog: 0,             // valor actual de la barra de carga (monótono: nunca baja)
  t0: 0                // cuándo empezó a esperar el lote de tareas actual
};

const MAX_INTENTOS = 3;

// El fallo vigente de una tarea: lo devuelve mientras esté esperando un reintento
// o ya rendido (sirve para programar el reinterto Y para el mensaje en la vista).
function falloDe(clave) {
  const f = M.fallos[clave];
  if (!f) return null;
  if (f.intentos >= MAX_INTENTOS) return f;  // rendido hasta "reintentar"
  if (Date.now() < f.hasta) return f;        // en espera
  return null;                               // pasó la espera: vuelve a intentarse
}

function fallar(clave, err) {
  const previo = M.fallos[clave];
  const intentos = (previo && previo.intentos ? previo.intentos : 0) + 1;
  M.fallos[clave] = {
    hasta: Date.now() + COOLDOWN_MS,
    intentos: intentos,
    msg: String((err && err.message) || err || "Error").slice(0, 120)
  };
}

function tareaUtil(clave, tarea) {
  return rendido(clave) ? null : tarea;
}

// ¿Se rindió la tarea (3 fallos seguidos)? Solo "Reintentar" la vuelve a poner en marcha.
function rendido(clave) {
  const f = M.fallos[clave];
  return !!(f && f.intentos >= MAX_INTENTOS);
}

// ¿Todavía está en espera de su reintento (sin gastar red)?
function enEspera(clave) {
  const f = M.fallos[clave];
  return !!(f && f.intentos < MAX_INTENTOS && Date.now() < f.hasta);
}

// Las tareas que la vista del route todavía necesita, en orden de prioridad.
function tareasParaRuta(route) {
  const nombre = (route && route.name) || "main";
  const p = (route && route.params) || {};
  const fuera = [];
  if (!route || nombre === "main") {
    for (let i = 0; i < SEMILLAS.length; i++) {
      const slug = SEMILLAS[i];
      const s = sget("i:" + slug);
      if (s && s.items && s.items.length) continue;
      const t = tareaUtil("seccion:" + slug, { clave: "seccion:" + slug, tipo: "seccion", genero: slug });
      if (!t) continue; // rendida: que sigan cargando las demás secciones
      fuera.push(t);
      break; // una por ticke
    }
    if (!fuera.length && sget("gn:") === null) {
      const t = tareaUtil("seccion:" + SEMILLAS[0], { clave: "seccion:" + SEMILLAS[0], tipo: "seccion", genero: SEMILLAS[0] });
      if (t) fuera.push(t);
    }
    if (!fuera.length && sget("pl:") === null) {
      const t = tareaUtil("progreso", { clave: "progreso", tipo: "progreso" });
      if (t) fuera.push(t);
    }
    return fuera;
  }
  if (nombre === "genero") {
    const g = String(p.g || SEMILLAS[0]);
    const s = sget("i:" + g);
    if (!s || !s.items || !s.items.length) {
      const t = tareaUtil("seccion:" + g, { clave: "seccion:" + g, tipo: "seccion", genero: g });
      if (t) fuera.push(t);
    }
    return fuera;
  }
  if (nombre === "detail") {
    const t = String(p.t || "");
    if (!t) return fuera;
    const det = sget("d:" + t);
    const pend = sget("pgpend:");
    if (pend && pend.t === t) {
      const clave = "caps:" + t + ":" + pend.p;
      if (rendido(clave)) sun("pgpend:");
      else fuera.push({ clave: clave, tipo: "caps", t: t, p: pend.p });
      if (fuera.length) return fuera;
    }
    if (!det || !det.titulo) {
      const tarea = tareaUtil("detalle:" + t, { clave: "detalle:" + t, tipo: "detalle", t: t, href: p.href || "" });
      if (tarea) fuera.push(tarea);
      return fuera;
    }
    if (!(capsActuales(t) || []).length) {
      const tarea = tareaUtil("caps:" + t + ":1", { clave: "caps:" + t + ":1", tipo: "caps", t: t, p: "1" });
      if (tarea) fuera.push(tarea);
    }
    return fuera;
  }
  if (nombre === "read") {
    const t = String(p.t || "");
    const e = String(p.e || "");
    if (!t || !e) return fuera;
    const v = sget("v:");
    if (!v || v.t !== t || v.e !== e) {
      const clave = "capitulo:" + t + ":" + e;
      const tarea = rendido(clave) ? null : { clave: clave, tipo: "capitulo", t: t, e: e, src: p.p || "" };
      if (tarea) fuera.push(tarea);
    }
    return fuera;
  }
  return fuera;
}

async function ejecutar(tarea) {
  if (tarea.tipo === "seccion") return tareaSeccion(tarea);
  if (tarea.tipo === "detalle") return tareaDetalle(tarea);
  if (tarea.tipo === "caps") return tareaCaps(tarea);
  if (tarea.tipo === "capitulo") return tareaCapitulo(tarea);
  if (tarea.tipo === "progreso") return tareaProgreso();
}

async function tareaSeccion(t) {
  const html = await get(BASE + "/en/genres/" + t.genero + "?sortOrder=LIKEIT");
  const s = parseSeccionGenero(html, t.genero);
  if (!s) throw new Error("Ese género no devolvió obras");
  sset("i:" + t.genero, s, TTL_SECCION);
  // Lista real de géneros: si esta página no la trae, se anota un intento hecho
  // ("gn:" = []) para no volver a pedirla en bucle; las etiquetas usan las semillas.
  if (s.generos && s.generos.length) sset("gn:", s.generos, TTL_SECCION);
  else if (sget("gn:") === null) sset("gn:", [], TTL_SECCION);
}

async function traerHtmlLista(t, href) {
  const url = urlListaDe(href);
  if (url) return { html: await get(url), url: url };
  // Sin enlace: la obra se busca por su title_no (funciona con Originales y Canvas).
  const htmlBusq = await get(BASE + "/en/search?keyword=" + encodeURIComponent(t));
  const cards = parseTarjetas(htmlBusq, "_card_item");
  const card = cards.find((c) => c.titleNo === String(t)) || cards[0];
  if (!card) throw new Error("No encontramos esa obra en WEBTOON");
  const url2 = urlListaDe(card.href);
  if (!url2) throw new Error("La obra no tiene página de capítulos");
  sset("d:" + t, {
    t: String(t), href: card.href, titulo: card.title, autor: card.author,
    poster: card.poster, genre: "", summary: "", likes: card.metric
  }, TTL_DETALLE);
  return { html: await get(url2), url: url2 };
}

async function tareaDetalle(t) {
  const datos = await traerHtmlLista(t.t, t.href);
  const det = parseDetalle(datos.html);
  if (!det.titulo) throw new Error("No pudimos leer la obra");
  sset("d:" + t.t, Object.assign(det, { t: String(t.t), href: datos.url, genreSlug: generoDe(datos.url) }), TTL_DETALLE);
  const caps = parseEpisodios(datos.html);
  if (caps.length) sset("e:", { t: String(t.t), caps: caps });
  const pag = parsePaginaDetalle(datos.html);
  sset("pg:", { t: String(t.t), p: pag.p, last: pag.last, mas: !!pag.mas });
  if (caps.length) sset("pgitems:", { t: String(t.t), p: pag.p || 1, items: caps });
}

function generoDe(urlOuHref) {
  const seg = ruta(urlOuHref).path.split("/").filter(Boolean);
  return seg.length >= 3 && seg[0] === "en" && seg[2] === "list" ? seg[1] : "";
}

async function tareaCaps(t) {
  const det = sget("d:" + t.t);
  const base = det ? urlListaDe(det.href) : "";
  if (!base) throw new Error("Abre primero la obra");
  const pagina = Math.max(1, parseInt(t.p, 10) || 1);
  const html = await get(base + (pagina > 1 ? "&page=" + pagina : ""));
  const caps = parseEpisodios(html);
  if (!caps.length) throw new Error("No hay más capítulos");
  const actuales = capsActuales(t.t) || [];
  const mapa = {};
  actuales.forEach((c) => { mapa[c.n] = c; });
  caps.forEach((c) => { mapa[c.n] = c; });
  const lista = Object.keys(mapa).map((k) => mapa[k])
    .sort((a, b) => Number(a.n) - Number(b.n))
    .slice(-MAX_CAPS_GUARDADOS);
  sset("e:", { t: String(t.t), caps: lista });
  const pag = parsePaginaDetalle(html);
  sset("pg:", { t: String(t.t), p: pag.p || pagina, last: pag.last || pagina, mas: !!pag.mas });
  sset("pgitems:", { t: String(t.t), p: pag.p || pagina, items: caps });
  sun("pgpend:");
}

async function tareaCapitulo(t) {
  let href = "";
  if (t.src) href = urlLector(t.src);
  if (!href) {
    const caps = capsActuales(t.t);
    const cap = caps ? caps.find((c) => String(c.n) === String(t.e)) : null;
    if (cap) href = urlLector(cap.p);
  }
  if (!href) throw new Error("Ese capítulo no está en la primera página de la obra");
  const html = await get(href);
  const v = parseViewer(html);
  if (!v.images.length) throw new Error("Este capítulo no tiene imágenes");

  // Guarda solo el capítulo vigente (las tiras pesan; hay 256 KB en total).
  sun("v:");
  sset("v:", {
    t: String(t.t), e: String(t.e), src: href,
    images: v.images, w: v.w, h: v.h, prev: v.prev, next: v.next, ts: Date.now()
  }, TTL_LECTURA);

  // Asegura que el capítulo esté en la lista para saber cuántos hay.
  const caps = capsActuales(t.t);
  if (caps && !caps.some((c) => String(c.n) === String(t.e))) {
    caps.push({ n: String(t.e), p: href, t: "Episodio " + t.e, d: "" });
    caps.sort((a, b) => Number(a.n) - Number(b.n));
    sset("e:", { t: String(t.t), caps: caps.slice(-MAX_CAPS_GUARDADOS) });
  }

  const det = sget("d:" + t.t);
  anotarHistorial({
    t: t.t, titulo: det ? det.titulo : "", poster: det ? det.poster : "", genre: det ? det.genre : "",
    cap: String(t.e), href: det ? det.href : "", p: href, frac: 0
  });
  anotarBiblioteca({
    t: t.t, titulo: det ? det.titulo : "", poster: det ? det.poster : "", genre: det ? det.genre : "",
    cap: String(t.e), href: det ? det.href : "", p: href
  });
  await guardarProgreso(t.t, t.e, 0);
}

async function tareaProgreso() {
  if (!hayProgress()) { sset("pl:", []); return; }
  let lista = [];
  try { lista = await kino.progress.list({ limit: 30 }); } catch (e) { lista = []; }
  const salida = [];
  (Array.isArray(lista) ? lista : []).forEach((x) => {
    const r = x && x.resume;
    if (r && r.t && salida.length < 20) {
      salida.push({
        t: String(r.t), e: String(r.e || ""), src: String(r.src || ""),
        titulo: x.title || "", poster: x.poster || "", label: x.label || "",
        frac: typeof x.fraction === "number" ? x.fraction : 0,
        done: !!x.done
      });
    }
  });
  sset("pl:", salida);
}

// ---------------------------------------------------------------------------
// Construcción de vistas
// ---------------------------------------------------------------------------

const TABS = [
  { value: "inicio", label: "Inicio", labelEn: "Home" },
  { value: "biblioteca", label: "Biblioteca", labelEn: "Library" },
  { value: "favoritos", label: "Favoritos", labelEn: "Favourites" },
  { value: "historial", label: "Historial", labelEn: "History" },
  { value: "buscar", label: "Buscar", labelEn: "Search" }
];

// Barra de carga creciente (widget "progress"): nunca baja, arranca desde lo que
// ya se cargó (base) y sigue creciendo mientras la vista espera su tarea, sin
// marcar el 100% hasta que el dato llegue de verdad.
function barraCarga(base, etiqueta, etiquetaEn) {
  const b = Math.max(0, Math.min(1, Number(base) || 0));
  const ahora = Date.now();
  if (!M.t0) M.t0 = ahora;
  const espera = Math.min(1, (ahora - M.t0) / 9000);
  const v = Math.min(0.97, Math.max(M.prog || 0, b + (0.97 - b) * espera));
  M.prog = v;
  return { type: "LinearProgressIndicator", value: v, labelText: etiqueta, labelTextEn: etiquetaEn || etiqueta };
}

function tarjeta(item, opts) {
  const o = opts || {};
  const ruta = o.ruta || { event: "detalle", arg: item.titleNo || item.t };
  const card = {
    type: "Card",
    gap: 4,
    onTap: ruta,
    children: [
      {
        type: "Image", url: item.poster || "", headers: IMG_HEADERS, fit: "cover",
        width: o.fijo ? 160 : undefined, height: 200, borderRadius: "medium",
        aspect: o.fijo ? "4:5" : undefined, fill: o.fijo ? undefined : true
      },
      { type: "Text", text: item.title || item.titulo || "", style: "label", bold: true, maxLines: 1 },
      { type: "Text", text: o.sub || item.author || item.autor || item.genre || "", style: "caption", color: "muted", maxLines: 1 }
    ]
  };
  if (o.fijo) card.width = 160;
  else card.fill = true;
  return card;
}

function railTarjetas(items, mappear, fijo) {
  const hijos = items.map((it, i) => mappear(it, i));
  return { type: "SingleChildScrollView", direction: "horizontal", children: [{ type: "Row", gap: 8, children: hijos }] };
}

function seccionGenero(s) {
  return {
    type: "Column", gap: 8, children: [
      {
        type: "Row", justify: "spaceBetween", children: [
          { type: "Text", text: s.titulo, style: "h4", bold: true },
          s.genero ? { type: "TextButton", labelText: "Ver todo", onPressed: { event: "genero", arg: s.genero } } : { type: "Spacer" }
        ]
      },
      railTarjetas(s.items.slice(0, 10), (it) => tarjeta(it, { fijo: true, ruta: { event: "detalle", arg: it.titleNo + "|" + encodeURIComponent(it.href) } }))
    ]
  };
}

function chipsGeneros(generos) {
  const hijos = [];
  generos.slice(0, 16).forEach((g) => {
    hijos.push({ type: "Button", variant: "secondary", labelText: g.label, onPressed: { event: "genero", arg: g.slug } });
  });
  return { type: "SingleChildScrollView", direction: "horizontal", children: [{ type: "Row", gap: 8, children: hijos }] };
}

// --- Inicio -----------------------------------------------------------------

function cuerpoInicio() {
  const hijos = [];
  const semillas = SEMILLAS;
  const gn = sget("gn:");
  const generos = Array.isArray(gn) && gn.length ? gn : semillas.map((s) => ({ slug: s, label: s.toUpperCase() }));

  const total = semillas.length;
  let cargadas = 0;
  semillas.forEach((slug) => {
    const s = sget("i:" + slug);
    if (s && s.items && s.items.length) cargadas++;
  });

  // Seguir leyendo (capacidad progress); si aún no está, su barra de carga.
  const pl = sget("pl:");
  if (Array.isArray(pl) && pl.length) {
    const items = pl.filter((x) => !x.done && x.t).slice(0, 10);
    if (items.length) {
      hijos.push({ type: "Text", text: "Seguir leyendo", style: "h4", bold: true });
      hijos.push(railTarjetas(items, (x) => tarjeta({
        poster: x.poster, title: x.titulo || x.t, t: x.t, genre: x.label
      }, { fijo: true, ruta: { event: "leer", arg: x.t + "|" + (x.e || "") + "|" + encodeURIComponent(x.src || "") } })));
    }
  } else if (pl === null && cargadas >= total && !rendido("progreso")) {
    hijos.push(barraCarga(1,
      enEspera("progreso") ? "Reintentando tu progreso…" : "Cargando tu progreso…",
      "Loading your progress…"));
  }

  // Cada sección: la cargada se pinta; la que falta enseña su barra de carga
  // (crece con lo ya cargado) o su error, si ya se rindió.
  let algunaRendida = false;
  semillas.forEach((slug) => {
    const s = sget("i:" + slug);
    if (s && s.items && s.items.length) { hijos.push(seccionGenero(s)); return; }
    const titulo = slug.replace(/_/g, " ").toUpperCase();
    const clave = "seccion:" + slug;
    const err = falloDe(clave);
    const seccion = [{ type: "Text", text: titulo, style: "h4", bold: true }];
    if (rendido(clave)) {
      algunaRendida = true;
      seccion.push({ type: "Text", text: "No se pudo cargar: " + (err ? err.msg : ""), color: "error", style: "caption" });
    } else {
      seccion.push(barraCarga(cargadas / total,
        (err ? "Reintentando " : "Cargando ") + titulo + "… (" + cargadas + "/" + total + ")",
        (err ? "Retrying " : "Loading ") + titulo + " (" + cargadas + "/" + total + ")"));
    }
    hijos.push({ type: "Column", gap: 8, children: seccion });
  });

  hijos.push({ type: "Text", text: "Explorar géneros", style: "h4", bold: true });
  hijos.push(chipsGeneros(generos));

  if (algunaRendida) {
    hijos.push({ type: "ElevatedButton", icon: "refresh", labelText: "Reintentar carga", onPressed: { event: "reintentar", arg: "" } });
  }
  hijos.push({ type: "SizedBox", height: 32 });
  return { type: "SingleChildScrollView", direction: "vertical", children: [{ type: "Column", gap: 16, children: hijos }] };
}

// --- Biblioteca / Favoritos / Historial --------------------------------------

function filaLista(item, badge) {
  return {
    type: "ListTile",
    title: item.titulo || item.title || "",
    subtitle: [item.genre, item.cap ? "Cap. " + item.cap : ""].filter(Boolean).join(" · ") || item.autor || "",
    leading: { type: "Image", url: item.poster || "", headers: IMG_HEADERS, fit: "cover", width: 48, height: 64, borderRadius: "small" },
    trailing: badge ? { type: "Text", text: badge, style: "caption", color: "muted" } : undefined,
    onTap: { event: "detalle", arg: item.t + "|" + encodeURIComponent(item.href || "") }
  };
}

function cuerpoBiblioteca() {
  const arr = leerLista("bib");
  if (!arr.length) {
    return { type: "emptyState", icon: "bookmark", title: "Tu biblioteca está vacía", titleEn: "Your library is empty", text: "Abre una obra y se guardará aquí para seguir leyendo." };
  }
  return { type: "ListView", items: arr.map((it) => filaLista(it, it.cap ? "Cap. " + it.cap : "")) };
}

function cuerpoFavoritos() {
  const arr = leerLista("fav");
  if (!arr.length) {
    return { type: "emptyState", icon: "heart", title: "Aún no tienes favoritos", titleEn: "No favourites yet", text: "Entra a una obra y pulsa el corazón para guardarla." };
  }
  return { type: "ListView", items: arr.map((it) => filaLista(it, "♥")) };
}

function tarjetaHistorial(h) {
  return tarjeta({
    poster: h.poster, title: h.titulo, t: h.t, genre: h.cap ? "Cap. " + h.cap : h.genre
  }, {
    fijo: true,
    ruta: h.p ? { event: "leer", arg: h.t + "|" + h.cap + "|" + encodeURIComponent(h.p) } : { event: "detalle", arg: h.t + "|" + encodeURIComponent(h.href || "") }
  });
}

function cuerpoHistorial() {
  const arr = leerLista("hist");
  if (!arr.length) {
    return { type: "emptyState", icon: "list", title: "Todavía no has leído nada", titleEn: "Nothing read yet", text: "Lo que leas aparecerá aquí con tu progreso." };
  }
  const filas = [];
  for (let i = 0; i < Math.min(arr.length, 30); i += 8) {
    filas.push(railTarjetas(arr.slice(i, i + 8), (h) => tarjetaHistorial(h)));
  }
  filas.push({ type: "SizedBox", height: 24 });
  return { type: "SingleChildScrollView", direction: "vertical", children: [{ type: "Column", gap: 12, children: filas }] };
}

// --- Buscar -----------------------------------------------------------------

function cuerpoBuscar(inputs) {
  const q = (inputs && inputs.q) || "";
  const guardado = sget("bus") || { q: "", items: [] };
  const hijos = [
    {
      type: "Row", gap: 8, children: [
        {
          type: "TextField", key: "q", value: q, hintText: "Buscar webtoon…", hintTextEn: "Search webtoon…",
          kind: "search", onSubmitted: { event: "buscar" }, flex: 1
        },
        { type: "ElevatedButton", icon: "search", labelText: "Buscar", onPressed: { event: "buscar" } }
      ]
    }
  ];
  if (guardado.q && guardado.items) {
    hijos.push({ type: "Text", text: guardado.items.length ? "Resultados de “" + guardado.q + "”" : "Sin resultados para “" + guardado.q + "”", style: "caption", color: "muted" });
    if (guardado.items.length) {
      hijos.push({
        type: "Row", wrap: true, gap: 8,
        children: guardado.items.slice(0, 24).map((it) => {
          const c = tarjeta(it, { ruta: { event: "detalle", arg: it.titleNo + "|" + encodeURIComponent(it.href) } });
          c.span = 4;
          return c;
        })
      });
    }
  } else {
    hijos.push({ type: "Text", text: "Escribe el nombre de un webtoon y pulsa Buscar.", color: "muted" });
    const populares = sget("i:" + SEMILLAS[0]);
    if (populares && populares.items) {
      hijos.push({ type: "Text", text: "O explora por género", style: "h5", bold: true });
      hijos.push(railTarjetas(populares.items.slice(0, 10), (it) => tarjeta(it, { fijo: true, ruta: { event: "detalle", arg: it.titleNo + "|" + encodeURIComponent(it.href) } })));
    }
  }
  hijos.push({ type: "SizedBox", height: 32 });
  return { type: "SingleChildScrollView", direction: "vertical", children: [{ type: "Column", gap: 12, children: hijos }] };
}

function cuerpoTab(tab, inputs) {
  if (tab === "biblioteca") return cuerpoBiblioteca();
  if (tab === "favoritos") return cuerpoFavoritos();
  if (tab === "historial") return cuerpoHistorial();
  if (tab === "buscar") return cuerpoBuscar(inputs);
  return cuerpoInicio();
}

// --- Detalle ----------------------------------------------------------------

function vistaDetalle(params) {
  const t = String(params.t || "");
  const det = sget("d:" + t);
  if (!det) {
    const err = falloDe("detalle:" + t);
    const cuerpo = rendido("detalle:" + t)
      ? { type: "Column", gap: 12, children: [
          { type: "Text", text: "No se pudo cargar: " + (err ? err.msg : ""), color: "error", style: "caption" },
          { type: "ElevatedButton", icon: "refresh", labelText: "Reintentar", onPressed: { event: "reintentar", arg: "detalle:" + t } }
        ] }
      : { type: "Column", gap: 12, children: [
          barraCarga(0, err ? "Reintentando la obra…" : "Cargando la obra…", err ? "Retrying the series…" : "Loading the series…"),
          { type: "Text", text: "Cargando la obra…", color: "muted" }
        ] };
    return scaffoldCon(cuerpo, "WEBTOON");
  }

  const caps = capsActuales(t);
  const pag = sget("pg:");
  const pagInfo = pag && pag.t === t ? pag : { p: 1, last: 1, mas: false };
  const hayMasPaginas = !!pagInfo.mas || pagInfo.p < pagInfo.last;
  const hist = historialDe(t);
  // El capítulo más reciente (la lista cargada puede venir ordenada ascendente).
  const reciente = caps && caps.length
    ? caps.reduce((m, c) => (Number(c.n) > Number(m.n) ? c : m), caps[0])
    : null;
  const hijos = [
    {
      type: "Row", gap: 16, children: [
        { type: "Image", url: det.poster || "", headers: IMG_HEADERS, fit: "cover", width: 160, height: 200, borderRadius: "medium", aspect: "4:5" },
        {
          type: "Column", gap: 4, flex: 1, children: [
            { type: "Text", text: det.titulo || "WEBTOON", style: "h3", bold: true, maxLines: 3 },
            det.genre ? { type: "Text", text: det.genre, style: "caption", color: "primary", bold: true } : { type: "Spacer" },
            det.autor ? { type: "Text", text: det.autor, style: "caption", color: "muted", maxLines: 2 } : { type: "Spacer" },
            det.likes ? { type: "Text", text: "★ " + det.likes + " likes", style: "caption", color: "muted" } : { type: "Spacer" },
            {
              type: "Row", gap: 8, children: [
                {
                  type: "ElevatedButton", icon: "play", flex: 1,
                  labelText: hist && hist.cap ? "Continuar Cap. " + hist.cap : (reciente ? "Leer Cap. " + reciente.n : "Leer"),
                  onPressed: { event: "leer", arg: hist && hist.cap && hist.p ? t + "|" + hist.cap + "|" + encodeURIComponent(hist.p) : (reciente ? t + "|" + reciente.n + "|" + encodeURIComponent(reciente.p) : "") }
                },
                {
                  type: "IconButton", icon: "heart", labelText: esFav(t) ? "Quitar de favoritos" : "Guardar en favoritos",
                  badge: esFav(t) ? { text: "♥" } : undefined,
                  onPressed: { event: "fav", arg: t }
                }
              ]
            }
          ]
        }
      ]
    }
  ];

  if (det.summary) hijos.push({ type: "Text", text: det.summary, style: "p", color: "muted", maxLines: 6 });
  hijos.push({ type: "Divider" });
  hijos.push({ type: "Text", text: "Capítulos", style: "h4", bold: true });

  if (pagInfo.p > 1 || hayMasPaginas) {
    hijos.push({
      type: "Text",
      text: pagInfo.mas ? "Página " + pagInfo.p + " (hay más)" : "Página " + pagInfo.p + " de " + pagInfo.last,
      style: "caption", color: "muted"
    });
  }

  // Al pedir otra página de capítulos, su barra de carga queda visible sobre la lista.
  const pend = sget("pgpend:");
  if (pend && pend.t === t && !rendido("caps:" + t + ":" + pend.p)) {
    hijos.push(barraCarga(0.6, "Cargando la página " + pend.p + "…", "Loading page " + pend.p + "…"));
  }

  // Los capítulos de la página que se está viendo; si aún no hay, los cargados.
  // Siempre del episodio 1 al último (el sitio los da al revés).
  const pgi = sget("pgitems:");
  let paginaCaps = null;
  if (pgi && pgi.t === t && pgi.items && pgi.items.length) paginaCaps = pgi.items;
  else if (caps && caps.length) paginaCaps = caps;
  if (paginaCaps) paginaCaps = paginaCaps.slice().sort((a, b) => Number(a.n) - Number(b.n));

  if (paginaCaps && paginaCaps.length) {
    hijos.push({
      type: "ListView", items: paginaCaps.map((c) => ({
        type: "ListTile",
        title: c.t || ("Episodio " + c.n),
        subtitle: [c.d, "#" + c.n].filter(Boolean).join(" · "),
        leading: { type: "Icon", name: "bookmark" },
        onTap: { event: "leer", arg: t + "|" + c.n + "|" + encodeURIComponent(c.p) }
      }))
    });
    hijos.push({
      type: "Row", justify: "spaceBetween", children: [
        {
          type: "TextButton", icon: "arrow_back", labelText: "Anterior", enabled: pagInfo.p > 1,
          onPressed: pagInfo.p > 1 ? { event: "caps", arg: t + "|" + (pagInfo.p - 1) } : undefined
        },
        {
          type: "TextButton", icon: "arrow_forward", labelText: "Siguiente", enabled: hayMasPaginas,
          onPressed: hayMasPaginas ? { event: "caps", arg: t + "|" + (pagInfo.p + 1) } : undefined
        }
      ]
    });
  } else {
    if (!rendido("caps:" + t + ":1")) {
      const errCaps = falloDe("caps:" + t + ":1");
      hijos.push(barraCarga(0.5,
        errCaps ? "Reintentando los capítulos…" : "Cargando los capítulos…",
        errCaps ? "Retrying the episodes…" : "Loading the episodes…"));
    }
    hijos.push({
      type: "ElevatedButton", icon: "list", labelText: "Ver todos los capítulos",
      onPressed: { event: "caps", arg: t + "|1" }
    });
  }

  const err = falloDe("detalle:" + t) || falloDe("caps:" + t + ":1") ||
    (pend && pend.t === t ? falloDe("caps:" + t + ":" + pend.p) : null);
  if (err) {
    hijos.push({
      type: "Column", gap: 8, children: [
        { type: "Text", text: "No se pudo cargar: " + err.msg, color: "error", style: "caption" },
        { type: "ElevatedButton", icon: "refresh", labelText: "Reintentar", onPressed: { event: "reintentar", arg: "detalle:" + t } }
      ]
    });
  }

  hijos.push({ type: "SizedBox", height: 32 });
  const cuerpo = { type: "SingleChildScrollView", direction: "vertical", children: [{ type: "Column", gap: 16, children: hijos }] };
  return scaffoldCon(cuerpo, det.titulo || "Obra", { volver: true, cargando: M.pendiente && !err });
}

// --- Género -----------------------------------------------------------------

function vistaGenero(params) {
  const g = String(params.g || SEMILLAS[0]);
  const s = sget("i:" + g);
  const etiqueta = (s && s.titulo) || g.replace(/_/g, " ").toUpperCase();
  const gn = sget("gn:");
  const generos = Array.isArray(gn) && gn.length ? gn : TODOS_SLUGS.map((x) => ({ slug: x, label: x.replace(/_/g, " ").toUpperCase() }));

  if (!s) {
    const err = falloDe("seccion:" + g);
    const cuerpo = rendido("seccion:" + g)
      ? { type: "Column", gap: 12, children: [
          { type: "Text", text: etiqueta, style: "h3", bold: true },
          { type: "Text", text: "No se pudo cargar: " + (err ? err.msg : ""), color: "error", style: "caption" },
          { type: "ElevatedButton", icon: "refresh", labelText: "Reintentar", onPressed: { event: "reintentar", arg: "" } }
        ] }
      : { type: "Column", gap: 12, children: [
          { type: "Text", text: etiqueta, style: "h3", bold: true },
          barraCarga(0, err ? "Reintentando " + etiqueta + "…" : "Cargando " + etiqueta + "…",
            err ? "Retrying " + etiqueta : "Loading " + etiqueta),
          { type: "Text", text: "Cargando las obras del género…", color: "muted" }
        ] };
    return scaffoldCon(cuerpo, etiqueta, { volver: true, cargando: true });
  }

  const hijos = [
    { type: "Text", text: etiqueta, style: "h3", bold: true },
    { type: "Text", text: "Obras destacadas del género", style: "caption", color: "muted" }
  ];
  hijos.push({
    type: "Row", wrap: true, gap: 8,
    children: s.items.map((it) => {
      const c = tarjeta(it, { ruta: { event: "detalle", arg: it.titleNo + "|" + encodeURIComponent(it.href) } });
      c.span = 4;
      return c;
    })
  });
  hijos.push({ type: "Text", text: "Más géneros", style: "h5", bold: true });
  hijos.push(chipsGeneros(generos.filter((x) => x.slug !== g)));
  hijos.push({ type: "SizedBox", height: 32 });

  const err = falloDe("seccion:" + g);
  if (err) hijos.push({ type: "Text", text: "No se pudo cargar: " + err.msg, color: "error", style: "caption" });

  const cuerpo = { type: "SingleChildScrollView", direction: "vertical", children: [{ type: "Column", gap: 16, children: hijos }] };
  return scaffoldCon(cuerpo, etiqueta, { volver: true, cargando: M.pendiente && !err });
}

// --- Lector -----------------------------------------------------------------

function tieneWidget(nombre) {
  try {
    return !!(kino.screen && Array.isArray(kino.screen.widgets) && kino.screen.widgets.indexOf(nombre) >= 0);
  } catch (e) { return false; }
}

function vistaLector(params) {
  const t = String(params.t || "");
  const e = String(params.e || "");
  const v = sget("v:");

  if (!v || v.t !== t || v.e !== e) {
    const err = falloDe("capitulo:" + t + ":" + e);
    const cuerpo = rendido("capitulo:" + t + ":" + e)
      ? { type: "Column", gap: 12, children: [
          { type: "Text", text: "No se pudo abrir: " + (err ? err.msg : ""), color: "error", style: "caption" },
          { type: "ElevatedButton", icon: "refresh", labelText: "Reintentar", onPressed: { event: "reintentar", arg: "" } }
        ] }
      : { type: "Column", gap: 12, children: [
          barraCarga(0, err ? "Reintentando el capítulo " + e + "…" : "Abriendo el capítulo " + e + "…",
            err ? "Retrying episode " + e : "Opening episode " + e),
          { type: "Text", text: "Descargando las páginas del episodio…", color: "muted" }
        ] };
    return scaffoldCon(cuerpo, "Capítulo " + e, { volver: true, cargando: true });
  }

  const det = sget("d:" + t);
  const caps = capsActuales(t);
  const idx = caps ? caps.findIndex((c) => String(c.n) === String(e)) : -1;
  const total = caps && caps.length ? caps.length : 0;
  const tituloObra = det ? det.titulo : "WEBTOON";

  const aspecto = v.w > 0 && v.h > 0 ? v.w + ":" + v.h : "2:3";
  const porPagina = tieneWidget("pageView") ? 24 : 8;
  const paginas = v.images.map((u, i) => ({
    type: "Image", url: u, headers: IMG_HEADERS, fit: M.modo === "paginas" ? "contain" : "width",
    fill: M.modo !== "paginas", aspect: aspecto, key: "img" + i
  }));

  let cuerpo;
  if (M.modo === "paginas" && tieneWidget("pageView") && v.images.length) {
    const inicio = Math.floor((M.pagina || 0) / porPagina) * porPagina;
    cuerpo = {
      type: "PageView", key: "lectorPaginas", flex: 1,
      children: paginas.slice(inicio, inicio + porPagina),
      onPageChanged: { event: "pag" }
    };
  } else if (M.modo === "paginas" && tieneWidget("pages") && v.images.length) {
    const inicio = Math.floor((M.pagina || 0) / 8) * 8;
    cuerpo = {
      type: "pages", key: "lectorPaginas", flex: 1,
      children: paginas.slice(inicio, inicio + 8),
      onPageChanged: { event: "pag" }
    };
  } else {
    cuerpo = {
      type: "SingleChildScrollView", flex: 1, zoom: true, direction: "vertical",
      onScroll: { event: "scroll" },
      children: [{ type: "Column", gap: 4, children: paginas }]
    };
  }

  const hijos = [
    {
      type: "Row", gap: 8, crossAxisAlignment: "center", children: [
        { type: "IconButton", icon: "arrow_back", labelText: "Volver", onPressed: { event: "volver" } },
        {
          type: "Column", gap: 0, flex: 1, children: [
            { type: "Text", text: tituloObra, style: "h5", bold: true, maxLines: 1 },
            { type: "Text", text: "Episodio " + e + (total ? " · " + (idx + 1) + "/" + total : ""), style: "caption", color: "muted" }
          ]
        },
        {
          type: "IconButton", icon: "arrow_back", labelText: "Capítulo anterior", enabled: !!v.prev,
          onPressed: v.prev ? { event: "leer", arg: t + "|" + ((v.prev.match(/episode_no=(\d+)/) || [])[1] || "") + "|" + encodeURIComponent(v.prev) } : undefined
        },
        {
          type: "IconButton", icon: "arrow_forward", labelText: "Capítulo siguiente", enabled: !!v.next,
          onPressed: v.next ? { event: "leer", arg: t + "|" + ((v.next.match(/episode_no=(\d+)/) || [])[1] || "") + "|" + encodeURIComponent(v.next) } : undefined
        },
        {
          type: "IconButton", icon: M.modo === "paginas" ? "list" : "bookmark",
          labelText: M.modo === "paginas" ? "Ver en tira" : "Ver en páginas",
          onPressed: { event: "modo" }
        }
      ]
    },
    { type: "LinearProgressIndicator", value: total ? (idx + 1) / total : 0 },
    cuerpo,
    {
      type: "Row", justify: "spaceBetween", children: [
        {
          type: "TextButton", icon: "arrow_back", labelText: "Anterior", enabled: !!v.prev,
          onPressed: v.prev ? { event: "leer", arg: t + "|" + ((v.prev.match(/episode_no=(\d+)/) || [])[1] || "") + "|" + encodeURIComponent(v.prev) } : undefined
        },
        { type: "TextButton", icon: "list", labelText: "Capítulos", onPressed: { event: "detalle", arg: t + "|" + encodeURIComponent(det ? det.href : "") } },
        {
          type: "TextButton", icon: "arrow_forward", labelText: "Siguiente", enabled: !!v.next,
          onPressed: v.next ? { event: "leer", arg: t + "|" + ((v.next.match(/episode_no=(\d+)/) || [])[1] || "") + "|" + encodeURIComponent(v.next) } : undefined
        }
      ]
    }
  ];

  const err = falloDe("capitulo:" + t + ":" + e);
  if (err) {
    hijos.push({
      type: "Column", gap: 8, children: [
        { type: "Text", text: "No se pudo abrir: " + err.msg, color: "error", style: "caption" },
        { type: "ElevatedButton", icon: "refresh", labelText: "Reintentar", onPressed: { event: "reintentar", arg: "" } }
      ]
    });
  }
  return scaffoldCon({ type: "Column", gap: 8, children: hijos }, "Capítulo " + e, { volver: true, cargando: M.pendiente && !err });
}

// --- Andamio (Scaffold) -----------------------------------------------------

function scaffoldCon(cuerpo, titulo, op) {
  const o = op || {};
  return {
    type: "Scaffold",
    appBar: {
      type: "AppBar",
      title: titulo || "WEBTOON",
      leading: o.volver ? { type: "IconButton", icon: "arrow_back", labelText: "Volver", onPressed: { event: "volver" } } : undefined,
      actions: o.cargando ? [{ type: "IconButton", icon: "refresh", labelText: "Actualizar", onPressed: { event: "reintentar", arg: "" } }] : undefined
    },
    body: cuerpo
  };
}

function vistaPrincipal(inputs, tab) {
  return {
    type: "Scaffold",
    appBar: {
      type: "AppBar",
      title: "WEBTOON",
      bottom: { type: "TabBar", tabs: TABS, value: tab, onChanged: { event: "tab" } }
    },
    body: cuerpoTab(tab, inputs)
  };
}

// ---------------------------------------------------------------------------
// screen / screenEvent
// ---------------------------------------------------------------------------

// Modo del lector y página: viven en storage para sobrevivir a reinicios.
function cargarAjustesLector() {
  M.modo = sget("modo:") === "paginas" ? "paginas" : "tira";
  M.pagina = Number(sget("pagina:")) || 0;
}

export async function screen(ctx) {
  const route = (ctx && ctx.route) || { name: "main", params: {} };
  const inputs = (ctx && ctx.state && ctx.state.inputs) || {};
  restaurarListas();
  cargarAjustesLector();
  const nombre = route.name || "main";
  // El trabajo pendiente se deriva del route y del almacenamiento; si lo hay,
  // la vista pide un temporizador "every" y un ticke ejecuta UNA tarea.
  const tareas = atrapar(() => tareasParaRuta(route)) || [];
  M.pendiente = tareas.length > 0;
  // La barra de carga: se reinicia al cambiar de ruta o cuando ya no falta nada,
  // y su reloj de espera arranca de nuevo cuando cambia el lote de tareas.
  const claveRuta = nombre + "|" + JSON.stringify(route.params || {});
  const claves = tareas.map((x) => x.clave).sort().join(",");
  if (claveRuta !== M.ruta || !tareas.length) {
    M.ruta = claveRuta;
    M.claves = "";
    M.prog = 0;
    M.t0 = 0;
  } else if (claves !== M.claves) {
    M.claves = claves;
    M.t0 = Date.now();
  }
  let vista;
  if (nombre === "detail") vista = vistaDetalle(route.params || {});
  else if (nombre === "read") vista = vistaLector(route.params || {});
  else if (nombre === "genero") vista = vistaGenero(route.params || {});
  else vista = vistaPrincipal(inputs, tabDe(ctx));
  if (tareas.length) vista.every = { ms: 1500, event: "tick" };
  return vista;
}

// La pestaña activa: la que quedó en el estado (lo que Kino guardó) o la memoria.
function tabDe(ctx) {
  const guardada = ctx && ctx.state ? ctx.state.tab : null;
  if (typeof guardada === "string" && TABS.some((t) => t.value === guardada)) {
    M.tab = guardada;
    return guardada;
  }
  return M.tab;
}

async function unTick(route) {
  // Una tarea por ticke (nunca lanza: 3 fallos seguidos apagan el temporizador).
  const tareas = atrapar(() => tareasParaRuta(route)) || [];
  const tarea = tareas[0];
  if (!tarea) return null;
  if (enEspera(tarea.clave)) return null; // aún en espera tras un fallo: sin red
  try {
    await ejecutar(tarea);
    delete M.fallos[tarea.clave];
  } catch (err) {
    fallar(tarea.clave, err);
    M.rev++;
    const f = M.fallos[tarea.clave];
    if (f && f.intentos >= MAX_INTENTOS) {
      // Se rindió: avísale a la persona (la vista también muestra el botón Reintentar).
      return { state: { rev: M.rev }, toast: "No se pudo cargar: " + f.msg };
    }
    return { state: { rev: M.rev } };
  }
  M.rev++;
  // Devolver state rev obliga a Kino a llamar screen() otra vez: ahí se decide
  // si sigue habiendo temporizador (tareas pendientes) o no.
  return { state: { rev: M.rev } };
}

async function hacerBusqueda(q) {
  const texto = String(q || "").trim().slice(0, 60);
  if (!texto) return { toast: "Escribe algo para buscar" };
  try {
    const html = await get(BASE + "/en/search?keyword=" + encodeURIComponent(texto));
    const items = parseTarjetas(html, "_card_item").slice(0, 24);
    sset("bus", { q: texto, items: items }, TTL_SECCION);
    M.qHecha = texto;
    M.rev++;
    return { state: { rev: M.rev } };
  } catch (err) {
    return { toast: "No se pudo buscar: " + String((err && err.message) || err).slice(0, 80), toastEn: "Search failed" };
  }
}

function partirLector(arg) {
  const partes = String(arg || "").split("|");
  const t = partes[0] || "";
  const e = partes[1] || "";
  const src = partes[2] ? atrapar(() => decodeURIComponent(partes[2])) || "" : "";
  return { t: t, e: e, src: src };
}

export async function screenEvent(ev) {
  const nombre = (ev && ev.name) || "";
  const arg = ev && typeof ev.arg === "string" ? ev.arg : "";
  const value = ev && typeof ev.value === "string" ? ev.value : ev && ev.value;
  const estado = (ev && ev.state) || {};
  cargarAjustesLector();

  if (nombre === "tick") return unTick(ev && ev.route);

  if (nombre === "open") {
    // El primer pintado pidió los datos; aquí solo forzamos un redibujado.
    M.rev++;
    return { state: { rev: M.rev } };
  }

  if (nombre === "tab") {
    const v = typeof value === "string" ? value : arg;
    if (v && TABS.some((t) => t.value === v)) {
      M.tab = v;
      M.rev++;
      // El valor de las pestañas no vive en state.inputs: lo guardamos nosotros.
      return { state: { tab: v, rev: M.rev } };
    }
    return null;
  }

  if (nombre === "buscar") {
    const q = (typeof value === "string" && value) || (typeof arg === "string" && arg) ||
      (estado.inputs && estado.inputs.q) || "";
    return hacerBusqueda(q);
  }

  if (nombre === "detalle") {
    const partes = String(arg || "").split("|");
    const t = partes[0];
    const href = partes[1] ? atrapar(() => decodeURIComponent(partes[1])) || "" : "";
    if (!t) return null;
    const ya = sget("d:" + t);
    return { route: { push: "detail", params: { t: t, href: href || (ya && ya.href) || "" } } };
  }

  if (nombre === "genero") {
    const g = String(arg || SEMILLAS[0]);
    return { route: { push: "genero", params: { g: g } } };
  }

  if (nombre === "leer") {
    const d = partirLector(arg);
    if (!d.t || !d.e) return null;
    const path = d.src || "";
    return { route: { push: "read", params: { t: d.t, e: d.e, p: path } } };
  }

  if (nombre === "caps") {
    const partes = String(arg || "").split("|");
    const t = partes[0];
    const p = partes[1] || "1";
    if (!t) return null;
    // Pide la página de capítulos: la tarea queda anotada en storage y la
    // ejecuta el siguiente ticke (así screen() la ve al redibujar).
    sset("pgpend:", { t: t, p: parseInt(p, 10) || 1 });
    M.rev++;
    return { state: { rev: M.rev } };
  }

  if (nombre === "fav") {
    const t = String(arg || "");
    if (!t) return null;
    const det = sget("d:" + t) || {};
    const puesto = alternarFav({ t: t, titulo: det.titulo || t, poster: det.poster || "", genre: det.genre || "", href: det.href || "" });
    M.rev++;
    return { state: { rev: M.rev }, toast: puesto ? "Guardado en favoritos" : "Quitado de favoritos" };
  }

  if (nombre === "volver") return { route: { pop: true } };

  if (nombre === "modo") {
    M.modo = M.modo === "paginas" ? "tira" : "paginas";
    M.pagina = 0;
    sset("modo:", M.modo);
    sset("pagina:", 0);
    M.rev++;
    return { state: { rev: M.rev } };
  }

  if (nombre === "reintentar") {
    M.fallos = {};
    M.rev++;
    return { state: { rev: M.rev } };
  }

  if (nombre === "scroll" || nombre === "pag") {
    const v = sget("v:");
    if (!v) return null;
    if (nombre === "pag" && typeof value === "number") { M.pagina = value; sset("pagina:", value); }
    let intra = 0;
    if (nombre === "scroll" && typeof value === "number") intra = value;
    else if (nombre === "pag") {
      const por = tieneWidget("pageView") ? 24 : 8;
      const base = Math.floor((M.pagina || 0) / por) * por;
      intra = v.images.length ? Math.min(1, (base + (M.pagina || 0) % por + 1) / v.images.length) : 0;
    }
    const det = sget("d:" + v.t);
    const caps = capsActuales(v.t);
    const idx = caps ? caps.findIndex((c) => String(c.n) === String(v.e)) : -1;
    const frac = caps && caps.length && idx >= 0 ? Math.min(0.99, (idx + Math.max(0, Math.min(1, intra))) / caps.length) : 0;
    if (hayProgress()) {
      try {
        await kino.progress.set({
          id: "webtoon-" + v.t,
          title: det ? det.titulo : "",
          label: "Cap. " + v.e,
          labelEn: "Ch. " + v.e,
          poster: det ? det.poster : "",
          fraction: frac,
          resume: { t: v.t, e: v.e, src: v.src || "" }
        });
      } catch (err) { /* best effort */ }
    }
    const arr = leerLista("hist").map((h) => (h.t === v.t ? Object.assign({}, h, { frac: frac, cap: v.e, p: v.src || h.p }) : h));
    escribirLista("hist", arr);
    sun("pl:");
    return null;
  }

  return null;
}
