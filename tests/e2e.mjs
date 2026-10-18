// Pruebas de regresión de Pichanga.app (Node + Playwright, sin dependencias nuevas).
// Uso: node tests/e2e.mjs   → imprime una línea por prueba y termina con código ≠ 0 si alguna falla.
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// La app se sirve por http (como en GitHub Pages): con file:// Chromium a veces pierde lo guardado al recargar
const servidor = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, "http://x").pathname.slice(1)) || "index.html", f = path.join(ROOT, rel);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  const tipos = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml" };
  res.writeHead(200, { "content-type": tipos[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => servidor.listen(0, "127.0.0.1", r));
servidor.unref();
const FILE = `http://127.0.0.1:${servidor.address().port}/index.html`;
const KEY = "pichanga-v1";
const SOLO = process.argv[2] ? new RegExp(process.argv[2], "i") : null;

let pasan = 0, fallan = 0;
const browser = await chromium.launch();
// Todo tiene límite de tiempo: ninguna prueba se queda colgada y la suite termina siempre
const LIMITE_PRUEBA = 40000, LIMITE_TOTAL = 170000;
setTimeout(() => { console.log(`\n⏱️ La suite superó ${LIMITE_TOTAL / 1000} s: se corta. ${pasan} pasan, ${fallan} fallan (incompleta)`); process.exit(2); }, LIMITE_TOTAL).unref();

function ok(cond, msg) { if (!cond) throw new Error(msg); }
function igual(a, b, msg) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`${msg}: esperaba ${jb}, obtuve ${ja}`);
}
// Las pruebas se registran y después corren de a varias en paralelo (contextos aislados del mismo navegador);
// los resultados se imprimen en el orden en que están escritas.
const PRUEBAS = [], PARALELO = +process.env.PARALELO || 4;
function prueba(nombre, fn) { if (!SOLO || SOLO.test(nombre)) PRUEBAS.push({ nombre, fn }); }
async function correr1({ nombre, fn }) {
  const abiertas = [];
  try {
    let reloj;
    await Promise.race([
      fn((estado, opts) => abrir(estado, opts).then((t) => (abiertas.push(t), t))),
      new Promise((_, no) => { reloj = setTimeout(() => no(new Error(`la prueba superó ${LIMITE_PRUEBA / 1000} s`)), LIMITE_PRUEBA); }),
    ]).finally(() => clearTimeout(reloj));
    for (const t of abiertas) ok(!t.errores.length, "errores en la página: " + t.errores.join(" | "));
    pasan++; return `✔ ${nombre}`;
  } catch (e) {
    fallan++; return `✘ ${nombre}\n    ${String(e.message || e).split("\n").slice(0, process.env.DEBUG ? 25 : 1).join("\n    ")}`;
  } finally {
    for (const t of abiertas) await t.ctx.close().catch(() => {});
  }
}
async function correrTodas() {
  const salida = new Array(PRUEBAS.length);
  let sig = 0, impreso = 0;
  const imprimir = () => { while (impreso < salida.length && salida[impreso] != null) console.log(salida[impreso++]); };
  await Promise.all(Array.from({ length: PARALELO }, async () => {
    while (sig < PRUEBAS.length) { const i = sig++; salida[i] = await correr1(PRUEBAS[i]); imprimir(); }
  }));
}

// Abre la app con un estado guardado (o vacía). Devuelve helpers para manejarla.
async function abrir(estado, { width = 390, height = 844, url = FILE } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: true, serviceWorkers: "block" });
  ctx.setDefaultTimeout(5000); ctx.setDefaultNavigationTimeout(10000);
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const page = await ctx.newPage();
  const t = { ctx, page, errores: [], dialogos: [], respuestas: [] };
  page.on("pageerror", (e) => t.errores.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|ERR_|fonts/.test(m.text())) t.errores.push(m.text()); });
  page.on("dialog", async (d) => { t.dialogos.push(d.message()); const r = t.respuestas.length ? t.respuestas.shift() : true; if (r) await d.accept(); else await d.dismiss(); });
  await page.addInitScript(([k, s]) => {
    window.__wa = [];
    window.open = (u) => { window.__wa.push(decodeURIComponent(String(u).split("text=")[1] || "")); return null; };
    if (s != null && !localStorage.getItem("__sembrado")) { localStorage.setItem("__sembrado", "1"); localStorage.setItem(k, typeof s === "string" ? s : JSON.stringify(s)); }
  }, [KEY, estado ?? null]);
  await page.goto(url);
  Object.assign(t, {
    S: () => page.evaluate((k) => { window.guardarYa?.(); return JSON.parse(localStorage.getItem(k)); }, KEY),
    ir: async (tab) => { await t.hoja(); await page.click(`nav.tabs button[data-go="s-${tab}"]`); },
    wa: () => page.evaluate(() => window.__wa),
    txt: (sel) => page.locator(sel).first().innerText(),
    toast: (texto) => page.waitForFunction((x) => { const e = document.getElementById("toast"); return e.classList.contains("show") && e.textContent.includes(x); }, texto, { timeout: 3000 }),
    sinToast: () => page.evaluate(() => { const e = document.getElementById("toast"); clearTimeout(window.__t); e.classList.remove("show"); }),
    // La app ignora toques en una hoja recién abierta (protección de doble toque): se espera como lo haría una persona
    // ...y también los toques justo después de cerrarla (el segundo toque de un doble toque cae en la pantalla)
    // (y el ↩️ Deshacer recién aparecido, por la misma razón)
    hoja: () => page.waitForFunction(() => (document.getElementById("sheet").open ? Date.now() - (window.sheet.abierta || 0) : Date.now() - (window.cerrarSheet.at || 0)) >= 460
      && Date.now() - (window.toast.desde || 0) >= 460, null, { timeout: 3000 }),
    tap: async (sel) => { await t.hoja(); await page.locator(sel).first().click(); },
  });
  return t;
}

const J = (n, p = "J") => Array.from({ length: n }, (_, i) => p + String(i + 1).padStart(2, "0"));
// Estado con la forma actual (v3)
const base = (x = {}) => Object.assign({
  v: 3, fecha: "2026-10-17", hora: "20:00", lugar: "Complejo El Campito", porLado: 7,
  inscritos: [], caseros: ["Carlos", "Seba"], niveles: {}, equipos: { A: [], B: [] },
  colorA: "⚫ Negro", colorB: "🟢 Peto Flúor",
  banco: { nombre: "", rut: "", banco: "", tipo: "", cuenta: "", mail: "", link: "", qr: "" },
  costoCancha: "", costoTercer: "", pagos: {}, tercer: {}, deudas: {}, ultimaLista: [],
  post: { golesA: 0, golesB: 0, mvp: "", goleador: "", rustico: "", guardadoId: null }, historial: [],
}, x);
// Estado con la forma antigua (commit 99372cf), tal como lo puede tener guardado el organizador
const VIEJO = {
  fecha: "2026-10-10", hora: "21:00", lugar: "Cancha Los Leones", porLado: 3,
  inscritos: ["Ana", "Beto", "Caro", "Dani", "Eli", "Fede", "Gabi"],
  caseros: ["Carlos", "Seba", "Nico", "Mati", "Mako", "Ana", "Beto", "Caro", "Dani", "Eli", "Fede", "Gabi"],
  niveles: { Ana: 5, Beto: 2 }, equipos: { A: ["Ana", "Caro", "Eli"], B: ["Beto", "Dani", "Fede"] },
  colorA: "🔴 Rojo", colorB: "🔵 Azul",
  banco: { nombre: "Juan Pérez", rut: "12.345.678-9", banco: "BancoEstado", tipo: "CuentaRUT", cuenta: "123", mail: "", link: "", qr: "" },
  costoCancha: "42.000", costoTercer: "12000",
  pagado: { Ana: true, Beto: true, Zeta: true }, tercer: { Ana: true }, morosos: { Pablo: true, Caro: true, Nadie: false },
  post: { golesA: 2, golesB: 1, mvp: "Ana" },
  historial: [{ id: 111, fecha: "2026-10-03", lugar: "X", golesA: 1, golesB: 1, colorA: "⚫ Negro", colorB: "🟢 Peto Flúor", A: ["Ana"], B: ["Beto"], mvp: "Ana", goleador: "", rustico: "" }],
};
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
// Ya no se ve un ↩️ Deshacer (ni se puede apretar): el aviso se fue o es uno sin botón
async function sinDeshacer(t, cuando) {
  await esperar(350); // la salida del aviso dura .25 s
  const v = await t.page.evaluate(() => {
    const e = document.getElementById("toast"), b = e.querySelector(".tbtn");
    return { boton: !!(b && e.classList.contains("show") && b.getBoundingClientRect().bottom > 0), accion: !!window.toast.accion, txt: e.textContent };
  });
  ok(!v.boton && !v.accion, `${cuando}: sigue el ↩️ de antes (“${v.txt}”)`);
}
const BAJA = 500; // pausa entre bajas (protección de doble toque)

/* ================= Migración ================= */
await prueba("Migración: datos con la forma antigua se convierten sin perder nada", async (abrir) => {
  const t = await abrir(VIEJO);
  const S = await t.S();
  igual(S.v, 5, "versión");
  for (const k of ["fecha", "hora", "lugar", "porLado", "inscritos", "caseros", "niveles", "equipos", "colorA", "colorB", "banco"]) igual(S[k], VIEJO[k], k);
  igual(S.costoCancha, "42000", "costo cancha con punto de miles");
  igual(S.costoTercer, "12000", "costo tercer tiempo");
  igual(S.tercer, VIEJO.tercer, "🍻 marcados");
  igual(S.deudas.Pablo, [{ fecha: "", concepto: "Deuda anterior", monto: null }], "moroso Pablo → libreta");
  ok(S.deudas.Caro && !S.deudas.Nadie, "Caro con deuda, Nadie (false) sin deuda");
  igual(S.pagos.Ana.monto, 19000, "Ana pagado → $7.000 cancha + $12.000 🍻");
  igual(S.pagos.Beto.monto, 7000, "Beto pagado → $7.000");
  igual(S.deudas.Zeta, [{ fecha: "2026-10-10", concepto: "Pagó y no jugó (a favor)", monto: -7000 }], "Zeta pagó y ya no está: queda a favor");
  ok(!("morosos" in S) && !("pagado" in S), "claves antiguas reemplazadas");
  igual([S.post.golesA, S.post.golesB, S.post.mvp, S.post.guardadoId], [2, 1, "Ana", null], "post");
  igual(S.historial[0].id, 111, "historial intacto");
  igual(S.historial[0].mvp, "Ana", "historial premio");
  const copia = await t.page.evaluate((k) => localStorage.getItem(k + "-antes-v5"), KEY);
  igual(JSON.parse(copia), VIEJO, "copia intacta de los datos antiguos");
  igual(await t.page.inputValue("#hora"), "21:00", "hora en pantalla");
  ok((await t.txt("#titulares")).includes("Caro ⚠️ debe"), "⚠️ de Caro en Convocatoria");
  await t.ir("pagos");
  igual(await t.page.inputValue("#costoCancha"), "42.000", "cancha formateada");
  igual(await t.page.inputValue("#bNombre"), "Juan Pérez", "datos bancarios");
  ok((await t.txt("#pagos")).includes("✅ PAGADO"), "Ana sigue pagada");
  const d = await t.txt("#deudas");
  ok(d.includes("Pablo") && d.includes("Caro"), "deudores visibles en Pagos");
  await t.ir("post");
  igual(await t.page.inputValue("#aMvp"), "Ana", "MVP sin guardar se conserva");
  await t.ir("equipos");
  igual(await t.txt("#vsTxt"), "3 vs 3", "equipos intactos");
  // Recargar no vuelve a migrar ni pisa la copia
  await t.page.reload();
  igual((await t.S()).deudas.Pablo.length, 1, "migración idempotente");
});

await prueba("Migración: faltan claves anidadas o vienen dañadas", async (abrir) => {
  const t = await abrir({ inscritos: ["Ana", "Ana", 7], colorA: "🟣 Morado", post: null, banco: { nombre: "X" }, porLado: "9", historial: [{ fecha: "2026-10-01", golesA: 1, golesB: 0 }, null], equipos: null, deudas: { Leo: [{ fecha: "2026-10-01", concepto: "Cancha", monto: "5000" }], Vacio: [] } });
  const S = await t.S();
  igual(S.inscritos, ["Ana"], "inscritos sin duplicados ni basura");
  igual(S.colorA, "⚫ Negro", "color inválido → por defecto");
  igual(Object.keys(S.banco).sort(), ["banco", "cuenta", "link", "mail", "nombre", "qr", "rut", "tipo"], "banco completo");
  igual(S.banco.nombre, "X", "banco conserva el nombre");
  igual(S.porLado, 9, "porLado numérico");
  igual(S.historial.length, 1, "historial válido");
  igual([S.historial[0].A, S.historial[0].B], [[], []], "historial con equipos");
  igual(S.deudas, { Leo: [{ fecha: "2026-10-01", concepto: "Cancha", monto: 5000 }] }, "libreta saneada");
  for (const tab of ["equipos", "pagos", "post", "convocatoria"]) await t.ir(tab);
});

await prueba("Migración: datos ilegibles no se pierden (se respaldan) y la app abre", async (abrir) => {
  const t = await abrir("{malo");
  igual(await t.page.evaluate((k) => localStorage.getItem(k + "-danado"), KEY), "{malo", "copia del dato dañado");
  igual((await t.S()).v, 5, "estado nuevo");
});

await prueba("Migración: restaurar un respaldo antiguo (.json) lo convierte", async (abrir) => {
  const t = await abrir(base());
  const f = path.join(os.tmpdir(), `respaldo-viejo-${process.pid}.json`);
  fs.writeFileSync(f, JSON.stringify({ app: "pichanga", version: 1, fecha: "2026-10-01T00:00:00Z", datos: VIEJO }));
  await t.ir("post");
  await t.page.setInputFiles("#importar", f);
  await t.toast("Respaldo restaurado");
  const S = await t.S();
  fs.unlinkSync(f);
  igual(S.v, 5, "versión");
  ok(S.deudas.Pablo && S.pagos.Ana.monto === 19000, "morosos y pagos convertidos");
});

/* ================= B1 ================= */
await prueba("B1: '49.000' se entiende como 49 mil y se muestra formateado", async (abrir) => {
  const t = await abrir(base({ inscritos: J(14) }));
  await t.ir("pagos");
  await t.page.locator("#costoCancha").pressSequentially("49.000");
  igual(await t.page.inputValue("#costoCancha"), "49.000", "campo formateado");
  igual(await t.txt("#porCancha"), "$3.500", "cuota por persona");
  igual((await t.S()).costoCancha, "49000", "guardado en pesos");
  await t.page.fill("#costoCancha", "");
  await t.page.locator("#costoCancha").pressSequentially("49000");
  igual(await t.page.inputValue("#costoCancha"), "49.000", "49000 → 49.000");
  await t.page.click("#waCobrar");
  ok((await t.wa())[0].includes("J01: $3.500"), "cobro con $3.500");
  await t.page.reload();
  await t.ir("pagos");
  igual(await t.page.inputValue("#costoCancha"), "49.000", "persiste al recargar");
});

/* ================= B2 / F1 ================= */
const SEIS = ["Ana", "Beto", "Caro", "Dani", "Eli", "Fede"];
await prueba("B2/F1: Cerrar pichanga guarda el partido pendiente, anota deudas y prepara la próxima", async (abrir) => {
  const t = await abrir(base({ porLado: 3, inscritos: SEIS.slice(), caseros: SEIS.slice(), costoCancha: "30000", lugar: "Cancha 3", hora: "21:00" }));
  await t.ir("equipos"); await t.tap("#azar");
  await t.ir("post");
  for (let i = 0; i < 3; i++) await t.tap('[data-gol="A,1"]');
  await t.tap('[data-gol="B,1"]');
  await t.page.selectOption("#aMvp", "Ana");
  await t.ir("pagos");
  for (const n of SEIS.slice(1)) await t.tap(`.state[data-pay="${n}"]`);
  await t.tap(".screen.active [data-cerrar]");
  ok(await t.page.locator("#sheet[open]").isVisible(), "se abre la hoja de cierre");
  ok(await t.page.isChecked("#cGuardar"), "guardar marcado por defecto");
  ok(await t.page.isChecked("#cDeudas"), "anotar deudas marcado");
  igual(await t.page.inputValue("#cFecha"), "2026-10-24", "próxima fecha +7 días");
  await t.tap("#cOk");
  await t.toast("Pichanga cerrada");
  const S = await t.S();
  igual(S.historial.length, 1, "partido guardado");
  igual([S.historial[0].golesA, S.historial[0].golesB, S.historial[0].mvp, S.historial[0].fecha], [3, 1, "Ana", "2026-10-17"], "resultado y premio");
  igual(S.post, { golesA: 0, golesB: 0, mvp: "", goleador: "", rustico: "", guardadoId: null, fecha: "", votoLista: [] }, "marcador y premios limpios");
  igual(S.deudas.Ana, [{ fecha: "2026-10-17", concepto: "Cancha", monto: 5000 }], "deuda de Ana con monto y fecha");
  igual([S.fecha, S.hora, S.lugar, S.costoCancha, S.costoTercer], ["2026-10-24", "21:00", "Cancha 3", "30000", ""], "próxima fecha con la misma hora, lugar y costo");
  igual([S.inscritos, S.pagos, S.tercer, S.equipos], [[], {}, {}, { A: [], B: [] }], "lista y pagos limpios");
  ok(await t.page.locator("#s-convocatoria.active").isVisible(), "vuelve a Convocatoria");
  igual(await t.page.inputValue("#fecha"), "2026-10-24", "fecha en pantalla");
  ok(await t.page.locator("#mismaLista").isVisible(), "botón 🔁 Misma lista");
  await t.sinToast();
  await t.tap("#mismaLista");
  igual((await t.S()).inscritos, SEIS, "misma lista y mismo orden");
  ok((await t.txt("#titulares")).includes("Ana ⚠️ $5.000"), "Ana aparece con su deuda");
  await t.ir("equipos"); await t.tap("#azar");
  await t.ir("post");
  igual([await t.txt("#golesA"), await t.txt("#golesB"), await t.page.inputValue("#aMvp")], ["0", "0", ""], "sin marcador ni MVP fantasma");
});

await prueba("B2: cerrar sin guardar el resultado no lo arrastra a la fecha siguiente", async (abrir) => {
  const t = await abrir(base({ porLado: 3, inscritos: SEIS.slice(), equipos: { A: SEIS.slice(0, 3), B: SEIS.slice(3) }, post: { golesA: 0, golesB: 2, mvp: "Beto", goleador: "", rustico: "", guardadoId: null } }));
  await t.ir("pagos"); await t.tap(".screen.active [data-cerrar]");
  await t.hoja(); await t.page.uncheck("#cGuardar");
  await t.tap("#cOk");
  const S = await t.S();
  igual(S.historial.length, 0, "no se guardó");
  igual([S.post.golesB, S.post.mvp], [0, ""], "post limpio");
});

await prueba("F1: un 0-0 sin premios no se guarda por defecto; deshacer el cierre lo devuelve todo", async (abrir) => {
  const t = await abrir(base({ porLado: 3, inscritos: SEIS.slice(), equipos: { A: SEIS.slice(0, 3), B: SEIS.slice(3) }, costoCancha: "30000", pagos: { Ana: { monto: 5000, fecha: "2026-10-16" } } }));
  const antes = await t.S();
  await t.ir("post"); await t.tap(".screen.active [data-cerrar]");
  ok(!(await t.page.isChecked("#cGuardar")), "0-0 sin premios: no marcado");
  ok((await t.txt("#sheet")).includes("Está 0–0 y sin premios"), "avisa del 0-0");
  await t.page.fill("#cFecha", "2026-10-25");
  await t.tap("#cOk");
  const S = await t.S();
  igual(S.fecha, "2026-10-25", "fecha elegida");
  igual(Object.keys(S.deudas).length, 5, "5 deudores anotados");
  await t.tap("#toast .tbtn");
  igual(await t.S(), antes, "deshacer restaura el estado completo");
  igual(await t.page.inputValue("#fecha"), "2026-10-17", "campos restaurados");
});

await prueba("F1: Cerrar sin inscritos solo avisa", async (abrir) => {
  const t = await abrir(base());
  await t.ir("pagos"); await t.tap(".screen.active [data-cerrar]");
  await t.toast("No hay nada que cerrar");
  ok(!(await t.page.locator("#sheet[open]").count()), "no abre la hoja");
});

/* ================= B3 ================= */
await prueba("B3: doble toque en Guardar partido no duplica; un cambio actualiza el mismo partido", async (abrir) => {
  const t = await abrir(base({ porLado: 3, inscritos: SEIS.slice(), equipos: { A: SEIS.slice(0, 3), B: SEIS.slice(3) }, post: { golesA: 3, golesB: 1, mvp: "", goleador: "", rustico: "", guardadoId: null } }));
  await t.ir("post");
  await t.page.dblclick("#guardarPartido");
  await t.page.click("#guardarPartido", { force: true }); // ya guardado (aria-disabled): otro toque no duplica
  let S = await t.S();
  igual(S.historial.length, 1, "un solo partido");
  igual([S.historial[0].golesA, S.historial[0].golesB], [3, 1], "marcador");
  igual(await t.txt("#guardarPartido"), "✅ Partido guardado", "botón queda como guardado");
  igual(await t.txt("#golesA"), "3", "el marcador sigue a la vista");
  await t.tap('[data-gol="A,1"]');
  igual(await t.txt("#guardarPartido"), "💾 Actualizar partido guardado", "detecta el cambio");
  await t.tap("#guardarPartido");
  S = await t.S();
  igual([S.historial.length, S.historial[0].golesA], [1, 4], "actualiza sin duplicar");
  igual([await t.txt("#kA"), await t.txt("#kE")], ["1", "0"], "tabla del mes: 1 victoria de A, sin empates fantasma");
});

await prueba("B3: un partido igual guardado antes (sin marca) se reemplaza con confirmación", async (abrir) => {
  const eq = { A: SEIS.slice(0, 3), B: SEIS.slice(3) };
  const t = await abrir(base({ porLado: 3, inscritos: SEIS.slice(), equipos: eq, post: { golesA: 2, golesB: 0 }, historial: [{ id: 5, fecha: "2026-10-17", golesA: 1, golesB: 0, A: eq.A, B: eq.B, colorA: "⚫ Negro", colorB: "🟢 Peto Flúor" }] }));
  await t.ir("post"); await t.tap("#guardarPartido");
  ok(t.dialogos[0] && t.dialogos[0].includes("Reemplazarlo"), "pide confirmación");
  const S = await t.S();
  igual([S.historial.length, S.historial[0].golesA, S.historial[0].id], [1, 2, 5], "reemplazado");
});

await prueba("B3: guardar un 0-0 sin premios pide confirmación", async (abrir) => {
  const t = await abrir(base({ porLado: 3, inscritos: SEIS.slice(), equipos: { A: SEIS.slice(0, 3), B: SEIS.slice(3) } }));
  await t.ir("post");
  t.respuestas.push(false);
  await t.tap("#guardarPartido");
  ok(t.dialogos[0] && t.dialogos[0].includes("0–0 sin premios"), "pregunta");
  igual((await t.S()).historial.length, 0, "cancelar no guarda");
  await t.tap("#guardarPartido");
  igual((await t.S()).historial.length, 1, "aceptar guarda");
});

/* ================= B4 / F2 ================= */
await prueba("B4: un deudor que no juega se ve en Pagos, se puede saldar y deja de salir en el cobro", async (abrir) => {
  const t = await abrir(base({ porLado: 3, inscritos: ["Beto", "Caro"], costoCancha: "20000", pagos: { Beto: { monto: 10000, fecha: "" }, Caro: { monto: 10000, fecha: "" } }, deudas: { Ana: [{ fecha: "2026-10-10", concepto: "Cancha", monto: 10000 }] } }));
  await t.ir("pagos");
  ok((await t.txt("#deudas")).includes("Ana"), "Ana en Deudas pendientes");
  await t.tap("#waCobrar");
  ok((await t.wa())[0].includes("• Ana: $10.000 (10/10)"), "cobro con monto y fecha");
  await t.tap('[data-saldar="Ana"]');
  await t.tap("#sOk");
  await t.toast("quedó al día");
  igual((await t.S()).deudas, {}, "deuda saldada");
  ok((await t.txt("#deudas")).includes("Nadie debe nada"), "lista vacía");
  await t.sinToast();
  await t.tap("#waCobrar");
  await t.toast("Todos pagaron");
  igual((await t.wa()).length, 1, "no se envía otro cobro");
});

await prueba("B4: al cerrar se guarda cuánto debe cada uno (con 🍻) y se acumula", async (abrir) => {
  const four = ["Ana", "Beto", "Caro", "Dani"];
  const t = await abrir(base({ porLado: 3, inscritos: four, costoCancha: "40000", costoTercer: "9000", tercer: { Ana: true }, deudas: { Ana: [{ fecha: "2026-10-10", concepto: "Cancha", monto: 10000 }] } }));
  await t.ir("pagos");
  for (const n of four.slice(1)) await t.tap(`.state[data-pay="${n}"]`);
  ok(t.dialogos.length === 0, "sin preguntas para quien no debe");
  await t.tap(".screen.active [data-cerrar]"); await t.tap("#cOk");
  const S = await t.S();
  igual(S.deudas.Ana.map((e) => e.monto), [10000, 19000], "deudas acumuladas");
  ok(S.deudas.Ana[1].concepto.includes("🍻"), "concepto con 🍻");
  await t.page.evaluate(() => { S.inscritos = ["Beto"]; S.costoCancha = ""; save(); });
  await t.page.reload(); await t.ir("pagos"); await t.tap("#waCobrar");
  ok((await t.wa())[0].includes("• Ana: $29.000 (10/10 $10.000 · 17/10 $19.000)"), "cobro con el detalle por fecha");
});

await prueba("B4: si alguien se baja después de que otros pagaron, la diferencia no se pierde", async (abrir) => {
  const t = await abrir(base({ porLado: 3, inscritos: ["Ana", "Beto", "Caro"], costoCancha: "30000" }));
  await t.ir("pagos");
  await t.tap('.state[data-pay="Beto"]'); await t.tap('.state[data-pay="Caro"]');
  await t.ir("convocatoria"); await t.tap('[data-del="Ana"]');
  await t.ir("pagos");
  const p = await t.txt("#pagos");
  ok(p.includes("pagó $10.000") && p.includes("falta $5.000"), "muestra pagó/falta");
  ok((await t.txt("#recaudado")).includes("$20.000 de $30.000"), "recaudado");
  await t.tap("#waCobrar");
  ok((await t.wa())[0].includes("⏳ Beto: $5.000 (ya pagó $10.000)"), "cobra la diferencia");
  await t.tap(".screen.active [data-cerrar]"); await t.tap("#cOk");
  const S = await t.S();
  igual([S.deudas.Beto[0].monto, S.deudas.Caro[0].monto, S.deudas.Ana], [5000, 5000, undefined], "deudas por la diferencia");
});

await prueba("B4: con cancha en $0 no se cobra ni se anota a nadie como deudor", async (abrir) => {
  const t = await abrir(base({ porLado: 3, inscritos: ["Ana", "Beto"] }));
  await t.ir("pagos"); await t.tap("#waCobrar");
  await t.toast("costo de la cancha");
  igual((await t.wa()).length, 0, "no abre WhatsApp");
  await t.tap(".screen.active [data-cerrar]");
  ok((await t.txt("#sheet")).includes("Sin costo de cancha"), "lo explica");
  await t.tap("#cOk");
  igual((await t.S()).deudas, {}, "sin deudores");
});

/* ================= B5 ================= */
await prueba("B5: se guarda el monto pagado; si se suma el 🍻 después, aparece lo que falta", async (abrir) => {
  const t = await abrir(base({ inscritos: ["Ana", "Beto", ...J(12)], costoCancha: "49000" }));
  await t.ir("pagos");
  await t.tap('.state[data-pay="Ana"]');
  igual((await t.S()).pagos.Ana.monto, 3500, "monto guardado");
  await t.page.locator("#costoTercer").pressSequentially("20000");
  await t.tap('[data-beer="Ana"]'); await t.tap('[data-beer="Beto"]');
  await esperar(BAJA); // fuera de la ventana de doble toque
  const fila = await t.txt('#pagos li:has([data-pay="Ana"])');
  ok(fila.includes("pagó $3.500") && fila.includes("falta $10.000"), "pagó/falta: " + fila.replace(/\n/g, " "));
  await t.tap("#waCobrar");
  ok((await t.wa())[0].includes("⏳ Ana: $10.000 (ya pagó $3.500, incluye 🍻)"), "Ana sigue en el cobro");
  await t.tap('.state[data-pay="Ana"]');
  igual((await t.S()).pagos.Ana.monto, 13500, "completa lo que faltaba");
});

await prueba("B5: pagado y 🍻 no quedan pegados al nombre al rearmar la lista", async (abrir) => {
  const t = await abrir(base({ porLado: 3, inscritos: ["Ana", "Beto", "Caro"], caseros: ["Ana", "Beto", "Caro"], costoCancha: "30000" }));
  await t.ir("pagos");
  await t.tap('[data-beer="Ana"]'); await t.tap('.state[data-pay="Ana"]');
  await t.ir("convocatoria");
  for (const n of ["Ana", "Beto", "Caro"]) { await t.tap(`[data-del="${n}"]`); await esperar(BAJA); }
  await t.tap('.chip[data-add="Ana"]'); await t.tap('.chip[data-add="Beto"]');
  const S = await t.S();
  ok(!S.pagos.Ana && !S.tercer.Ana, "Ana parte sin pagar y sin 🍻");
  igual(S.deudas.Ana, [{ fecha: S.deudas.Ana[0].fecha, concepto: "Pagó y no jugó (a favor)", monto: -10000 }], "su pago quedó como saldo a favor");
  await t.ir("pagos");
  ok(!(await t.txt("#pagos")).includes("PAGADO"), "nadie aparece PAGADO");
  ok((await t.txt("#deudas")).includes("Saldo a favor"), "saldo a favor visible");
});

await prueba("B5: bajar titulares que pagaron con '−' pide confirmación", async (abrir) => {
  const t = await abrir(base({ porLado: 7, inscritos: J(14), costoCancha: "49000", pagos: { J13: { monto: 3500, fecha: "" }, J14: { monto: 3500, fecha: "" } } }));
  t.respuestas.push(false);
  await t.tap("#menos");
  ok(t.dialogos[0].includes("J13 y J14 ya pagaron"), "pregunta");
  igual((await t.S()).porLado, 7, "cancelar no cambia nada");
  await t.tap("#menos");
  const S = await t.S();
  igual([S.porLado, S.pagos, S.deudas.J13[0].monto], [6, {}, -3500], "pagos pasan a saldo a favor");
});

/* ================= B6 ================= */
await prueba("B6: monto de tercer tiempo sin nadie marcado 🍻 avisa y no desaparece en silencio", async (abrir) => {
  const t = await abrir(base({ inscritos: J(14), costoCancha: "49000", costoTercer: "20000" }));
  await t.ir("pagos");
  ok((await t.txt("#avisoTercer")).includes("$20.000 del tercer tiempo sin repartir"), "aviso visible");
  t.respuestas.push(false);
  await t.tap("#waCobrar");
  ok(t.dialogos[0].includes("sin repartir"), "confirma antes de cobrar");
  igual((await t.wa()).length, 0, "cancelado");
  await t.tap(".screen.active [data-cerrar]");
  ok((await t.txt("#sheet")).includes("sin repartir"), "aviso al cerrar");
  await t.page.keyboard.press("Escape");
  await t.tap('[data-beer="J01"]');
  ok(await t.page.locator("#avisoTercer").isHidden(), "aviso se va al marcar 🍻");
});

/* ================= B7 ================= */
await prueba("B7: doble toque en ✖ baja a uno solo y se puede deshacer en su lugar", async (abrir) => {
  const t = await abrir(base({ porLado: 5, inscritos: J(10) }));
  const x = t.page.locator('[data-del="J03"]');
  await x.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const b = await x.boundingBox();
  ok(b.width >= 44 && b.height >= 44, `✖ de 44px (${b.width}x${b.height})`);
  await t.page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await esperar(60);
  await t.page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  igual((await t.S()).inscritos, J(10).filter((n) => n !== "J03"), "solo se bajó J03");
  await t.toast("J03 se bajó");
  await t.tap("#toast .tbtn");
  igual((await t.S()).inscritos, J(10), "deshacer lo deja en su posición");
  await esperar(BAJA);
  await t.page.locator('[data-del="J04"]').dblclick();
  igual((await t.S()).inscritos.length, 9, "dblclick de mouse baja a uno");
});

await prueba("B7: Deshacer no pisa a alguien inscrito después de la baja", async (abrir) => {
  const t = await abrir(base({ porLado: 5, inscritos: J(6) }));
  await t.tap('[data-del="J03"]');
  await t.toast("J03 se bajó");
  await t.page.fill("#nuevo", "Nuevo"); await t.page.press("#nuevo", "Enter");
  // Inscribir a alguien es una acción nueva: el ↩️ de la baja se va (no puede deshacer lo último)
  await sinDeshacer(t, "inscribir después de la baja");
  const S = await t.S();
  ok(S.inscritos.includes("Nuevo") && !S.inscritos.includes("J03"), "se mantiene lo más nuevo");
});

/* ================= B8 ================= */
await prueba("B8: Armado Equilibrado da la menor diferencia y no manda a los mejores al arco", async (abrir) => {
  const lv = [5, 5, 4, 4, 3, 3, 3, 3, 3, 1, 1, 1, 1, 1];
  const niveles = Object.fromEntries(J(14).map((n, i) => [n, lv[i]]));
  const t = await abrir(base({ inscritos: J(14), niveles }));
  await t.ir("equipos");
  let ambos5 = 0;
  for (let i = 0; i < 20; i++) {
    await t.page.waitForTimeout(470); // un toque doble (< 450 ms) arma una sola vez: sin la pausa se cuenta el mismo reparto varias veces
    await t.page.click("#equilibrar");
    const { A, B } = (await t.S()).equipos;
    const s = (x) => x.reduce((a, n) => a + niveles[n], 0);
    igual([A.length, B.length, s(A), s(B)], [7, 7, 19, 19], `corrida ${i + 1}`);
    if (niveles[A[0]] === 5 && niveles[B[0]] === 5) ambos5++;
  }
  ok(ambos5 <= 3, `los dos nivel 5 al arco en ${ambos5}/20 corridas`);
  igual(await t.page.textContent("#balance"), "✔ Parejo", "medidor parejo");
});

await prueba("B8: casos chicos (3v3 y 5 jugadores) quedan parejos", async (abrir) => {
  const t = await abrir(base({ porLado: 3, inscritos: J(6), niveles: { J01: 4, J02: 4, J03: 3, J04: 3, J05: 3, J06: 1 } }));
  const r = await t.page.evaluate(() => Array.from({ length: 10 }, () => { const e = repartoParejo(titulares()); return [suma(e.A), suma(e.B)]; }));
  ok(r.every(([a, b]) => a === 9 && b === 9), "4,4,3,3,3,1 → 9-9: " + JSON.stringify(r));
  const r2 = await t.page.evaluate(() => { S.inscritos = ["a", "b", "c", "d", "e"]; Object.assign(S.niveles, { a: 3, b: 3, c: 2, d: 2, e: 2 }); return Array.from({ length: 10 }, () => { const e = repartoParejo(titulares()); return [e.A.length, suma(e.A), suma(e.B)]; }); });
  ok(r2.every(([n, a, b]) => n === 3 && a === 6 && b === 6), "3,3,2,2,2 → 6-6: " + JSON.stringify(r2));
});

await prueba("B8: siempre el óptimo (comparado con fuerza bruta) y rápido con 22 jugadores", async (abrir) => {
  const t = await abrir(base({ porLado: 11 }));
  const optimo = (lv) => {
    const n = lv.length, k = Math.ceil(n / 2), tot = lv.reduce((a, b) => a + b, 0); let best = Infinity;
    for (let m = 0; m < 1 << n; m++) {
      let c = 0, s = 0; for (let i = 0; i < n; i++) if (m & (1 << i)) { c++; s += lv[i]; }
      if (c === k) best = Math.min(best, Math.abs(tot - 2 * s));
    }
    return best;
  };
  let semilla = 7; const rnd = () => (semilla = (semilla * 16807) % 2147483647) / 2147483647;
  for (let caso = 0; caso < 40; caso++) {
    const n = 2 + Math.floor(rnd() * 15), lv = Array.from({ length: n }, () => 1 + Math.floor(rnd() * 5));
    const d = await t.page.evaluate((lv) => {
      S.inscritos = lv.map((_, i) => "p" + i); S.niveles = Object.fromEntries(lv.map((l, i) => ["p" + i, l]));
      const e = repartoParejo(titulares()); return Math.abs(suma(e.A) - suma(e.B));
    }, lv);
    igual(d, optimo(lv), `niveles ${lv.join(",")}`);
  }
  const ms = await t.page.evaluate(() => {
    S.inscritos = Array.from({ length: 22 }, (_, i) => "q" + i); S.inscritos.forEach((n, i) => (S.niveles[n] = 1 + (i * 7) % 5));
    const t0 = performance.now(); for (let i = 0; i < 10; i++) repartoParejo(titulares()); return (performance.now() - t0) / 10;
  });
  ok(ms < 50, `22 jugadores en ${ms.toFixed(1)} ms`);
});

/* ================= B9 ================= */
await prueba("B9: una selección vieja no provoca intercambios fantasma", async (abrir) => {
  const ocho = ["Ana", "Beto", "Caro", "Dani", "Eli", "Fede", "Gabi", "Hugo"];
  const t = await abrir(base({ porLado: 4, inscritos: ocho.slice(), equipos: { A: ["Ana", "Caro", "Eli", "Gabi"], B: ["Beto", "Dani", "Fede", "Hugo"] } }));
  await t.ir("equipos");
  await t.tap('.player[data-p="Ana"]');
  igual(await t.page.locator(".player.sel").count(), 1, "Ana seleccionada");
  await t.ir("convocatoria"); await t.tap('[data-del="Ana"]');
  await t.ir("equipos");
  await t.tap('.player[data-p="Caro"]');
  let S = await t.S();
  ok(!S.equipos.A.includes("Ana") && !S.equipos.B.includes("Ana"), "Ana no vuelve a la cancha");
  ok(S.equipos.A.includes("Caro"), "Caro no desaparece");
  igual(await t.page.locator('.player.sel[data-p="Caro"]').count(), 1, "el toque solo selecciona");
  // Tocar el pasto cancela la selección
  const pitch = await t.page.locator("#pitch").boundingBox();
  await t.page.mouse.click(pitch.x + 8, pitch.y + pitch.height / 2);
  igual(await t.page.locator(".player.sel").count(), 0, "pasto deselecciona");
  // Seleccionar, mezclar y tocar a otro: solo selecciona
  await t.tap('.player[data-p="Beto"]');
  await t.tap("#azar");
  const tras = (await t.S()).equipos;
  await t.tap('.player[data-p="Dani"]');
  igual((await t.S()).equipos, tras, "no deshace el armado recién hecho");
});

/* ================= B10 ================= */
await prueba("B10: al bajar el cupo los equipos se reacomodan y se avisa", async (abrir) => {
  const t = await abrir(base({ inscritos: J(14), equipos: { A: J(7), B: J(14).slice(7) } }));
  await t.tap("#menos"); await t.tap("#menos");
  await t.ir("equipos");
  igual(await t.txt("#vsTxt"), "5 vs 5", "5 vs 5");
  await t.toast("Equipos reajustados");
  const t2 = await abrir(base({ inscritos: J(14), equipos: { A: [...J(5), "J13", "J14"], B: J(12).slice(5) } }));
  await t2.tap("#menos"); await t2.ir("equipos");
  igual(await t2.txt("#vsTxt"), "6 vs 6", "6 vs 6");
  // Un desbalance hecho a mano (sin bajas) se respeta
  const t3 = await abrir(base({ porLado: 3, inscritos: J(6), equipos: { A: J(4), B: ["J05", "J06"] } }));
  await t3.ir("equipos");
  igual(await t3.txt("#vsTxt"), "4 vs 2", "no toca un armado manual");
});

/* ================= B11 ================= */
await prueba("B11: si se baja el premiado, el premio se borra y no se guarda", async (abrir) => {
  const t = await abrir(base({ porLado: 3, inscritos: SEIS.slice() }));
  await t.ir("equipos"); await t.tap("#azar");
  await t.ir("post"); await t.page.selectOption("#aMvp", "Fede");
  await t.ir("convocatoria"); await t.tap('[data-del="Fede"]');
  await t.ir("post");
  await t.toast("Premio borrado");
  igual([await t.page.inputValue("#aMvp"), (await t.S()).post.mvp], ["", ""], "premio borrado");
  await t.tap('[data-gol="A,1"]');
  await t.tap("#guardarPartido");
  igual((await t.S()).historial[0].mvp, "", "no se guarda para Fede");
});

/* ================= B13 ================= */
await prueba("B13: Atrás vuelve a la pestaña anterior en vez de cerrar la app", async (abrir) => {
  const t = await abrir(base());
  await t.ir("equipos"); await t.ir("pagos");
  await t.page.goBack();
  ok(await t.page.locator("#s-equipos.active").isVisible(), "vuelve a Equipos");
  await t.page.goBack();
  ok(await t.page.locator("#s-convocatoria.active").isVisible(), "vuelve a Convocatoria");
  ok(t.page.url().startsWith(FILE), "sigue en la app");
  await t.page.goForward();
  ok(await t.page.locator("#s-equipos.active").isVisible(), "adelante también funciona");
  await t.ir("pagos"); await t.page.reload();
  ok(await t.page.locator("#s-pagos.active").isVisible(), "al recargar se queda en la pestaña");
  await t.page.goBack();
  ok(await t.page.locator("#s-equipos.active").isVisible(), "tras recargar, Atrás sigue funcionando");
});

await prueba("B13: muchas vueltas entre pestañas no llenan el historial (Atrás llega rápido a Convocatoria)", async (abrir) => {
  const t = await abrir(base());
  const largo0 = await t.page.evaluate(() => history.length);
  for (let i = 0; i < 4; i++) for (const tab of ["equipos", "pagos", "post"]) { await t.ir(tab); await esperar(30); }
  await t.ir("equipos"); await esperar(100);
  ok(await t.page.evaluate((l) => history.length - l <= 3, largo0), "a lo más 3 entradas extra");
  await t.page.goBack();
  ok(await t.page.locator("#s-convocatoria.active").isVisible(), "un Atrás desde Equipos vuelve a Convocatoria");
  await t.ir("pagos"); await t.ir("convocatoria"); await esperar(100);
  ok(await t.page.evaluate((l) => history.length - l <= 1, largo0) && t.page.url() === FILE, "tocar Convocatoria retrocede en vez de sumar");
  // Atrás con una hoja abierta solo la cierra
  await t.page.evaluate(() => { S.deudas = { Ana: [{ fecha: "2026-10-10", concepto: "Cancha", monto: 5000 }] }; save(); });
  await t.ir("pagos"); await t.tap('[data-saldar="Ana"]');
  await t.page.goBack(); await esperar(150);
  ok(!(await t.page.locator("#sheet[open]").count()), "la hoja se cierra");
  ok(await t.page.locator("#s-pagos.active").isVisible(), "y se queda en Pagos");
  await t.page.goBack();
  ok(await t.page.locator("#s-convocatoria.active").isVisible(), "el siguiente Atrás vuelve a Convocatoria");
  // Abrir directo en una pestaña (#pagos): Atrás pasa por Convocatoria antes de salir
  const t2 = await abrir(base(), { url: FILE + "#pagos" });
  ok(await t2.page.locator("#s-pagos.active").isVisible(), "abre en Pagos");
  await t2.page.goBack();
  ok(await t2.page.locator("#s-convocatoria.active").isVisible(), "Atrás → Convocatoria");
});

/* ================= F2 ================= */
await prueba("F2: abono parcial, saldo total y deshacer", async (abrir) => {
  const t = await abrir(base({ inscritos: ["Ana"], caseros: ["Ana"], deudas: { Ana: [{ fecha: "2026-10-10", concepto: "Cancha + 🍻", monto: 19000 }] } }));
  await t.ir("pagos"); await t.tap('[data-saldar="Ana"]');
  igual(await t.page.inputValue("#sMonto"), "19.000", "propone el total");
  await t.page.fill("#sMonto", "");
  await t.page.locator("#sMonto").pressSequentially("5000");
  igual(await t.txt("#sOk"), "💵 Abonar $5.000 · queda $14.000", "botón de abono");
  await t.tap("#sOk");
  let S = await t.S();
  igual(S.deudas.Ana.map((e) => e.monto), [19000, -5000], "abono registrado con fecha");
  ok((await t.txt("#deudas")).includes("$14.000"), "queda $14.000");
  await t.ir("convocatoria");
  ok((await t.txt("#titulares")).includes("⚠️ $14.000"), "monto en Convocatoria");
  await t.ir("pagos"); await t.tap('[data-saldar="Ana"]'); await t.tap("#sOk");
  igual((await t.S()).deudas, {}, "saldada");
  await t.tap("#toast .tbtn");
  igual((await t.S()).deudas.Ana.length, 2, "deshacer el saldo");
});

await prueba("F2: pagar de más deja saldo a favor; 💬 recordatorio individual por WhatsApp", async (abrir) => {
  const t = await abrir(base({ banco: Object.assign(base().banco, { nombre: "Juan Pérez", cuenta: "123" }), deudas: { Ana: [{ fecha: "2026-10-10", concepto: "Cancha + 🍻", monto: 19000 }] } }));
  await t.ir("pagos"); await t.tap('[data-saldar="Ana"]');
  await t.tap("#sRecordar");
  const m = (await t.wa())[0];
  ok(m.includes("Hola Ana") && m.includes("$19.000") && m.includes("10/10 · Cancha + 🍻: $19.000") && m.includes("Juan Pérez"), "mensaje individual: " + m.replace(/\n/g, " | "));
  await t.page.fill("#sMonto", "");
  await t.page.locator("#sMonto").pressSequentially("20000");
  igual(await t.txt("#sOk"), "✅ Saldar · $1.000 a favor", "avisa del vuelto");
  await t.tap("#sOk");
  igual((await t.S()).deudas.Ana.map((e) => [e.concepto, e.monto]), [["Pagó de más (a favor)", -1000]], "queda $1.000 a favor");
});

await prueba("F2: ⚠️ y monto junto al nombre en titulares, suplentes y caseros", async (abrir) => {
  const t = await abrir(base({ porLado: 3, inscritos: [...J(6), "Kike"], caseros: ["Pablo", "J01", "Kike"], deudas: { J01: [{ fecha: "2026-10-10", concepto: "Cancha", monto: 3500 }], Kike: [{ fecha: "", concepto: "Deuda anterior (monto por confirmar)", monto: null }], Pablo: [{ fecha: "2026-10-10", concepto: "Cancha", monto: 7000 }] } }));
  ok((await t.txt("#titulares")).includes("J01 ⚠️ $3.500"), "titular");
  ok((await t.txt("#suplentes")).includes("Kike ⚠️ debe"), "suplente sin monto");
  ok((await t.txt('.chip[data-add="Pablo"]')).includes("⚠️ $7.000"), "chip de casero");
  await t.tap('.chip[data-add="Pablo"]');
  await t.toast("Pablo debe $7.000");
});

await prueba("F2: pagar la cuota pregunta por la deuda anterior (no la borra sola)", async (abrir) => {
  const t = await abrir(base({ porLado: 3, inscritos: ["Ana", "Beto"], costoCancha: "20000", deudas: { Ana: [{ fecha: "2026-10-10", concepto: "Cancha", monto: 10000 }], Beto: [{ fecha: "2026-10-10", concepto: "Cancha", monto: 10000 }] } }));
  await t.ir("pagos");
  t.respuestas.push(false);
  await t.tap('.state[data-pay="Ana"]');
  ok(t.dialogos[0].includes("también debe $10.000"), "pregunta");
  t.respuestas.push(true);
  await t.tap('.state[data-pay="Beto"]');
  const S = await t.S();
  ok(S.deudas.Ana && !S.deudas.Beto, "Ana sigue debiendo, Beto quedó al día");
  igual([S.pagos.Ana.monto, S.pagos.Beto.monto], [10000, 10000], "cuota de hoy pagada");
});

await prueba("F2: anotar una deuda a mano (respeta mayúsculas del casero)", async (abrir) => {
  const t = await abrir(base({ caseros: ["Ana"] }));
  await t.ir("pagos");
  await t.page.click(".manual summary");
  await t.page.fill("#mNombre", "ana");
  await t.page.locator("#mMonto").pressSequentially("5000");
  await t.tap("#mAnotar");
  const S = await t.S();
  igual([S.deudas.Ana[0].monto, S.deudas.Ana[0].concepto], [5000, "Anotada a mano"], "anotada");
});

await prueba("F2: el cobro lista a cada deudor con su monto (y los sin monto)", async (abrir) => {
  const t = await abrir(base({ porLado: 3, inscritos: ["Ana", "Beto"], costoCancha: "20000", pagos: { Beto: { monto: 10000, fecha: "" } },
    deudas: { Pablo: [{ fecha: "2026-10-10", concepto: "Cancha", monto: 19000 }, { fecha: "2026-10-17", concepto: "Cancha", monto: 10000 }, { fecha: "2026-10-18", concepto: "Abono", monto: -4000 }], Juan: [{ fecha: "", concepto: "x", monto: null }], Memo: [{ fecha: "2026-10-12", concepto: "Pagó y no jugó (a favor)", monto: -3500 }] } }));
  await t.ir("pagos"); await t.tap("#waCobrar");
  const m = (await t.wa())[0];
  ok(m.includes("⏳ Ana: $10.000"), "falta de hoy");
  ok(m.includes("• Pablo: $25.000 (10/10 $15.000 · 17/10 $10.000)"), "abono descontado de lo más antiguo");
  ok(m.includes("• Juan: deuda anterior, monto por confirmar"), "deuda sin monto");
  ok(!m.includes("Memo"), "saldo a favor no se cobra");
});

await prueba("F2: el saldo a favor se descuenta al cerrar y se puede marcar como devuelto", async (abrir) => {
  const t = await abrir(base({ porLado: 3, inscritos: ["Ana", "Beto"], costoCancha: "7000", deudas: { Ana: [{ fecha: "2026-10-12", concepto: "Pagó y no jugó (a favor)", monto: -3500 }], Memo: [{ fecha: "2026-10-12", concepto: "Pagó y no jugó (a favor)", monto: -2000 }] } }));
  await t.ir("pagos");
  ok((await t.txt('#pagos li:has([data-pay="Ana"])')).includes("💚 CUBIERTO"), "su saldo a favor cubre la cuota");
  await t.tap('[data-devuelto="Memo"]');
  igual((await t.S()).deudas.Memo, undefined, "devuelto");
  await t.tap('.state[data-pay="Beto"]');
  await t.tap(".screen.active [data-cerrar]"); await t.tap("#cOk");
  igual((await t.S()).deudas, {}, "deuda de Ana compensada con su saldo a favor");
});

/* ================= QA de la Ronda 1 ================= */
// Estado antiguo (99372cf) con los valores por defecto de esa versión
const viejo = (x = {}) => Object.assign({
  fecha: "2026-10-14", hora: "20:00", lugar: "Complejo", porLado: 3,
  inscritos: ["Ana", "Beto", "Caro", "Dani", "Eli", "Fede"], caseros: ["Ana", "Beto", "Caro", "Dani", "Eli", "Fede", "Gabi"],
  niveles: {}, equipos: { A: [], B: [] }, colorA: "⚫ Negro", colorB: "🟢 Peto Flúor",
  banco: { nombre: "", rut: "", banco: "", tipo: "", cuenta: "", mail: "", link: "", qr: "" },
  costoCancha: "", costoTercer: "", pagado: {}, tercer: {}, morosos: {}, post: { golesA: 0, golesB: 0 }, historial: [],
}, x);
const fila = (t, n) => t.txt(`#pagos li:has([data-pay="${n}"])`).then((x) => x.replace(/\s+/g, " "));

await prueba("QA F2: saldar una deuda sin monto conserva el saldo a favor (y el saldo se ve)", async (abrir) => {
  const t = await abrir(viejo({ porLado: 7, inscritos: ["Ana", ...J(13)], costoCancha: "49000", morosos: { Ana: true } }));
  await t.ir("pagos");
  t.respuestas.push(false); // "¿La pagó también?" → No
  await t.tap('.state[data-pay="Ana"]');
  ok(t.dialogos[0].includes("Ana también tiene una deuda anterior sin monto. ¿La pagó también?"), "pregunta sin texto repetido: " + t.dialogos[0]);
  await t.ir("convocatoria"); await t.tap('[data-del="Ana"]');
  await t.toast("queda a favor");
  igual((await t.S()).deudas.Ana.map((e) => e.monto), [null, -3500], "libreta: deuda sin monto + a favor");
  await t.ir("pagos");
  const d = (await t.txt("#deudas")).replace(/\s+/g, " ");
  ok(d.includes("Ana") && d.includes("💚 Tiene $3.500 a favor"), "el saldo a favor se ve: " + d);
  await t.tap("#waCobrar");
  ok((await t.wa())[0].includes("• Ana: deuda anterior, monto por confirmar (tiene $3.500 a favor)"), "cobro con el saldo a favor");
  await t.tap('[data-saldar="Ana"]');
  ok((await t.txt("#sheetBody")).includes("💚 Saldo a favor"), "la hoja muestra el saldo a favor");
  ok((await t.txt("#sNota")).includes("conserva $3.500 a favor"), "explica que lo conserva");
  await t.tap("#sOk");
  igual((await t.S()).deudas.Ana, [{ fecha: (await t.S()).deudas.Ana[0].fecha, concepto: "Pagó y no jugó (a favor)", monto: -3500 }], "solo se borra la deuda sin monto");
  ok((await t.txt("#deudas")).includes("💚"), "sigue como saldo a favor");
});

await prueba("QA F2: '¿La pagó también?' = Sí tampoco borra el saldo a favor", async (abrir) => {
  const t = await abrir(base({ porLado: 3, inscritos: SEIS.slice(), costoCancha: "36000", deudas: { Ana: [{ fecha: "", concepto: "Deuda anterior", monto: null }, { fecha: "2026-10-12", concepto: "Pagó y no jugó (a favor)", monto: -6000 }] } }));
  await t.ir("pagos");
  ok((await fila(t, "Ana")).includes("💚 CUBIERTO"), "la cuota la cubre su saldo a favor");
  t.respuestas.push(true, true); // pagó en efectivo igual · también pagó la deuda anterior
  await t.tap('.state[data-pay="Ana"]');
  ok(t.dialogos[0].includes("¿Pagó en efectivo igual?"), "pregunta antes de cobrar dos veces");
  const S = await t.S();
  igual([S.pagos.Ana.monto, S.deudas.Ana.map((e) => e.monto)], [6000, [-6000]], "pagó hoy y conserva su saldo a favor");
});

await prueba("QA B5: quien pagó, se bajó y vuelve no paga dos veces ni queda con saldo fantasma", async (abrir) => {
  const t = await abrir(base({ porLado: 3, inscritos: ["Ana", "Beto", "Caro"], caseros: ["Ana", "Beto", "Caro"], costoCancha: "30000" }));
  await t.ir("pagos"); await t.tap('.state[data-pay="Ana"]');
  await t.ir("convocatoria"); await t.tap('[data-del="Ana"]'); await esperar(BAJA);
  await t.tap('.chip[data-add="Ana"]');
  await t.ir("pagos");
  ok((await fila(t, "Ana")).includes("💚 CUBIERTO"), "fila cubierta: " + await fila(t, "Ana"));
  await t.tap("#waCobrar");
  const m = (await t.wa())[0];
  ok(!m.includes("Ana") && m.includes("⏳ Beto: $10.000"), "Ana no sale en el cobro: " + m.replace(/\n/g, " | "));
  t.respuestas.push(false);
  await t.tap('.state[data-pay="Ana"]');
  ok(t.dialogos[0].includes("¿Pagó en efectivo igual?"), "no registra un segundo pago sin preguntar");
  igual((await t.S()).pagos.Ana, undefined, "sin segundo pago");
  ok((await t.txt("#recaudado")).includes("💚 $10.000 con saldo a favor"), "recaudado cuenta el saldo a favor");
  await t.tap(".screen.active [data-cerrar]");
  ok((await t.txt("#sheet")).includes("Se descuenta de su saldo a favor: Ana $10.000"), "el cierre lo explica");
  await t.tap("#cOk");
  const S = await t.S();
  igual(S.deudas.Ana, undefined, "Ana pagó una vez y jugó: queda en $0");
  igual([S.deudas.Beto[0].monto, S.deudas.Caro[0].monto], [10000, 10000], "los demás deben su cuota");
});

await prueba("QA B5: '−' y luego '+' no hace pagar dos veces; saldo a favor parcial", async (abrir) => {
  const t = await abrir(base({ porLado: 4, inscritos: [...SEIS, "Gabi", "Hugo"], costoCancha: "48000", pagos: { Hugo: { monto: 6000, fecha: "2026-10-16" } }, deudas: { Ana: [{ fecha: "2026-10-03", concepto: "Pagó de más (a favor)", monto: -2000 }] } }));
  await t.tap("#menos");
  ok(t.dialogos[0].includes("Hugo ya pagó"), "avisa al pasar a suplente");
  igual((await t.S()).deudas.Hugo[0].monto, -6000, "su pago queda a favor");
  await t.tap("#mas");
  await t.ir("pagos");
  ok((await fila(t, "Hugo")).includes("💚 CUBIERTO"), "Hugo vuelve cubierto: " + await fila(t, "Hugo"));
  const a = await fila(t, "Ana");
  ok(a.includes("usa $2.000 a favor") && a.includes("⏳ $4.000"), "Ana usa su saldo a favor: " + a);
  await t.tap("#waCobrar");
  ok((await t.wa())[0].includes("⏳ Ana: $4.000 (usa $2.000 a favor)"), "cobro con el descuento");
  await t.tap('.state[data-pay="Ana"]');
  igual((await t.S()).pagos.Ana.monto, 4000, "paga solo lo que falta");
  ok((await fila(t, "Ana")).includes("✅ PAGADO"), "queda pagada");
  await t.tap(".screen.active [data-cerrar]"); await t.tap("#cOk");
  const S = await t.S();
  igual([S.deudas.Ana, S.deudas.Hugo], [undefined, undefined], "saldos a favor usados");
});

await prueba("QA B5: tocar una fila pagada no borra lo que ya había pagado (doble toque, abono previo, ↩️)", async (abrir) => {
  const N = ["Carlos", "Seba", ...J(13)];
  const t = await abrir(base({ porLado: 7, inscritos: N, costoCancha: "70000", pagos: { Seba: { monto: 4000, fecha: "2026-10-10" } } }));
  await t.ir("pagos");
  ok((await fila(t, "Seba")).includes("pagó $4.000 falta $1.000"), "abono previo a la vista");
  await t.page.locator('.state[data-pay="Seba"]').dblclick();
  igual((await t.S()).pagos.Seba, { monto: 5000, fecha: (await t.S()).pagos.Seba.fecha, previo: 4000 }, "doble toque: completa una sola vez");
  await esperar(BAJA);
  await t.tap('.state[data-pay="Seba"]');
  igual((await t.S()).pagos.Seba.monto, 4000, "desmarcar vuelve al abono anterior, no a cero");
  await t.toast("pagó $4.000");
  await t.tap("#toast .tbtn");
  igual((await t.S()).pagos.Seba.monto, 5000, "↩️ Deshacer");
  // Pagó de más: preguntar antes de borrar y poder deshacer
  const t2 = await abrir(base({ inscritos: ["Maximiliano", ...J(15)], costoCancha: "49000", pagos: { Maximiliano: { monto: 10000, fecha: "2026-10-10" } } }), { width: 320, height: 568 });
  await t2.ir("pagos");
  ok((await fila(t2, "Maximiliano")).includes("a favor $6.500"), "pagó de más");
  t2.respuestas.push(false);
  await t2.tap('.state[data-pay="Maximiliano"]');
  ok(t2.dialogos[0].includes("pagó $10.000 y la cuota es $3.500"), "pregunta");
  igual((await t2.S()).pagos.Maximiliano.monto, 10000, "cancelar no borra");
  await esperar(BAJA);
  await t2.tap('.state[data-pay="Maximiliano"]');
  igual((await t2.S()).pagos.Maximiliano, undefined, "aceptar borra");
  await t2.toast("quedó sin pagar");
  await t2.tap("#toast .tbtn");
  igual((await t2.S()).pagos.Maximiliano.monto, 10000, "↩️ recupera los $10.000");
});

await prueba("QA migración: ✅ pagado y 🍻 viejos de quien ya no es titular, y pagado sin costo de cancha", async (abrir) => {
  // pagó y luego se bajó (J99) → a favor
  let t = await abrir(viejo({ inscritos: ["Ana2", "Caro", "Dani", "Eli"], porLado: 2, pagado: { Caro: true, J99: true }, costoCancha: "42.000" }));
  let S = await t.S();
  igual(S.pagos.Caro.monto, 10500, "titular con su cuota");
  igual(S.deudas.J99, [{ fecha: "2026-10-14", concepto: "Pagó y no jugó (a favor)", monto: -10500 }], "J99 queda a favor");
  // pagado con la cancha sin costo → pagado (sin monto); al escribir el costo sigue pagado
  t = await abrir(viejo({ porLado: 3, pagado: { Ana: true, Beto: true } }));
  S = await t.S();
  igual([S.pagos.Ana, S.pagos.Beto], [{ monto: null, fecha: "" }, { monto: null, fecha: "" }], "pagado sin monto");
  await t.ir("pagos");
  ok((await fila(t, "Ana")).includes("✅ PAGADO"), "el ✅ se ve aunque no haya costo");
  await t.page.locator("#costoCancha").pressSequentially("36000");
  ok((await fila(t, "Ana")).includes("✅ PAGADO") && (await fila(t, "Beto")).includes("✅ PAGADO"), "siguen pagados con costo");
  ok((await fila(t, "Caro")).includes("⏳ $6.000"), "Caro debe");
  await t.tap(".screen.active [data-cerrar]");
  const hoja = await t.txt("#sheet");
  ok(!hoja.includes("⏳ Ana") && !hoja.includes("⏳ Beto") && hoja.includes("4 deudas"), "al cerrar no se anotan como deudores");
  // 🍻 viejo de quien se bajó no vuelve con él; ✅ de un suplente (pasó con '−') queda a favor
  t = await abrir(viejo({ costoCancha: "36000", costoTercer: "12000", tercer: { Gabi: true, Ana: true } }));
  igual((await t.S()).tercer, { Ana: true }, "🍻 solo de titulares");
  await t.tap("#mas"); await t.tap('.chip[data-add="Gabi"]');
  await t.ir("pagos");
  igual(await t.page.getAttribute('[data-beer="Gabi"]', "aria-pressed"), "false", "Gabi vuelve sin 🍻");
  const N = ["Carlos", "Seba", "Nico", "Mati", "Mako", "Pancho", "Rodrigo", "Felipe", "Tomás", "Javi", "Cristóbal", "Benja", "Diego", "Ignacio", "Vicente", "Joaquín"];
  t = await abrir(viejo({ porLado: 7, inscritos: N, costoCancha: "56000", pagado: { Vicente: true, Carlos: true } }));
  S = await t.S();
  igual([S.pagos.Carlos.monto, S.deudas.Vicente], [4000, [{ fecha: "2026-10-14", concepto: "Pagó y no jugó (a favor)", monto: -4000 }]], "suplente que pagó queda a favor");
  // { monto: 0 } que dejaba la migración anterior = pagado
  t = await abrir(base({ porLado: 3, inscritos: ["Ana", "Beto"], pagos: { Ana: { monto: 0, fecha: "" } } }));
  igual((await t.S()).pagos.Ana, { monto: null, fecha: "" }, "monto 0 → pagado sin monto");
});

await prueba("QA: nombres como 'constructor' o '__proto__' no rompen la app", async (abrir) => {
  const t = await abrir(null);
  for (const n of ["constructor", "__proto__", "toString", "hasOwnProperty", "Ana"]) { await t.page.fill("#nuevo", n); await t.tap("#agregar"); }
  igual((await t.S()).inscritos, ["constructor", "__proto__", "toString", "hasOwnProperty", "Ana"], "inscritos");
  await t.page.reload();
  igual(await t.page.locator("#titulares li").count(), 5, "filas tras recargar");
  ok(!(await t.txt("#titulares")).includes("⚠️"), "nadie aparece debiendo");
  await t.ir("pagos");
  igual(await t.page.locator("#pagos li").count(), 5, "filas en Pagos");
  ok(!(await t.txt("#pagos")).includes("PAGADO"), "nadie aparece PAGADO solo");
  await t.page.locator("#costoCancha").pressSequentially("10000");
  await t.tap('.state[data-pay="__proto__"]');
  await t.ir("convocatoria"); await t.tap('[data-del="__proto__"]');
  await t.ir("equipos"); await t.tap("#equilibrar");
  await t.ir("convocatoria"); await t.page.reload();
  const r = await t.page.evaluate(() => [Object.keys(S.deudas), saldo("__proto__"), Object.keys(S.niveles).length, document.querySelectorAll("#titulares li").length]);
  igual(r, [["__proto__"], -2000, 0, 4], "la libreta guarda a '__proto__' como un nombre más");
});

await prueba("QA bug 61: un respaldo con un id de partido malicioso no ejecuta código y se puede borrar", async (abrir) => {
  const t = await abrir(base());
  await t.page.evaluate(() => { window.__xss = 0; });
  const fecha = new Date().toISOString().slice(0, 8) + "05";
  const f = path.join(os.tmpdir(), `respaldo-malo-${process.pid}.json`);
  fs.writeFileSync(f, JSON.stringify({ app: "pichanga", version: 2, datos: { v: 2, inscritos: ["Ana"], historial: [{ id: '1"><img src=x onerror="window.__xss++">', fecha, golesA: "1<b>", golesB: 0, A: ["Ana"], B: [] }] } }));
  await t.ir("post");
  await t.page.setInputFiles("#importar", f);
  await t.toast("Respaldo restaurado");
  fs.unlinkSync(f);
  await t.page.evaluate(() => { window.__xss = 0; });
  await t.ir("post"); await esperar(200);
  const S = await t.S();
  ok(Number.isSafeInteger(S.historial[0].id) && S.historial[0].golesA === 1, "id numérico y goles enteros");
  igual(await t.page.evaluate(() => window.__xss), 0, "no se ejecutó nada");
  igual(await t.page.locator("#historial img").count(), 0, "sin HTML inyectado");
  await t.tap("[data-delpartido]");
  igual((await t.S()).historial.length, 0, "se puede borrar");
});

await prueba("QA F1: doble toque en el chip que completa la lista de la semana pasada no suma a otro", async (abrir) => {
  const N = ["Carlos", "Seba", "Nico", "Mati", "Mako", "Pancho", "Rodrigo", "Felipe", "Tomás", "Javi"];
  for (const [width, height] of [[390, 844], [320, 568]]) {
    const t = await abrir(base({ porLado: 5, inscritos: N.slice(0, 9), caseros: N.concat(["Andrés", "Pedro", "Lucho", "Gonzalo"]), ultimaLista: N.slice() }), { width, height });
    const chip = t.page.locator('.chip[data-add="Javi"]');
    await chip.scrollIntoViewIfNeeded();
    await chip.dblclick();
    await esperar(150);
    igual((await t.S()).inscritos, N, `${width}px: solo se suma Javi`);
    ok(await t.page.locator("#mismaLista").isDisabled(), "el botón queda en su lugar, desactivado");
    igual(await t.txt("#mismaLista"), "✅ Ya están todos los de la semana pasada", "texto del botón");
  }
  const t = await abrir(base({ porLado: 5, caseros: N.slice(), ultimaLista: N.slice() }));
  await t.page.dblclick("#mismaLista");
  igual((await t.S()).inscritos, N, "doble toque en 🔁 Misma lista inscribe una vez");
});

await prueba("QA F2: Saldar una deuda sin monto respeta lo que se escribe (abono, monto, saldo a favor)", async (abrir) => {
  const JP = "Juan Pablo Fernández";
  let t = await abrir(viejo({ morosos: { [JP]: true } }));
  await t.ir("pagos"); await t.tap(`[data-saldar="${JP}"]`);
  igual(await t.page.inputValue("#sMonto"), "", "sin monto propuesto");
  await t.page.locator("#sMonto").pressSequentially("5000");
  igual(await t.txt("#sOk"), "✅ Saldar todo con $5.000", "el monto escrito cambia el botón");
  ok((await t.txt("#sNota")).includes("queda en $5.000"), "explica qué hará");
  await t.page.locator("#sFijar").pressSequentially("8000");
  igual(await t.txt("#sOk"), "💵 Abonar $5.000 · queda $3.000", "con el monto de la deuda, abono parcial");
  await t.tap("#sOk");
  igual((await t.S()).deudas[JP].map((e) => e.monto), [8000, -5000], "abono registrado");
  ok((await t.txt("#deudas")).includes("$3.000"), "queda $3.000");
  // Mixta "$8.500 + ?": pagar 8.500 no borra la deuda sin monto
  t = await abrir(base({ deudas: { Maxi: [{ fecha: "2026-10-03", concepto: "Cancha", monto: 8500 }, { fecha: "", concepto: "Deuda anterior", monto: null }] } }));
  await t.ir("pagos"); await t.tap('[data-saldar="Maxi"]');
  await t.page.locator("#sMonto").pressSequentially("8500");
  igual(await t.txt("#sOk"), "💵 Abonar $8.500 · queda la deuda sin monto", "botón");
  await t.tap("#sOk");
  ok(await t.page.evaluate(() => sinMonto("Maxi") && saldo("Maxi") === 0), "sigue la deuda sin monto");
  // Solo anotar el monto, y pagar con el saldo a favor
  t = await abrir(base({ deudas: { Ana: [{ fecha: "", concepto: "Deuda anterior", monto: null }, { fecha: "2026-10-10", concepto: "Pagó de más (a favor)", monto: -3500 }], Beto: [{ fecha: "", concepto: "Deuda anterior", monto: null }] } }));
  await t.ir("pagos"); await t.tap('[data-saldar="Beto"]');
  await t.page.locator("#sFijar").pressSequentially("7000");
  await t.tap("#sSoloMonto");
  igual((await t.S()).deudas.Beto, [{ fecha: "", concepto: "Deuda anterior", monto: 7000 }], "monto anotado sin pago");
  await t.sinToast();
  await t.tap('[data-saldar="Ana"]');
  await t.page.locator("#sFijar").pressSequentially("3500");
  igual(await t.txt("#sOk"), "💚 Pagar con su saldo a favor", "botón");
  await t.tap("#sOk");
  igual((await t.S()).deudas.Ana, undefined, "pagada con el saldo a favor");
});

await prueba("QA F2: el total de deudas no dice '$0' cuando hay deudas sin monto", async (abrir) => {
  let t = await abrir(viejo({ morosos: { "Juan Pablo Fernández": true, Carlos: true } }), { width: 320, height: 568 });
  await t.ir("pagos");
  igual(await t.txt("#deudaTotal"), "2 · ?", "solo sin monto");
  t = await abrir(base({ deudas: { A: [{ fecha: "", concepto: "Cancha", monto: 8500 }], B: [{ fecha: "", concepto: "Deuda anterior", monto: null }] } }));
  await t.ir("pagos");
  igual(await t.txt("#deudaTotal"), "2 · $8.500 + ?", "mixtas");
});

await prueba("QA textos: recordatorio sin repetir 'monto por confirmar' y aviso de equipos con el nombre del botón", async (abrir) => {
  const JP = "Juan Pablo Fernández";
  const t = await abrir(viejo({ morosos: { [JP]: true }, inscritos: [JP, "Beto"], costoCancha: "20000" }));
  await t.ir("pagos"); await t.tap(`[data-saldar="${JP}"]`); await t.tap("#sRecordar");
  const m = (await t.wa())[0];
  ok(!m.includes("(monto por confirmar) (monto por confirmar)") && (m.match(/monto por confirmar/g) || []).length === 1, "sin repetir: " + m.replace(/\n/g, " | "));
  ok(m.includes("• Deuda anterior: monto por confirmar") && m.includes("¿me confirmas cuánto era?"), "pide el monto");
  const t2 = await abrir(base({ inscritos: J(14), equipos: { A: J(7), B: J(14).slice(7) } }));
  for (const n of ["J01", "J02", "J03"]) { await t2.tap(`[data-del="${n}"]`); await esperar(BAJA); }
  await t2.ir("equipos");
  await t2.toast("Equipos reajustados");
  const x = await t2.txt("#toast");
  ok(x.includes("toca ⚖️ Armado Equilibrado") && !x.includes("pulsa Equilibrar"), "nombre real del botón: " + x);
});

await prueba("QA B7: el ↩️ Deshacer de una baja sigue disponible si se abre Equipos", async (abrir) => {
  const t = await abrir(base({ inscritos: J(14), equipos: { A: J(7), B: J(14).slice(7) } }));
  for (const n of ["J01", "J02", "J03"]) { await t.tap(`[data-del="${n}"]`); await esperar(BAJA); }
  await t.ir("equipos");
  await t.toast("Equipos reajustados");
  ok((await t.txt("#toast")).includes("J03 se bajó"), "recuerda qué se puede deshacer");
  await t.tap("#toast .tbtn");
  ok((await t.S()).inscritos.includes("J03"), "J03 vuelve");
});

await prueba("QA F2: Deudas pendientes a 320 px no parte nombres ni deja el ⚠️ solo", async (abrir) => {
  const M = "Maximiliano Ignacio Rodríguez";
  const t = await abrir(base({ deudas: { [M]: [{ fecha: "2026-10-03", concepto: "Cancha", monto: 8500 }, { fecha: "", concepto: "Deuda anterior", monto: null }], "Maximiliano Ignacio Rodríguez 2": [{ fecha: "2026-10-03", concepto: "Pagó de más (a favor)", monto: -2000 }] } }), { width: 320, height: 568 });
  await t.ir("pagos");
  const r = await t.page.evaluate(() => [...document.querySelectorAll("#deudas .name")].map((el) => {
    const nodo = el.firstChild, rango = document.createRange();
    const top = (i) => { rango.setStart(nodo, i); rango.setEnd(nodo, i + 1); return Math.round(rango.getBoundingClientRect().top); };
    const txt = nodo.textContent, i = txt.indexOf("Maximiliano");
    // cada palabra entera en una sola línea
    const partidas = txt.split(" ").filter((w) => w).some(() => false);
    let cortes = 0, pos = 0;
    for (const w of txt.split(" ")) { if (w.length > 1 && top(pos) !== top(pos + w.length - 1)) cortes++; pos += w.length + 1; }
    return { emojiSolo: top(0) !== top(i), cortes, partidas };
  }));
  ok(r.length === 2 && r.every((x) => !x.emojiSolo && !x.cortes), "nombres enteros: " + JSON.stringify(r));
});

await prueba("QA F2: doble toque en 'Devuelto' no abre la hoja de la fila que sube", async (abrir) => {
  const t = await abrir(base({ deudas: { Lucho: [{ fecha: "2026-10-07", concepto: "Pagó de más (a favor)", monto: -3000 }], Rita: [{ fecha: "2026-10-07", concepto: "Pagó de más (a favor)", monto: -1000 }] } }));
  await t.ir("pagos");
  await t.page.locator('[data-devuelto="Lucho"]').dblclick();
  const S = await t.S();
  igual([S.deudas.Lucho, S.deudas.Rita[0].monto, t.dialogos.length], [undefined, -1000, 1], "solo se devuelve a Lucho");
  ok(!(await t.page.locator("#sheet[open]").count()), "sin hojas abiertas");
  await t.page.evaluate(() => { S.deudas.Pato = [{ fecha: "2026-10-07", concepto: "Cancha", monto: 5000 }]; save(); renderPagos(); });
  // Doble toque en Saldar: el segundo toque cae sobre la hoja recién abierta y no aprieta nada
  await esperar(BAJA);
  for (const pos of ["start", "center"]) { // arriba: cae en el fondo oscuro; al centro: sobre los botones de la hoja
    const b = t.page.locator('[data-saldar="Pato"]');
    await b.evaluate((el, pos) => el.scrollIntoView({ block: pos }), pos);
    const box = await b.boundingBox();
    await t.page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
    ok(await t.page.locator("#sheet[open]").count(), `hoja abierta (botón arriba/abajo: ${pos})`);
    igual((await t.S()).deudas.Pato[0].monto, 5000, "no se saldó sola");
    await t.page.keyboard.press("Escape");
  }
});

/* ================= QA Ronda 1 (pasada 2) ================= */
const DIEZ = ["Carlos", "Seba", "Nico", "Mati", "Mako", "Diego", "Pedro", "Tomás", "Javier", "Felipe"];
const estadoCierre = () => base({ porLado: 5, inscritos: DIEZ.slice(), caseros: DIEZ.concat("Andrés", "Pablo", "Lucho"), costoCancha: "50000",
  pagos: { Carlos: { monto: 5000, fecha: "2026-10-16" } }, ultimaLista: DIEZ.slice(), post: { golesA: 2, golesB: 1, mvp: "", goleador: "", rustico: "", guardadoId: null } });
for (const [w, h] of [[390, 844], [360, 740]]) {
  await prueba(`QA F1: doble toque en 'Cerrar y preparar la próxima' no inscribe a nadie y se puede deshacer (${w}px)`, async (abrir) => {
    const t = await abrir(estadoCierre(), { width: w, height: h });
    await t.ir("pagos");
    for (const ms of [120, 250]) {
      if (ms === 250) { await t.tap("#toast .tbtn"); await t.toast("Pichanga reabierta"); await t.ir("pagos"); }
      await t.tap(".screen.active [data-cerrar]"); await t.hoja();
      await t.page.locator("#cOk").scrollIntoViewIfNeeded();
      const b = await t.page.locator("#cOk").boundingBox();
      await t.page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
      await esperar(ms);
      await t.page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
      const S = await t.S();
      igual([S.inscritos, Object.keys(S.deudas).length, S.historial.length], [[], 9, 1], `cerrada sin inscribir a nadie (${ms} ms)`);
      ok(!(await t.txt("#toast")).includes("debe"), "el segundo toque no tocó un chip");
    }
    await t.tap("#toast .tbtn");
    await t.toast("Pichanga reabierta");
    const S = await t.S();
    igual([S.inscritos, S.deudas, S.historial.length, S.pagos.Carlos.monto], [DIEZ, {}, 0, 5000], "↩️ Deshacer devuelve todo");
  });
}

await prueba("QA F2: '¿Pagó eso también?' tiene ↩️ Deshacer y desmarcar el pago devuelve la deuda anterior", async (abrir) => {
  const SEBA = [{ fecha: "2026-10-10", concepto: "Cancha", monto: 5000 }, { fecha: "2026-10-03", concepto: "Cancha", monto: 5000 }];
  const estado = base({ porLado: 3, inscritos: ["Carlos", "Seba", "Nico", "Mati", "Mako", "Pedro"], costoCancha: "30000", deudas: { Seba: SEBA } });
  const t = await abrir(estado);
  await t.ir("pagos");
  await t.tap('.pname[data-pay="Seba"]');
  ok(t.dialogos[0].includes("Seba también debe $10.000"), "pregunta por la deuda anterior");
  await t.toast("Seba quedó al día");
  ok(await t.page.locator("#toast .tbtn").count(), "el aviso trae ↩️ Deshacer");
  let S = await t.S();
  ok(!S.deudas.Seba && S.pagos.Seba.monto === 5000, "pagó cuota y deuda");
  await esperar(BAJA);
  await t.tap('.pname[data-pay="Seba"]');
  await t.toast("Seba quedó sin pagar");
  ok((await t.txt("#toast")).includes("vuelve a deber $10.000"), "avisa que vuelve a deber: " + await t.txt("#toast"));
  S = await t.S();
  igual([S.pagos.Seba, S.deudas.Seba], [undefined, SEBA], "desmarcar devuelve la deuda tal cual");
  ok((await t.txt("#deudas")).includes("Seba"), "Seba otra vez en Deudas pendientes");
  // ↩️ Deshacer del aviso devuelve pago y deuda a como estaban antes del toque
  await esperar(BAJA);
  await t.tap('.pname[data-pay="Seba"]');
  await t.toast("Seba quedó al día");
  await t.tap("#toast .tbtn");
  await t.toast("Seba quedó como antes");
  S = await t.S();
  igual([S.pagos.Seba, S.deudas.Seba], [undefined, SEBA], "↩️ Deshacer devuelve pago y deuda");
  // Con algo anotado después (abono), desmarcar devuelve la deuda sin perder el abono
  await esperar(BAJA);
  await t.tap('.pname[data-pay="Seba"]');
  await t.toast("Seba quedó al día");
  await t.page.evaluate(() => { abonar("Seba", 1000); save(); renderPagos(); });
  await esperar(BAJA);
  await t.tap('.pname[data-pay="Seba"]');
  S = await t.S();
  igual(S.deudas.Seba.map((e) => e.monto).sort(), [-1000, 5000, 5000].sort(), "deuda devuelta y abono conservado");
  // El dato nuevo (pagos.libreta) sobrevive a recargar y a la migración
  await esperar(BAJA);
  await t.tap('.pname[data-pay="Seba"]');
  await t.toast("Seba quedó al día"); // el toque terminó (con su confirmación) antes de recargar
  await t.page.reload();
  S = await t.S();
  ok(S.pagos.Seba.libreta && S.pagos.Seba.libreta.antes.length === 3, "la libreta guardada en el pago se conserva al recargar");
});

await prueba("QA B7: un ↩️ Deshacer viejo no queda bajo 📒 Anotar deuda ni 🔁 Misma lista (cada uno trae el suyo)", async (abrir) => {
  const t = await abrir(base({ porLado: 8, deudas: { Lucho: [{ fecha: "2026-10-10", concepto: "Cancha", monto: 5000 }] }, ultimaLista: J(16) }));
  await t.ir("pagos"); await t.tap('[data-saldar="Lucho"]');
  await t.page.fill("#sMonto", ""); await t.page.locator("#sMonto").pressSequentially("3000");
  await t.tap("#sOk");
  await t.toast("Abono de $3.000");
  await t.tap("details.manual summary");
  await t.page.fill("#mNombre", "Pedro Pablo Ossandón"); await t.page.locator("#mMonto").pressSequentially("50000");
  await t.tap("#mAnotar");
  await t.toast("Anotado: Pedro Pablo Ossandón debe $50.000");
  ok(!(await t.txt("#toast")).includes("Abono"), "sin el aviso del abono debajo");
  await t.tap("#toast .tbtn");
  await t.toast("Deuda de Pedro Pablo Ossandón borrada");
  let S = await t.S();
  ok(!S.deudas["Pedro Pablo Ossandón"] && S.deudas.Lucho.length === 2, "↩️ borra la deuda anotada y deja el abono");
  // 🔁 Misma lista justo después de cerrar
  await t.page.evaluate((l) => { S.inscritos = l.slice(); S.costoCancha = "48000"; save(); renderTab(); }, J(16));
  await t.tap(".screen.active [data-cerrar]"); await t.tap("#cOk");
  await t.toast("Pichanga cerrada");
  await t.tap("#mismaLista");
  await t.toast("16 inscritos como la semana pasada");
  ok(!(await t.txt("#toast")).includes("cerrada"), "sin el aviso del cierre debajo");
  await t.tap("#toast .tbtn");
  await t.toast("Lista como estaba");
  S = await t.S();
  igual([S.inscritos, Object.keys(S.deudas).length], [[], 17], "↩️ saca a los 16 y no reabre la pichanga (16 deudas del cierre + Lucho)");
});

const DIECISIETE = ["Juan Pablo Fernández", "Nicolás", "Cristóbal", "Ignacio", "Agustín", "Bastián", "Rodrigo", "Matías", "Vicente", "Benjamín", "Joaquín", "Tomás", "Felipe", "Sebastián", "Diego", "Martín", "Lucas"];
await prueba("QA B7: ⚖️ Equilibrado y 💾 Guardar partido no muestran el ↩️ de una baja anterior; deshacen lo suyo", async (abrir) => {
  const t = await abrir(base({ porLado: 8, inscritos: DIECISIETE.slice(), niveles: { Nicolás: 5, Cristóbal: 1, Ignacio: 4, Agustín: 2 } }));
  await t.ir("equipos"); await t.tap("#azar");
  await t.ir("convocatoria"); await t.tap('[data-del="Bastián"]');
  await t.toast("Bastián se bajó");
  await t.ir("equipos");
  const antes = (await t.S()).equipos;
  await t.tap("#equilibrar");
  await t.toast("Equipos parejos");
  ok(!(await t.txt("#toast")).includes("Bastián"), "sin el aviso de la baja debajo: " + await t.txt("#toast"));
  const parejos = (await t.S()).equipos;
  await t.tap("#toast .tbtn");
  await t.toast("Equipos como estaban");
  let S = await t.S();
  igual(S.equipos, antes, "↩️ vuelven los equipos de antes del ⚖️");
  ok(!S.inscritos.includes("Bastián"), "Bastián sigue abajo");
  // 💾 Guardar partido después de bajar a alguien
  await t.ir("convocatoria"); await t.tap('[data-del="Rodrigo"]');
  await t.toast("Rodrigo se bajó");
  await t.ir("post"); t.respuestas.push(true); await t.tap("#guardarPartido");
  await t.toast("Partido guardado");
  ok(!(await t.txt("#toast")).includes("Rodrigo"), "sin el aviso de la baja debajo");
  await t.tap("#toast .tbtn");
  await t.toast("Partido sin guardar");
  S = await t.S();
  igual([S.historial.length, S.post.guardadoId, S.inscritos.includes("Rodrigo")], [0, null, false], "↩️ deshace el guardado, no la baja");
  igual(await t.txt("#guardarPartido"), "💾 Guardar partido", "botón vuelve a Guardar");
  void parejos;
});

await prueba("QA B7: arreglar los equipos a mano después de una baja quita su ↩️ (no deshace lo armado)", async (abrir) => {
  const t = await abrir(base({ porLado: 4, inscritos: J(9), equipos: { A: J(4), B: J(8).slice(4) } }));
  await t.tap('[data-del="J02"]');
  await t.toast("J02 se bajó");
  await t.ir("equipos");
  await t.page.evaluate(() => { swap("J01", "J05"); renderEquipos(); }); // arrastre a mano (sin aviso)
  const armados = (await t.S()).equipos;
  await sinDeshacer(t, "arrastre a mano");
  const S = await t.S();
  igual(S.equipos, armados, "los equipos armados a mano se mantienen");
  ok(!S.inscritos.includes("J02"), "la baja sigue");
});

await prueba("QA B7: el segundo toque de un doble toque no aprieta el ↩️ Deshacer recién aparecido", async (abrir) => {
  const t = await abrir(base({ porLado: 3, inscritos: SEIS.slice() }));
  await t.ir("equipos"); await t.tap("#equilibrar");
  await t.page.waitForSelector("#toast.show .tbtn");
  const parejos = (await t.S()).equipos;
  await t.page.locator("#toast .tbtn").click(); // ~inmediato, como el segundo toque
  igual((await t.S()).equipos, parejos, "los equipos no se deshicieron");
  await t.tap("#toast .tbtn"); // un toque a propósito sí deshace
  await t.toast("Equipos como estaban");
});

/* ================= QA ronda 1, pasada 3 ================= */
await prueba("QA B1/B5: las cuotas suman exacto el costo de la cancha (13 y 12 jugadores, 🍻 y cierre)", async (abrir) => {
  const t = await abrir(base({ inscritos: J(13) }));
  await t.ir("pagos");
  await t.page.locator("#costoCancha").pressSequentially("49.000");
  const suma = () => t.page.evaluate(() => titulares().reduce((s, n) => s + deuda(n), 0));
  igual(await suma(), 49000, "13 cuotas suman $49.000");
  const cuota = await t.txt("#porCancha");
  ok(cuota.includes("$3.769") && cuota.includes("3 pagan $3.770"), "cuota muestra quiénes pagan $1 más: " + cuota);
  ok((await t.txt("#recaudado")).includes("de $49.000"), "recaudado sobre $49.000: " + (await t.txt("#recaudado")));
  igual(await t.page.evaluate(() => titulares().map(deuda)), [3770, 3770, 3770].concat(Array(10).fill(3769)), "las primeras 3 pagan $1 más");
  // 🍻 $10.000 entre 3
  await t.page.locator("#costoTercer").pressSequentially("10000");
  for (const n of ["J01", "J05", "J09"]) await t.tap(`[data-beer="${n}"]`);
  igual(await suma(), 59000, "cancha + 🍻 suman $59.000");
  for (const n of J(13)) await t.page.evaluate((n) => togglePago(n), n);
  await t.page.evaluate(() => { save(); renderPagos(); });
  ok((await t.txt("#recaudado")).includes("Recaudado $59.000 de $59.000"), "todos pagados = total exacto: " + (await t.txt("#recaudado")));
  // 12 jugadores ('−' desde 7v7 con 14) y cierre sin pagos: la libreta suma el costo exacto
  const t2 = await abrir(base({ inscritos: J(14), costoCancha: "49000" }));
  await t2.page.click("#menos");
  igual(await t2.page.evaluate(() => titulares().reduce((s, n) => s + deuda(n), 0)), 49000, "12 cuotas suman $49.000");
  await t2.ir("pagos");
  ok((await t2.txt("#recaudado")).includes("de $49.000"), "recaudado de $49.000 con 12");
  await t2.tap("#s-pagos [data-cerrar]"); await t2.tap("#cOk");
  const S = await t2.S();
  igual(Object.values(S.deudas).flat().reduce((s, e) => s + e.monto, 0), 49000, "deudas anotadas al cerrar suman $49.000");
});

await prueba("QA F2: escribir 'juan' para el casero 'Juan' con deuda usa su nombre (⚠️, chip ✓ y una sola libreta)", async (abrir) => {
  const t = await abrir(base({ porLado: 3, costoCancha: "60000", caseros: ["Juan", "Seba"], deudas: { Juan: [{ fecha: "2026-10-08", concepto: "Cancha", monto: 10000 }] } }));
  await t.page.fill("#nuevo", "juan"); await t.tap("#agregar");
  await t.toast("⚠️ Juan debe $10.000");
  ok((await t.txt("#titulares")).includes("Juan ⚠️ $10.000"), "fila con el nombre guardado y su ⚠️");
  ok((await t.txt('#caseros [data-add="Juan"]')).startsWith("✓"), "chip de Juan marcado ✓");
  igual((await t.S()).caseros, ["Juan", "Seba"], "no se crea otro casero");
  await t.ir("pagos"); await t.tap("#s-pagos [data-cerrar]"); await t.tap("#cOk");
  const S = await t.S();
  igual(Object.keys(S.deudas), ["Juan"], "una sola persona en la libreta");
  igual(S.deudas.Juan.map((e) => e.monto), [10000, 60000], "la deuda nueva se suma a la de Juan");
  // También desde una deuda sin casero: 'PEDRO' se anota como 'Pedro'
  const t2 = await abrir(base({ deudas: { Pedro: [{ fecha: "", concepto: "Deuda anterior", monto: 5000 }] } }));
  await t2.page.fill("#nuevo", "  PEDRO "); await t2.tap("#agregar");
  igual((await t2.S()).inscritos, ["Pedro"], "usa el nombre de la libreta");
});

for (const btn of ["#equilibrar", "#azar"]) {
  await prueba(`QA B7/B8: doble toque en ${btn === "#azar" ? "🎲 Mezclar" : "⚖️ Armado Equilibrado"} y ↩️ vuelve a los equipos armados a mano`, async (abrir) => {
    const nombres = ["A1", "A2", "A3", "A4", "A5", "B1", "B2", "B3", "B4", "B5"], aMano = { A: ["A5", "A1", "A2", "A3", "A4"], B: ["B5", "B1", "B2", "B3", "B4"] };
    const t = await abrir(base({ porLado: 5, inscritos: nombres, niveles: { A1: 5, A2: 5, A3: 4, B1: 1, B2: 1 }, equipos: aMano }));
    await t.ir("equipos"); await t.hoja();
    const box = await t.page.locator(btn).boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
    await t.page.touchscreen.tap(x, y); await esperar(150); await t.page.touchscreen.tap(x, y);
    await esperar(700);
    await t.tap("#toast .tbtn");
    await t.toast("Equipos como estaban");
    igual((await t.S()).equipos, aMano, "vuelven los equipos de antes del doble toque");
    // Dos toques separados siguen sorteando dos veces (el segundo es una acción nueva)
    await t.tap(btn); await esperar(500);
    const primero = (await t.S()).equipos;
    await t.tap(btn); await t.tap("#toast .tbtn");
    igual((await t.S()).equipos, primero, "↩️ deshace solo el último sorteo");
  });
}

await prueba("QA B7: inscribir, tocar un chip, pagar, 🍻 o sumar un gol quitan el ↩️ de la acción anterior", async (abrir) => {
  const insc = ["Carlos", "Seba", "Nico", "Mati", "Mako"].concat(J(11));
  const st = base({ inscritos: insc, caseros: ["Carlos", "Seba", "Nico", "Mati", "Mako", "Pedro"], costoCancha: "48000" });
  // (1) ⚖️ → Pagos → marcar a Carlos: el ↩️ de los equipos se va y la página no cambia los equipos
  let t = await abrir(st);
  await t.ir("equipos"); await t.tap("#equilibrar"); await t.toast("⚖️");
  const parejos = (await t.S()).equipos;
  await t.ir("pagos"); await t.tap('.pname[data-pay="Carlos"]');
  await sinDeshacer(t, "pagar después de ⚖️");
  await t.tap('.pname[data-pay="Seba"]');
  await sinDeshacer(t, "pagar otra vez");
  const S1 = await t.S();
  igual(S1.equipos, parejos, "los equipos parejos siguen");
  ok(S1.pagos.Carlos && S1.pagos.Seba, "pagos marcados");
  // 🍻 tras ✖
  await t.ir("convocatoria"); await t.tap('[data-del="Nico"]'); await t.toast("Nico se bajó");
  await t.ir("pagos"); await t.tap('[data-beer="Mati"]');
  await sinDeshacer(t, "🍻 después de una baja");
  // (2) ✖ Nico → ➕ Zeta / chip Pedro
  t = await abrir(st);
  await t.tap('[data-del="Nico"]'); await t.toast("Nico se bajó");
  await t.page.fill("#nuevo", "Zeta"); await t.tap("#agregar");
  await sinDeshacer(t, "➕ después de una baja");
  await t.tap('[data-del="Mati"]'); await t.toast("Mati se bajó");
  await t.tap('[data-add="Pedro"]');
  await sinDeshacer(t, "chip después de una baja");
  const S2 = await t.S();
  ok(S2.inscritos.includes("Zeta") && S2.inscritos.includes("Pedro") && !S2.inscritos.includes("Nico") && !S2.inscritos.includes("Mati"), "lo hecho se mantiene");
  // (3) Post: gol A, 💾 Guardar, gol B → el ↩️ de "Ganó el Equipo A" se va
  t = await abrir(base({ porLado: 3, inscritos: SEIS.slice(), equipos: { A: SEIS.slice(0, 3), B: SEIS.slice(3) } }));
  await t.ir("post");
  await t.tap('[data-gol="A,1"]'); await t.tap("#guardarPartido"); await t.toast("Partido guardado");
  await t.tap('[data-gol="B,1"]');
  await sinDeshacer(t, "gol después de guardar");
  igual(await t.txt("#guardarPartido"), "💾 Actualizar partido guardado", "botón para actualizar");
  // ...y un aviso sin acción nueva (ej. 'Ya está inscrito') sí conserva el ↩️
  t = await abrir(st);
  await t.tap('[data-del="Nico"]'); await t.toast("Nico se bajó");
  await t.page.fill("#nuevo", "carlos"); await t.tap("#agregar");
  await t.toast("Ya está inscrito");
  ok(await t.page.locator("#toast .tbtn").isVisible(), "el ↩️ de la baja sigue tras un aviso que no cambia nada");
  await t.tap("#toast .tbtn"); await t.toast("Nico volvió");
});

await prueba("Migración v2 → v4: un estado v2 se conserva entero (con copia)", async (abrir) => {
  const v2 = Object.assign(base(), { v: 2, inscritos: ["Ana", "Beto"], pagos: { Ana: { monto: 5000, fecha: "2026-10-16", previo: 2000 }, Beto: { monto: null, fecha: "" } },
    deudas: { Caro: [{ fecha: "", concepto: "Deuda anterior", monto: null }], Dani: [{ fecha: "2026-10-03", concepto: "Cancha", monto: 7000 }] }, costoCancha: "10000" });
  const t = await abrir(v2);
  const S = await t.S();
  igual(S.v, 5, "versión");
  igual([S.pagos, S.deudas, S.inscritos], [v2.pagos, v2.deudas, v2.inscritos], "pagos, deudas e inscritos intactos");
  igual(JSON.parse(await t.page.evaluate((k) => localStorage.getItem(k + "-antes-v5"), KEY)), v2, "copia de los datos v2");
});

/* ================= Pantallas ================= */
await prueba("Pantallas: sin scroll horizontal, toques ≥ 44px e inputs ≥ 16px a 320 y 390", async (abrir) => {
  const estado = base({ porLado: 7, inscritos: [...J(14), "Supl"], caseros: [...J(14), "Pablo", "Supl"], costoCancha: "49000", costoTercer: "20000", tercer: { J01: true },
    pagos: { J02: { monto: 1000, fecha: "" } }, deudas: { Pablo: [{ fecha: "2026-10-10", concepto: "Cancha + 🍻", monto: 19000 }], J03: [{ fecha: "", concepto: "Deuda anterior (monto por confirmar)", monto: null }] },
    ultimaLista: ["Otro"], post: { golesA: 10, golesB: 12, mvp: "", goleador: "", rustico: "", guardadoId: null }, v: 4, promovidos: ["J14"],
    banco: Object.assign(base().banco, { qr: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" }),
    historial: [{ id: 5, fecha: new Date().toISOString().slice(0, 8) + "02", golesA: 1, golesB: 0, A: ["J01"], B: ["J02"], mvp: "J01" }] });
  for (const width of [320, 390]) {
    const t = await abrir(estado, { width, height: width === 320 ? 568 : 844 });
    const medir = (sels) => t.page.evaluate((sels) => {
      const malos = [];
      for (const sel of sels) document.querySelectorAll(sel).forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width && (r.width < 43.5 || r.height < 43.5)) malos.push(`${sel} ${Math.round(r.width)}x${Math.round(r.height)}`);
      });
      document.querySelectorAll(".screen.active input:not([type=file]):not([type=checkbox]), .screen.active select, #sheet input:not([type=checkbox])").forEach((el) => {
        if (el.getBoundingClientRect().width && parseFloat(getComputedStyle(el).fontSize) < 16) malos.push(`${el.id} font ${getComputedStyle(el).fontSize}`);
      });
      if (document.scrollingElement.scrollWidth > innerWidth) malos.push(`scroll horizontal ${document.scrollingElement.scrollWidth}px`);
      return malos;
    }, sels);
    const tactiles = {
      convocatoria: [".x", ".chip:not(.in)", "#mismaLista", "#menos", "#mas", "#agregar", "#titulares .ren", "#editarCaseros", "#avisarSuben", "#cerrarSuben", "#pegarLista"],
      equipos: ["#azar", "#equilibrar", "#colorA", "#colorB", ".levels summary", ".levels .seg button", ".levels [data-arq]"],
      pagos: [".beer", ".state", ".pname", "[data-saldar]", "#waCobrar", "#waUno", "[data-cerrar]", "#s-pagos summary", "#copiarBanco", "#compartirQr", "#quitarQr", "[data-jugo]", "[data-igual]", "#redondeo", "#cajaBtn", "#acompDet summary"],
      post: ["[data-gol]", "#guardarPartido", "[data-cerrar]", "#mesAnt", "#mesSig", "#aMvp", "#waStats", "#pFecha", "#historial .fecha", "#historial .x", "#contarVotos", "#statsRango button"],
    };
    for (const [tab, sels] of Object.entries(tactiles)) {
      await t.ir(tab);
      if (tab === "equipos") await t.page.click(".levels summary"); // abre los niveles para medir sus botones
      const m = await medir(sels);
      ok(!m.length, `${width}px ${tab}: ${m.join(", ")}`);
    }
    await t.ir("pagos"); await t.tap('[data-saldar="Pablo"]');
    let m = await medir(["#sOk", "#sRecordar", "#sheet [data-cerrar-sheet]"]);
    ok(!m.length, `${width}px saldar: ${m.join(", ")}`);
    await t.page.keyboard.press("Escape");
    await t.tap(".screen.active [data-cerrar]");
    m = await medir(["#cOk", "#cEditar", "#sheet .check"]);
    ok(!m.length, `${width}px cerrar: ${m.join(", ")}`);
  }
});

/* ================= Ronda 2a: detalles menores (bugs 2-16, 21-36, 44-55, 58-66, 69-78) ================= */
const LARGOS = ["Sebastián Ignacio", "Maximiliano", "Juan Pablo Fernández", "Juan Pablo González", "Cristóbal", "Francisco Javier Muñoz", "Felipe Ossandón",
  "Rodrigo Hernández", "Diego Rojas", "Matías Ignacio", "Tomás", "Benjamín Andrés", "Vicente", "Agustín", "Joaquín", "Martín", "Ignacio", "Lucas", "Gaspar",
  "Bastián", "Nicolás", "Andrés", "Oscar Supl", "Pedro Supl", "Leo Supl", "Pancho Supl", "Gonzalo Supl", "Lucho Supl", "Rafa Supl", "Tito Supl", "Coke Supl"];
const hoy = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const esteMes = (dia) => hoy().slice(0, 8) + String(dia).padStart(2, "0");

await prueba("R2 bug 2: '−' y '+' avisan quién baja o sube (con ↩️) y se desactivan en 3 y 11", async (abrir) => {
  const t = await abrir(base({ inscritos: J(14) }));
  await t.tap("#menos");
  await t.toast("J13 y J14 pasan a suplentes");
  ok(await t.page.locator("#toast .tbtn").isVisible(), "trae ↩️ Deshacer");
  await t.tap("#toast .tbtn");
  igual((await t.S()).porLado, 7, "↩️ vuelve a 7 vs 7");
  await t.tap("#menos"); await t.tap("#mas");
  await t.toast("J13 y J14 suben a titular");
  ok(await t.page.locator("#avisoSuben").isVisible(), "aviso de los que suben");
  const t2 = await abrir(base({ porLado: 11 }));
  ok(await t2.page.locator("#mas").isDisabled(), "+ desactivado en 11");
  const t3 = await abrir(base({ porLado: 3 }));
  ok(await t3.page.locator("#menos").isDisabled(), "− desactivado en 3");
});

await prueba("R2 bugs 3, 4, 14, 15: nombres repetidos con mayúsculas, tildes, espacios, NFD o invisibles", async (abrir) => {
  const t = await abrir(base({ caseros: ["Carlos", "José"], niveles: { Carlos: 5 }, deudas: { Carlos: [{ fecha: "", concepto: "Deuda anterior", monto: null }] } }));
  const sumar = async (n) => { await t.page.fill("#nuevo", n); await t.tap("#agregar"); };
  await sumar("carlos");
  igual((await t.S()).inscritos, ["Carlos"], "'carlos' se inscribe como el casero 'Carlos'");
  ok((await t.txt('#caseros [data-add="Carlos"]')).startsWith("✓"), "chip de Carlos marcado");
  for (const n of ["Juan Pérez", "Juan  Pérez", " juan perez ", "Mati", "Matí", "José", "​", "​​ ", "Carlos​"]) await sumar(n);
  igual((await t.S()).inscritos, ["Carlos", "Juan Pérez", "Mati", "José"], "sin duplicados ni fantasmas (José NFD = casero José)");
  ok((await t.txt('#caseros [data-add="José"]')).startsWith("✓"), "chip de José marcado");
  await sumar("pedro "); await sumar("Pedro");
  igual(await t.page.inputValue("#nuevo"), "Pedro", "un nombre repetido no se borra del campo");
  await t.page.fill("#nuevo", ""); await t.tap("#agregar");
  await t.toast("Escribe el nombre");
  igual(await t.txt("#agregar"), "+", "botón con un + blanco");
  igual(await t.page.$eval("#agregar", (b) => getComputedStyle(b).color), "rgb(255, 255, 255)", "+ en blanco");
});

await prueba("R2 bug 5: renombrar sin perder lugar, pago, nivel ni deuda; quitar caseros; unir duplicados", async (abrir) => {
  const t = await abrir(base({ porLado: 3, inscritos: ["Ana", "Jaun", "Caro"], caseros: ["Ana", "Jaun", "Caro", "Juan", "Tipo"], niveles: { Jaun: 5 }, costoCancha: "3000",
    pagos: { Jaun: { monto: 1000, fecha: "" } }, deudas: { Jaun: [{ fecha: "2026-10-03", concepto: "Cancha", monto: 2000 }], Juan: [{ fecha: "2026-09-26", concepto: "Cancha", monto: 500 }] },
    equipos: { A: ["Ana", "Jaun"], B: ["Caro"] } }));
  await t.tap('#titulares [data-ren="Jaun"]');
  await t.hoja(); await t.page.fill("#rNombre", "Juanito");
  await t.tap("#rOk");
  let S = await t.S();
  igual(S.inscritos, ["Ana", "Juanito", "Caro"], "mismo lugar en la lista");
  igual([S.niveles.Juanito, S.pagos.Juanito.monto, S.deudas.Juanito[0].monto, S.equipos.A[1]], [5, 1000, 2000, "Juanito"], "nivel, pago, deuda y equipo");
  ok(!S.caseros.includes("Jaun") && S.caseros.includes("Juanito"), "casero renombrado");
  // Unir con un casero que ya existe (otra grafía de la misma persona)
  await t.tap('#titulares [data-ren="Juanito"]');
  await t.hoja(); await t.page.fill("#rNombre", "juan");
  await t.tap("#rOk");
  S = await t.S();
  igual(S.inscritos, ["Ana", "Juan", "Caro"], "unido con Juan");
  igual(S.deudas.Juan.map((e) => e.monto), [500, 2000], "deudas juntas");
  ok(t.dialogos.some((d) => d.includes("misma persona")), "pregunta antes de unir");
  // Quitar un casero
  await t.tap("#editarCaseros");
  await t.tap('#caseros [data-ren="Tipo"]');
  await t.hoja(); await t.tap("#rQuitar");
  ok(!(await t.S()).caseros.includes("Tipo"), "Tipo ya no es casero");
  await t.tap("#toast .tbtn");
  ok((await t.S()).caseros.includes("Tipo"), "↩️ lo devuelve");
});

await prueba("R2 bug 6: quien sube de suplente queda en un aviso con 📲 Avisar (aunque haya dos bajas seguidas)", async (abrir) => {
  const t = await abrir(base({ inscritos: J(16) }));
  await t.tap('[data-del="J01"]'); await esperar(BAJA); await t.tap('[data-del="J02"]');
  igual(await t.txt("#avisoSubenTxt"), "🔼 J15 y J16 subieron a titular", "aviso con los dos");
  ok((await t.txt("#titulares")).includes("J15 🔼 subió"), "marcados en la lista");
  await t.page.reload();
  ok(await t.page.locator("#avisoSuben").isVisible(), "el aviso sigue al recargar");
  await t.tap("#avisarSuben");
  const m = (await t.wa())[0];
  ok(m.includes("J15 y J16, quedaron de titulares") && m.includes("Sábado, 17 de octubre"), "mensaje para avisarles: " + m.split("\n")[0]);
  ok(await t.page.locator("#avisoSuben").isHidden(), "el aviso se va al avisar");
});

await prueba("R2 bugs 8-11, 13: convocatoria sin 'Por definir hrs', singular, lugar en blanco, fecha pasada y nombres con * _ ~", async (abrir) => {
  const t = await abrir(base({ fecha: "2025-01-05", hora: "", lugar: "   ", inscritos: ["*Negro*", "_Flaco_", "~Chino~", ...J(10)] }));
  ok(await t.page.locator("#mapLink").isHidden(), "sin lugar no hay botón Mapa");
  ok((await t.txt("#avisoFecha")).includes("ya pasó"), "aviso de fecha pasada");
  await t.tap("#waConvocar");
  ok(t.dialogos.some((d) => d.includes("ya pasó")), "pregunta antes de convocar a una fecha pasada");
  const m = (await t.wa())[0];
  ok(m.includes("⏰ Por definir\n"), "hora por definir sin 'hrs'");
  ok(m.includes("📍 Por definir\n") && !m.includes("🗺️"), "lugar en blanco = por definir, sin mapa");
  ok(m.includes("2025"), "fecha de otro año con el año");
  ok(m.includes("*Queda 1 cupo.*"), "singular: " + m.slice(-40));
  ok(m.includes("1. ∗Negro∗") && m.includes("2. ＿Flaco＿") && m.includes("3. ∼Chino∼"), "nombres sin marcas de formato");
  igual(await t.txt("#cupos"), "1 cupo libre", "badge en singular");
});

await prueba("R2 bug 12: nombres larguísimos no desbordan la pantalla (lista, chips, Pagos)", async (abrir) => {
  const largo = "A".repeat(60);
  for (const [width, height] of [[390, 844], [320, 568]]) {
    const t = await abrir(base({ inscritos: [largo, "Beto"], caseros: [largo, "Beto"], costoCancha: "10000" }), { width, height });
    for (const tab of ["convocatoria", "equipos", "pagos", "post"]) {
      await t.ir(tab);
      igual(await t.page.evaluate(() => document.scrollingElement.scrollWidth), width, `${width}px ${tab}: sin scroll horizontal`);
    }
    await t.ir("convocatoria");
    const x = await t.page.locator(`[data-del="${largo}"]`).boundingBox();
    ok(x.x + x.width <= width, `${width}px: ✖ a la vista`);
    igual(await t.page.getAttribute("#nuevo", "maxlength"), "30", "el campo limita el largo");
  }
});

await prueba("R2 bugs 21, 22: soltar fuera de la cancha cancela; un equipo no pasa de N", async (abrir) => {
  const t = await abrir(base({ inscritos: J(14), equipos: { A: J(7), B: J(14).slice(7) } }));
  await t.ir("equipos");
  const arrastrar = async (sel, a) => {
    const b = await t.page.locator(sel).boundingBox();
    await t.page.mouse.move(b.x + b.width / 2, b.y + 15); await t.page.mouse.down();
    await t.page.mouse.move(b.x + b.width / 2 + 5, b.y + 30, { steps: 3 });
    await t.page.mouse.move(a.x, a.y, { steps: 8 }); await t.page.mouse.up();
  };
  const antes = (await t.S()).equipos;
  const banca = await t.page.locator("#bench").boundingBox();
  await t.page.locator("#bench").scrollIntoViewIfNeeded();
  await arrastrar('.player[data-p="J02"]', { x: banca.x + 20, y: (await t.page.locator("#bench").boundingBox()).y + 10 });
  igual((await t.S()).equipos, antes, "soltar en la banca no cambia nada");
  await t.page.evaluate(() => document.getElementById("pitch").scrollIntoView({ block: "center" }));
  const pitch = await t.page.locator("#pitch").boundingBox();
  await arrastrar('.player[data-p="J02"]', { x: pitch.x + 6, y: pitch.y + pitch.height * 0.97 });
  igual((await t.S()).equipos, antes, "con 7 vs 7 no se puede pasar a 6 vs 8");
  await t.toast("ya tiene 7");
  const t2 = await abrir(base({ inscritos: J(12), equipos: { A: J(6), B: J(12).slice(6) } }));
  await t2.ir("equipos");
  const p2 = await t2.page.locator("#pitch").boundingBox();
  const b2 = await t2.page.locator('.player[data-p="J03"]').boundingBox();
  await t2.page.mouse.move(b2.x + b2.width / 2, b2.y + 15); await t2.page.mouse.down();
  await t2.page.mouse.move(p2.x + 6, p2.y + p2.height * 0.75, { steps: 10 }); await t2.page.mouse.up();
  igual((await t2.S()).equipos.B.length, 7, "con espacio sí pasa");
  await t2.toast("5 vs 7");
});

// Cajas que se tapan: placa de un jugador sobre la camiseta o la placa de otro
const choques = (t) => t.page.evaluate(() => {
  const els = [...document.querySelectorAll(".player")].map((p) => ({ n: p.dataset.p, kit: p.querySelector(".kit").getBoundingClientRect(), pl: p.querySelector(".plate").getBoundingClientRect() }));
  const cruza = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
  const out = [];
  els.forEach((a) => els.forEach((b) => { if (a !== b && (cruza(a.pl, b.kit) || (a.n < b.n && cruza(a.pl, b.pl)))) out.push(`${a.n}/${b.n}`); }));
  const pr = document.getElementById("pitch").getBoundingClientRect();
  els.forEach((a) => { if (a.pl.bottom > pr.bottom + 1 || a.kit.top < pr.top - 1) out.push(`${a.n} fuera`); });
  return out;
});
await prueba("R2 bug 23: cancha legible con 7, 10 y 11 por lado, a 320 y 390 (sin placas encimadas)", async (abrir) => {
  for (const por of [7, 10, 11]) for (const [width, height] of [[390, 844], [320, 568]]) {
    const ins = LARGOS.slice(0, por * 2);
    const t = await abrir(base({ porLado: por, inscritos: ins, equipos: { A: ins.slice(0, por), B: ins.slice(por) } }), { width, height });
    await t.ir("equipos");
    const c = await choques(t);
    ok(!c.length, `${por}v${por} a ${width}px: ${c.slice(0, 5).join(", ")}`);
    if (por === 7 && width === 390) {
      const cortados = await t.page.evaluate(() => [...document.querySelectorAll(".plate .nm")].filter((e) => e.scrollHeight > e.clientHeight + 1 || e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent));
      igual(cortados, [], "7v7 a 390: ningún nombre cortado");
    }
    const jp = await t.page.$$eval(".plate .nm", (es) => es.map((e) => e.textContent).filter((x) => x.startsWith("Juan Pablo")));
    igual(new Set(jp).size, jp.length, `${por}v${por} ${width}px: los dos Juan Pablo se distinguen (${jp.join(" / ")})`);
  }
});

await prueba("R2 bugs 24, 29, 30: imagen compartida sin nombres encimados, banca en renglones, fuente de respaldo y sin roundRect", async (abrir) => {
  const ins = LARGOS.slice(0, 31);
  const t = await abrir(base({ porLado: 11, inscritos: ins, equipos: { A: ins.slice(0, 11), B: ins.slice(11, 22) }, lugar: "Complejo Deportivo Municipal de Ñuñoa, Cancha Sintética N° 3" }));
  await t.ir("equipos");
  const r = await t.page.evaluate(() => {
    const textos = [], fuentes = new Set(), P = CanvasRenderingContext2D.prototype, orig = P.fillText;
    P.fillText = function (txt, x, y, mw) { fuentes.add(this.font); textos.push({ txt: String(txt), x, y, w: this.measureText(txt).width, f: this.font }); return orig.call(this, txt, x, y, mw); };
    delete P.roundRect;
    const c = cancha();
    P.fillText = orig;
    return { textos, fuentes: [...fuentes], H: c.height };
  });
  ok(r.fuentes.every((f) => /sans-serif/.test(f)), "todas las fuentes con respaldo sans-serif: " + r.fuentes.find((f) => !/sans-serif/.test(f)));
  const nombres = r.textos.filter((x) => /23px/.test(x.f));
  const malos = [];
  nombres.forEach((a) => nombres.forEach((b) => { if (a !== b && Math.abs(a.y - b.y) < 20 && Math.abs(a.x - b.x) < (a.w + b.w) / 2 + 4) malos.push(a.txt + "/" + b.txt); }));
  ok(!malos.length, "nombres encimados en la imagen: " + malos.slice(0, 4).join(", "));
  const banca = r.textos.filter((x) => /28px/.test(x.f));
  ok(banca.length >= 2 && banca.every((x) => x.w <= 960), `banca en ${banca.length} renglones legibles`);
  ok(r.textos.some((x) => x.txt.startsWith("Complejo") && x.txt.endsWith("…")), "lugar largo con …");
  // Sin roundRect (iOS 15): la imagen igual se arma y se descarga
  await t.page.evaluate(() => { delete CanvasRenderingContext2D.prototype.roundRect; navigator.canShare = () => false; });
  await t.tap("#compartirCancha");
  await t.toast("Imagen descargada");
});

await prueba("R2 bugs 25, 26, 33, 34, 35: colores distintos, arquero distinguible, formación por equipo, DEL en 3v3, aviso sin jugadores", async (abrir) => {
  const t = await abrir(base({ porLado: 7, inscritos: J(13), equipos: { A: J(6), B: J(13).slice(6) } }));
  await t.ir("equipos");
  igual(await t.txt("#formTxt"), "2-2-1 | 3-2-1", "formación de cada equipo");
  await t.page.selectOption("#colorB", "⚫ Negro");
  await t.toast("intercambiados");
  const S = await t.S();
  igual([S.colorA, S.colorB], ["🟢 Peto Flúor", "⚫ Negro"], "colores intercambiados");
  igual(await t.page.inputValue("#colorA"), "🟢 Peto Flúor", "select A actualizado");
  await t.page.selectOption("#colorA", "🟡 Amarillo"); await t.page.selectOption("#colorB", "🟠 Naranjo");
  const gk = await t.page.$eval('.player[data-p="J01"] .kit path', (p) => p.getAttribute("fill"));
  ok(!["#ffb300", "#ffd600", "#ff7a00"].includes(gk), "arquero de otro color: " + gk);
  const t2 = await abrir(base({ porLado: 3, inscritos: J(6), equipos: { A: J(3), B: J(6).slice(3) } }));
  await t2.ir("equipos");
  igual(await t2.page.$$eval(".kitw .pos", (es) => es.map((e) => e.textContent)), ["ARQ", "DEF", "DEL", "ARQ", "DEF", "DEL"], "3 vs 3 con DEF y DEL");
  const t3 = await abrir(base());
  await t3.ir("equipos");
  await t3.tap("#equilibrar"); await t3.toast("Primero inscribe jugadores");
  await t3.tap("#azar"); await t3.toast("Primero inscribe jugadores");
});

await prueba("R2 bugs 27, 28: arrastre interrumpido vuelve a su lugar; el suplente entra en el lugar del que se bajó", async (abrir) => {
  const t = await abrir(base({ inscritos: J(15), equipos: { A: J(7), B: J(14).slice(7) } }));
  await t.ir("equipos");
  const r = await t.page.evaluate(async () => {
    const el = document.querySelector('.player[data-p="J02"]'), b = el.getBoundingClientRect(), x = b.x + b.width / 2, y = b.y + 10;
    const ev = (tipo, o) => new PointerEvent(tipo, Object.assign({ bubbles: true, pointerId: 1, isPrimary: true, clientX: x, clientY: y, pointerType: "touch" }, o));
    el.dispatchEvent(ev("pointerdown"));
    el.dispatchEvent(ev("pointermove", { clientX: x + 80, clientY: y + 60 }));
    const otro = document.querySelector('.player[data-p="J05"]');
    otro.dispatchEvent(ev("pointerdown", { pointerId: 2, isPrimary: false })); // segundo dedo
    el.dispatchEvent(ev("pointercancel"));
    await new Promise((r) => setTimeout(r, 50));
    return { arrastrando: document.querySelectorAll(".player.dragging, .player.sel, .zone.drop").length, sel: selected };
  });
  igual(r, { arrastrando: 0, sel: null }, "sin jugador pegado, selección ni zona resaltada");
  await t.ir("convocatoria");
  await t.tap('[data-del="J01"]');
  await t.ir("equipos");
  const S = await t.S();
  igual(S.equipos.A[0], "J15", "J15 entra al arco en el lugar de J01");
  await t.toast("J15 entra por J01");
});

await prueba("R2 bugs 31, 32: niveles con nombres largos y para suplentes y caseros", async (abrir) => {
  const largo = "MaximilianoAlejandroGonzalezRojas";
  const t = await abrir(base({ porLado: 3, inscritos: [largo, ...J(6)], caseros: [largo, ...J(6), "Casero"] }), { width: 320, height: 568 });
  await t.ir("equipos");
  await t.tap(".levels summary");
  const w = await t.page.$$eval(`.levels .seg button[data-n="${largo}"]`, (bs) => bs.map((b) => Math.round(b.getBoundingClientRect().width)));
  igual(w, [44, 44, 44, 44, 44], "botones 1-5 enteros");
  const filas = await t.page.$$eval("#niveles li", (ls) => ls.map((l) => l.querySelector(".name").textContent));
  ok(filas.some((f) => f.includes("J06") && f.includes("suplente")) && filas.some((f) => f.includes("Casero") && f.includes("casero")), "suplente y casero en la lista");
  await t.tap('.seg button[data-n="J06"][data-lvl="5"]');
  igual((await t.S()).niveles.J06, 5, "nivel de un suplente");
});

await prueba("R2 bugs 47, 48, 50, 51: compartir y quitar el QR, sin imagen rota, imagen ilegible avisa", async (abrir) => {
  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const t = await abrir(base());
  await t.ir("pagos");
  ok(await t.page.locator("#qrView").isHidden() && await t.page.locator("#qrAcciones").isHidden(), "sin QR no se ve imagen rota ni botones");
  const f = path.join(os.tmpdir(), `qr-malo-${process.pid}.png`);
  fs.writeFileSync(f, "esto no es una imagen");
  await t.page.locator("#s-pagos details summary").first().click();
  await t.page.setInputFiles("#bQr", f);
  await t.toast("No pude leer esa imagen");
  igual(await t.page.inputValue("#bQr"), "", "el campo se limpia");
  fs.writeFileSync(f, Buffer.from(PNG.split(",")[1], "base64"));
  await t.page.setInputFiles("#bQr", f);
  await t.toast("QR guardado");
  fs.unlinkSync(f);
  igual(await t.page.evaluate(() => localStorage.getItem("pichanga-v1-qr").startsWith("data:image/png")), true, "QR guardado en su propia clave");
  igual((await t.S()).banco.qr, "", "los datos principales no cargan la imagen");
  await t.page.evaluate(() => { navigator.canShare = () => false; });
  await t.tap("#compartirQr");
  await t.toast("QR descargado");
  await t.tap("#quitarQr");
  ok(await t.page.locator("#qrView").isHidden(), "QR quitado");
  await t.S();
  igual(await t.page.evaluate(() => localStorage.getItem("pichanga-v1-qr")), null, "y borrado del teléfono");
  await t.tap("#toast .tbtn");
  ok(await t.page.locator("#qrView").isVisible(), "↩️ lo devuelve");
  await t.ir("convocatoria"); await t.page.reload(); await t.ir("pagos");
  ok(await t.page.locator("#qrView").isVisible(), "sigue tras recargar");
});

await prueba("R2 bugs 52, 53, 54: copiar sin datos, cobrar sin inscritos y costos negativos", async (abrir) => {
  const t = await abrir(base());
  await t.ir("pagos");
  await t.page.evaluate(() => navigator.clipboard.writeText("lo de antes").catch(() => {}));
  await t.tap("#copiarBanco");
  await t.toast("Primero agrega tus datos");
  ok(await t.page.locator("#bNombre").isVisible(), "abre Editar datos");
  await t.page.fill("#bNombre", "Juan"); await t.page.dispatchEvent("#bNombre", "input");
  await t.page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true }); });
  await t.tap("#copiarBanco");
  await t.page.waitForFunction(() => /copia/i.test(document.getElementById("toast").textContent));
  await t.page.locator("#costoCancha").pressSequentially("-5000");
  igual(await t.page.inputValue("#costoCancha"), "5.000", "sin signo negativo");
  await t.tap("#waCobrar");
  await t.toast("No hay jugadores inscritos");
});

await prueba("R2 bug 55: suplentes en Pagos: 🍻 y ⚽ jugó (las cuotas siguen sumando exacto)", async (abrir) => {
  const t = await abrir(base({ v: 4, porLado: 7, inscritos: J(15), costoCancha: "49000", costoTercer: "12000", tercer: { J01: true, J02: true } }));
  await t.ir("pagos");
  ok(await t.page.locator("#pagosSup [data-beer='J15']").isVisible(), "el suplente tiene 🍻");
  await t.tap("#pagosSup [data-beer='J15']");
  ok((await t.txt("#pagosSup")).includes("$4.000"), "J15 paga su parte del 🍻: " + await t.txt("#pagosSup"));
  await t.tap("#pagosSup [data-jugo='J15']");
  const r = await t.page.evaluate(() => ({ suma: cobrados().reduce((s, n) => s + deuda(n), 0), j15: deuda("J15") }));
  igual(r.suma, 61000, "cancha + 🍻 suman exacto");
  igual(r.j15, 3266 + 4000, "J15 paga cancha entre 15 y 🍻 entre 3");
  await t.tap("#pagosSup [data-pay='J15']");
  igual((await t.S()).pagos.J15.monto, 7266, "se le marca el pago");
  await t.page.reload();
  igual((await t.S()).tercer.J15, true, "el 🍻 del suplente se guarda");
});

await prueba("R2 bug 58: datos dañados (banco null, equipos sin B, partido sin fecha) no rompen la app ni Restaurar", async (abrir) => {
  const t = await abrir({ banco: null, equipos: { A: ["Ana"] }, post: null, colorA: "🟣", inscritos: ["Ana", "Beto"], historial: [{ golesA: 1 }, { id: "x", fecha: esteMes(3), golesA: 2, golesB: 0 }] });
  for (const tab of ["equipos", "pagos", "post", "convocatoria"]) await t.ir(tab);
  const S = await t.S();
  igual([S.historial.length, Number.isSafeInteger(S.historial[1].id)], [2, true], "partidos con id (el sin fecha se conserva)");
  const f = path.join(os.tmpdir(), `respaldo-bueno-${process.pid}.json`);
  fs.writeFileSync(f, JSON.stringify({ app: "pichanga", version: 4, datos: base({ inscritos: ["Zeta"] }) }));
  await t.ir("post"); await t.page.setInputFiles("#importar", f);
  await t.toast("Respaldo restaurado");
  fs.unlinkSync(f);
  igual((await t.S()).inscritos, ["Zeta"], "Restaurar funciona");
});

await prueba("R2 bugs 59, 60, 64: ranking con empates, historial por fecha y victorias con el color de cada partido", async (abrir) => {
  const P = (id, dia, ga, gb, mvp, cA = "⚫ Negro") => ({ id, fecha: esteMes(dia), lugar: "", golesA: ga, golesB: gb, colorA: cA, colorB: "🟢 Peto Flúor", A: ["Ana"], B: ["Beto"], mvp, goleador: "", rustico: "" });
  const t = await abrir(base({ colorA: "🔴 Rojo", historial: [P(1, 20, 2, 0, "Beto"), P(2, 5, 1, 0, "Ana"), P(3, 12, 0, 0, "Caro")] }));
  await t.ir("post");
  const rk = await t.txt("#ranking");
  ok(["Ana", "Beto", "Caro"].every((n) => rk.includes(n)), "los tres empatados en el ranking: " + rk);
  const fechas = await t.page.$$eval("#historial .fecha", (es) => es.map((e) => e.textContent));
  igual(fechas.map((f) => +f.replace(/\D/g, "")), [20, 12, 5], "del más reciente al más antiguo");
  const colores = await t.page.$$eval("#statsBar span", (es) => es.map((e) => getComputedStyle(e).backgroundColor));
  ok(colores.includes("rgb(27, 27, 27)") && !colores.includes("rgb(229, 57, 53)"), "las victorias de Negro se ven en negro: " + colores);
  await t.tap("#waStats");
  const m = (await t.wa())[0];
  ok(m.includes("Equipo A: 2 victorias") && m.includes("Equipo B: 0 victorias") && m.includes("Ana (1), Beto (1), Caro (1)"), "WhatsApp con la misma lógica");
  ok(m.indexOf("• 20/") < m.indexOf("• 05/"), "últimos partidos por fecha");
});

await prueba("R2 bugs 62, 63: fecha del partido visible y editable; votación con ejemplo válido, fecha real y resultado", async (abrir) => {
  const t = await abrir(base({ fecha: "", porLado: 3, inscritos: SEIS.slice(), equipos: { A: SEIS.slice(0, 3), B: SEIS.slice(3) } }));
  await t.ir("post");
  igual(await t.page.inputValue("#pFecha"), hoy(), "sin fecha en Convocatoria: hoy");
  await t.tap('[data-gol="A,1"]'); await t.tap('[data-gol="B,1"]');
  await t.tap("#waVotar");
  const m = (await t.wa())[0];
  ok(m.includes("Equipo A 1 - 1 Equipo B"), "resultado actual");
  ok(!m.includes("Por definir"), "con fecha real");
  const ej = m.match(/Ejemplo: \*([\d, ]+)\*/)[1].split(",").map(Number);
  ok(ej.every((n) => n >= 1 && n <= 6) && new Set(ej).size === 3, "ejemplo con números que existen: " + ej);
  const ayer = (() => { const d = new Date(Date.now() - 864e5); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
  await t.page.fill("#pFecha", ayer); await t.page.dispatchEvent("#pFecha", "change");
  await t.tap("#guardarPartido");
  igual((await t.S()).historial[0].fecha, ayer, "se guarda con la fecha elegida");
  await t.toast("📆");
  await t.page.goto(FILE + "#post"); // el mes del partido (por si ayer fue otro mes)
  await t.hoja();
  await t.page.evaluate((f) => { mesVista = new Date(f + "T12:00:00"); mesVista.setDate(1); renderPost(); }, ayer);
  await t.tap("#historial .fecha");
  await t.hoja(); await t.page.fill("#hFecha", hoy()); await t.tap("#hOk");
  igual((await t.S()).historial[0].fecha, hoy(), "fecha corregida desde el historial");
});

await prueba("R2 bug 65: cancelar Restaurar y elegir el mismo archivo vuelve a preguntar", async (abrir) => {
  const t = await abrir(base());
  const f = path.join(os.tmpdir(), `respaldo-otra-vez-${process.pid}.json`);
  fs.writeFileSync(f, JSON.stringify({ app: "pichanga", version: 4, datos: base({ inscritos: ["Zeta"] }) }));
  await t.ir("post");
  t.respuestas.push(false);
  await t.page.setInputFiles("#importar", f);
  await t.page.waitForFunction(() => document.getElementById("importar").value === "");
  await t.page.setInputFiles("#importar", f);
  await t.toast("Respaldo restaurado");
  fs.unlinkSync(f);
  igual(t.dialogos.filter((d) => d.includes("Reemplazar")).length, 2, "preguntó las dos veces");
});

await prueba("R2 bug 66: a 320 px los premios muestran el nombre completo", async (abrir) => {
  const t = await abrir(base({ porLado: 3, inscritos: ["Juan Pablo Fernández", "Juan Pablo González", "Ana", "Beto", "Caro", "Dani"] }), { width: 320, height: 568 });
  await t.ir("post");
  await t.page.selectOption("#aMvp", "Juan Pablo Fernández");
  const w = await t.page.$eval("#aMvp", (s) => s.getBoundingClientRect().width);
  ok(w >= 240, "select a lo ancho: " + w);
});

await prueba("R2 bugs 69, 78: se guarda una vez por ráfaga de teclas; sin espacio se avisa y no se pierde en silencio", async (abrir) => {
  const t = await abrir(base());
  const escrituras = await t.page.evaluate(() => new Promise((r) => {
    let c = 0; const o = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) { if (k === "pichanga-v1") c++; return o.call(this, k, v); };
    const el = document.getElementById("lugar"); el.value = "";
    for (const ch of "Cancha Los Leones") { el.value += ch; el.dispatchEvent(new Event("input")); }
    setTimeout(() => r(c), 400);
  }));
  igual(escrituras, 1, "17 teclas = una escritura");
  igual((await t.S()).lugar, "Cancha Los Leones", "lo escrito queda guardado");
  // Escribir y salir enseguida (antes de la escritura diferida): se guarda al salir
  const alSalir = await t.page.evaluate(() => {
    const el = document.getElementById("lugar"); el.value = "Otra cancha"; el.dispatchEvent(new Event("input"));
    const antes = JSON.parse(localStorage.getItem("pichanga-v1")).lugar;
    dispatchEvent(new Event("pagehide"));
    return [antes, JSON.parse(localStorage.getItem("pichanga-v1")).lugar];
  });
  igual(alSalir, ["Cancha Los Leones", "Otra cancha"], "lo pendiente se escribe al salir");
  // Memoria llena
  await t.page.evaluate(() => { Storage.prototype.setItem = function () { throw new DOMException("lleno", "QuotaExceededError"); }; });
  await t.page.fill("#nuevo", "Pedro"); await t.tap("#agregar");
  await t.page.waitForFunction(() => !document.getElementById("avisoGuardar").hidden, null, { timeout: 2000 });
  ok((await t.txt("#avisoGuardar")).includes("No se pudo guardar"), "aviso visible");
});

await prueba("R2 bug 72: el aviso no bloquea toques y no sigue en la pestaña siguiente", async (abrir) => {
  const t = await abrir(base({ inscritos: J(14), equipos: { A: J(7), B: J(14).slice(7) } }));
  await t.ir("equipos");
  await t.tap('.player[data-p="J02"]');
  await t.toast("toca a otro jugador");
  igual(await t.page.$eval("#toast", (e) => getComputedStyle(e).pointerEvents), "none", "el aviso deja pasar los toques");
  await t.ir("pagos");
  ok(!(await t.page.$eval("#toast", (e) => e.classList.contains("show"))), "el aviso se cierra al cambiar de pestaña");
});

await prueba("R2 bugs 74, 75: recordatorio de respaldo y la app vuelve a la última pestaña", async (abrir) => {
  const t = await abrir(base({ historial: [{ id: 1, fecha: esteMes(3), golesA: 1, golesB: 0, A: [], B: [] }] }));
  await t.ir("post");
  ok((await t.txt("#respaldoInfo")).includes("Todavía no guardas"), "avisa que no hay respaldo");
  await t.tap("#exportar");
  await t.page.waitForFunction(() => document.getElementById("respaldoInfo").textContent.includes("hoy"));
  ok((await t.S()).ultimoRespaldo.startsWith(new Date().toISOString().slice(0, 4)), "fecha del respaldo guardada");
  await t.ir("pagos");
  await t.page.reload();
  ok(await t.page.locator("#s-pagos").isVisible(), "recargar sigue en Pagos");
  await t.page.goto(FILE); // el sistema cerró la app: se abre sin pestaña en la URL
  ok(await t.page.locator("#s-pagos").isVisible(), "vuelve a Pagos");
});

await prueba("R2 bug 76: dos ventanas abiertas no se borran los cambios", async (abrir) => {
  const t = await abrir(base({ porLado: 3, inscritos: SEIS.slice(), equipos: { A: SEIS.slice(0, 3), B: SEIS.slice(3) } }));
  const p2 = await t.ctx.newPage();
  await p2.goto(FILE);
  await t.page.fill("#nuevo", "A1"); await t.tap("#agregar");
  await t.page.evaluate(() => guardarYa());
  await p2.waitForFunction(() => S.inscritos.includes("A1"));
  await p2.click('nav.tabs button[data-go="s-post"]');
  await p2.click('[data-gol="A,1"]'); await p2.click("#guardarPartido");
  await p2.evaluate(() => guardarYa());
  await t.page.waitForFunction(() => S.historial.length === 1);
  await t.page.fill("#nuevo", "A3"); await t.tap("#agregar");
  const S = await t.S();
  igual([S.historial.length, S.inscritos.includes("A1"), S.inscritos.includes("A3")], [1, true, true], "el partido de la otra ventana se conserva");
});

await prueba("R2 bug 77: el service worker solo borra cachés viejas de Pichanga", async () => {
  const vm = await import("node:vm");
  const borradas = [], h = {};
  const ctx = { self: { addEventListener: (ev, fn) => (h[ev] = fn), location: new URL("https://x.github.io/Mi_Pichanga/sw.js"), clients: { claim: async () => {} }, skipWaiting: () => {} },
    caches: { keys: async () => ["otra-app-v3", "pichanga-v1", "pichanga-v8", "pichangas-de-otro"], delete: async (k) => borradas.push(k) }, URL, location: { origin: "https://x.github.io" } };
  vm.default.runInNewContext(fs.readFileSync(path.join(ROOT, "sw.js"), "utf8"), ctx);
  let p; h.activate({ waitUntil: (x) => (p = x) }); await p;
  igual(borradas, ["pichanga-v1"], "solo la versión vieja de esta app");
});

await prueba("R2 migración: v3 con QR dentro y sin campos nuevos queda en v4 sin perder nada", async (abrir) => {
  const QR = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const v3 = base({ inscritos: J(16), tercer: { J01: true, J15: true }, banco: Object.assign(base().banco, { nombre: "Juan", qr: QR }), post: { golesA: 1, golesB: 0, mvp: "J01", goleador: "", rustico: "", guardadoId: null } });
  const t = await abrir(v3);
  const S = await t.S();
  igual(S.v, 5, "versión 5");
  igual([S.promovidos, S.jugo, S.ultimoRespaldo, S.post.fecha, S.post.mvp], [[], {}, "", "", "J01"], "campos nuevos con valores por defecto");
  igual(S.tercer, { J01: true }, "🍻 viejo de un suplente no se cobra (antes no existía)");
  igual(await t.page.evaluate(() => localStorage.getItem("pichanga-v1-qr")), QR, "el QR pasa a su propia clave");
  igual(S.banco.nombre, "Juan", "datos del banco");
  igual(JSON.parse(await t.page.evaluate(() => localStorage.getItem("pichanga-v1-antes-v5"))).banco.qr, QR, "copia intacta de los datos v3");
  await t.ir("pagos");
  ok(await t.page.locator("#qrView").isVisible(), "el QR se sigue viendo");
});

/* ================= B12: service worker ================= */
/* ================= Ronda 2b ================= */
await prueba("F3: pegar la lista del grupo inscribe en orden (con ↩️ Deshacer)", async (abrir) => {
  const t = await abrir(base({ porLado: 3, inscritos: ["Ana"], caseros: ["Ana", "Beto"] }));
  const lista = "⚽ *NUEVA PICHANGA* ⚽\n\n📅 Sábado, 17 de octubre\n⏰ 20:00 hrs\n\n*Inscritos (5/6):*\n1. Ana\n2. beto ✅\n3) *Caro*\n4. Dani (confirmado)\n5.\n- Eli\n• Fede\n7. Gabi\n\n⏳ *Suplentes:*\n1. Hugo";
  await t.tap("#pegarLista");
  await t.page.fill("#plTxt", lista);
  igual(await t.txt("#plOk"), "✅ Inscribir 7 jugadores", "cuenta solo los nuevos");
  ok((await t.txt("#plNota")).includes("1 ya estaba") && (await t.txt("#plNota")).includes("2 quedan de suplentes"), "avisa repetidos y suplentes");
  await t.tap("#plOk");
  await t.toast("📋 7 inscritos");
  igual((await t.S()).inscritos, ["Ana", "Beto", "Caro", "Dani", "Eli", "Fede", "Gabi", "Hugo"], "en orden y con la forma guardada (Beto)");
  await t.tap("#toast .tbtn");
  igual((await t.S()).inscritos, ["Ana"], "↩️ Deshacer");
  igual((await t.S()).caseros, ["Ana", "Beto"], "↩️ también saca a los caseros nuevos");
});

await prueba("F3: formatos de lista (comas, y, viñetas, vacíos)", async (abrir) => {
  const t = await abrir(base());
  const r = await t.page.evaluate(() => [leerLista("Carlos, Seba y Nico"), leerLista("1- José\n2- jose\n3- (libre)\n4- _Mati_ 👍"), leerLista("Pancho\nRodrigo\n")]);
  igual(r, [["Carlos", "Seba", "Nico"], ["José", "Mati"], ["Pancho", "Rodrigo"]], "lee los formatos");
});

await prueba("F5: 🧤 arqueros fijos quedan uno en cada equipo", async (abrir) => {
  const lv = [5, 5, 4, 4, 3, 3, 3, 3, 3, 1, 1, 1, 1, 1];
  const niveles = Object.fromEntries(J(14).map((n, i) => [n, lv[i]]));
  const t = await abrir(base({ inscritos: J(14), niveles, arqueros: { J10: true, J14: true } }));
  await t.ir("equipos");
  for (let i = 0; i < 6; i++) {
    await t.tap(i % 2 ? "#azar" : "#equilibrar");
    const { A, B } = (await t.S()).equipos;
    igual([A.length, B.length], [7, 7], `corrida ${i + 1}: 7 vs 7`);
    igual([A[0], B[0]].sort(), ["J10", "J14"], `corrida ${i + 1}: arqueros al arco`);
    if (!(i % 2)) { const s = (x) => x.reduce((a, n) => a + niveles[n], 0); igual(s(A), s(B), `corrida ${i + 1}: parejo`); }
    await t.page.waitForTimeout(470);
  }
  // Un solo arquero: va al arco de un equipo; tocar 🧤 en la lista de niveles lo marca o desmarca
  await t.page.click("details summary");
  await t.tap('[data-arq="J14"]');
  igual(Object.keys((await t.S()).arqueros), ["J10"], "🧤 desmarcado");
  await t.tap("#equilibrar");
  const { A, B } = (await t.S()).equipos;
  ok(A[0] === "J10" || B[0] === "J10", "el único arquero va al arco");
});

await prueba("F6: sin caseros de ejemplo; teléfono y 🧤 se guardan y siguen al renombrar", async (abrir) => {
  let t = await abrir(null);
  igual((await t.S()).caseros, [], "instalación nueva sin caseros inventados");
  ok((await t.txt("#titulares")).includes("pega la lista"), "sugiere pegar la lista");
  t = await abrir(base({ inscritos: ["Ana"], caseros: ["Ana"] }));
  await t.tap('#titulares [data-ren="Ana"]');
  await t.page.fill("#rTel", "12");
  await t.tap("#rOk");
  await t.toast("parece incompleto");
  await t.page.fill("#rTel", "9 8765 4321");
  await t.page.check("#rArq");
  await t.tap("#rOk");
  let S = await t.S();
  igual([S.telefonos.Ana, S.arqueros.Ana], ["9 8765 4321", true], "guardados");
  await t.tap('#titulares [data-ren="Ana"]');
  await t.page.fill("#rNombre", "Ana María");
  await t.tap("#rOk");
  S = await t.S();
  igual([S.telefonos["Ana María"], S.arqueros["Ana María"], S.telefonos.Ana], ["9 8765 4321", true, undefined], "se van con el nombre nuevo");
});

await prueba("F7: se bajó y paga igual (💸): los demás no pagan su parte y queda en el cierre", async (abrir) => {
  const t = await abrir(base({ porLado: 3, inscritos: J(6), caseros: J(6), costoCancha: "30000" }));
  await t.tap('[data-del="J01"]');
  await t.toast("Si paga igual");
  await t.ir("pagos");
  ok(!(await t.page.isHidden("#pagosBajaBox")), "aparece en Se bajaron");
  ok((await t.txt("#pagosBaja")).includes("no paga"), "por defecto no paga");
  ok((await t.txt("#porCancha")).startsWith("$6.000"), "sin él, 5 pagan $6.000");
  await t.tap('[data-igual="J01"]');
  ok((await t.txt("#porCancha")).startsWith("$5.000"), "con él, $5.000 cada uno");
  ok((await t.txt("#pagosBaja")).includes("$5.000"), "a él le toca $5.000");
  await t.tap('#pagosBaja .state[data-pay="J01"]');
  igual((await t.S()).pagos.J01.monto, 5000, "se le puede marcar pagado");
  await t.page.waitForTimeout(470);
  await t.tap('#pagosBaja .state[data-pay="J01"]');
  ok(!(await t.S()).pagos.J01, "y desmarcar");
  await t.tap("[data-cerrar]");
  await t.tap("#cOk");
  const S = await t.S();
  igual(S.deudas.J01, [{ fecha: "2026-10-17", concepto: "Cancha (se bajó y paga igual)", monto: 5000 }], "su parte queda en la libreta");
  igual([S.bajas, S.pagaIgual], [[], {}], "la próxima pichanga parte sin bajas");
});

await prueba("F7: si el que se bajó vuelve, deja de ser baja", async (abrir) => {
  const t = await abrir(base({ porLado: 3, inscritos: J(6), caseros: J(6), costoCancha: "30000" }));
  await t.tap('[data-del="J02"]');
  igual((await t.S()).bajas, ["J02"], "baja");
  await t.tap('.chip[data-add="J02"]');
  igual((await t.S()).bajas, [], "volvió");
});

await prueba("F8: 💬 cobro individual directo al teléfono del jugador", async (abrir) => {
  const t = await abrir(base({ porLado: 3, inscritos: J(6), costoCancha: "30000", telefonos: { J02: "9 1234 5678" }, banco: { nombre: "Juan", rut: "", banco: "", tipo: "", cuenta: "123", mail: "", link: "", qr: "" },
    deudas: { J02: [{ fecha: "2026-10-10", concepto: "Cancha", monto: 4000 }] } }));
  await t.page.evaluate(() => { const o = window.open; window.__urls = []; window.open = (u) => { window.__urls.push(u); return o(u); }; });
  await t.ir("pagos");
  await t.tap("#waUno");
  ok((await t.txt(".cobro1")).includes("📱 J02") && (await t.txt(".cobro1")).includes("👤 J03"), "marca quién tiene teléfono");
  await t.tap('[data-uno="J02"]');
  const [url] = await t.page.evaluate(() => window.__urls), m = (await t.wa())[0];
  ok(url.startsWith("https://wa.me/56912345678?text="), "abre el chat de J02: " + url.slice(0, 40));
  ok(m.includes("Te toca pagar $5.000") && m.includes("$4.000 de fechas anteriores") && m.includes("Cuenta: 123"), "mensaje con cuota, deuda y datos");
  await t.tap('[data-uno="J03"]');
  ok((await t.page.evaluate(() => window.__urls))[1].startsWith("https://wa.me/?text="), "sin teléfono elige el contacto en WhatsApp");
  await t.tap("[data-cerrar-sheet]");
  await t.tap('.state[data-pay="J03"]');
  await t.tap("#waUno");
  ok(!(await t.page.locator('[data-uno="J03"]').count()), "quien pagó no aparece");
});

/* ================= Ronda 3 ================= */
const PARTIDO = (id, fecha, gA, gB, A, B, x = {}) => Object.assign({ id, fecha, lugar: "", golesA: gA, golesB: gB, colorA: "⚫ Negro", colorB: "🟢 Peto Flúor", A, B, mvp: "", goleador: "", rustico: "" }, x);
const hoyR3 = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

await prueba("F9: estadísticas por jugador del mes y del año", async (abrir) => {
  const m = hoyR3().slice(0, 7), otroMes = (+m.slice(5) === 1 ? m.slice(0, 5) + "02" : m.slice(0, 5) + "01");
  const t = await abrir(base({ historial: [
    PARTIDO(1, m + "-01", 2, 1, ["Ana", "Beto"], ["Caro", "Dani"], { mvp: "Ana", goleador: "Ana" }),
    PARTIDO(2, m + "-02", 0, 0, ["Ana", "Caro"], ["Beto", "Dani"], { rustico: "Beto" }),
    PARTIDO(3, otroMes + "-03", 0, 3, ["Ana"], ["Caro"], { mvp: "Caro" }),
  ] }));
  await t.ir("post");
  const fila = (n) => t.page.evaluate((n) => [...document.querySelectorAll("#statsTabla tbody tr")].find((r) => r.cells[0].textContent === n)?.innerText.split("\t").slice(1).map(Number), n);
  igual(await fila("Ana"), [2, 1, 1, 0, 1, 1, 0], "Ana en el mes: PJ G E P ⭐ 👟 🪓");
  igual(await fila("Beto"), [2, 1, 1, 0, 0, 0, 1], "Beto en el mes");
  await t.tap('[data-rango="anio"]');
  igual(await fila("Ana"), [3, 1, 1, 1, 1, 1, 0], "Ana en el año");
  ok((await t.txt("#statsSub")).includes("3 partidos"), "cuenta partidos del año");
});

await prueba("F10: contar votos pegados del grupo (último voto vale, empates no se eligen solos)", async (abrir) => {
  const t = await abrir(base({ porLado: 3, inscritos: ["Ana", "Beto", "Caro", "Dani", "Eli", "Fede"], equipos: { A: ["Ana", "Beto", "Caro"], B: ["Dani", "Eli", "Fede"] } }));
  await t.ir("post");
  await t.tap("#waVotar");
  igual((await t.S()).post.votoLista, ["Ana", "Beto", "Caro", "Dani", "Eli", "Fede"], "guarda la lista de la votación");
  await t.tap("#contarVotos");
  await t.page.fill("#vTxt", [
    "[17/10/26, 21:03:15] Pato: 2, 5, 6",
    "17/10/26, 21:05 - Memo: 2 4 6",
    "17/10/26, 21:06 - Pato: 1 4 3",
    "Seba: 2-4-5",
    "Ejemplo: *4, 6, 1*",
    "Lucho: 9 9 9",
    "jaja buena",
  ].join("\n"));
  await t.page.dispatchEvent("#vTxt", "input");
  const res = await t.txt("#vRes");
  ok(res.includes("3 votos") && res.includes("1 respuesta sin entender"), "cuenta votos válidos: " + res);
  ok(res.includes("Beto (2)") && res.includes("Dani (3)") && res.includes("empate"), "MVP Beto, Goleador Dani, Rústico empatado");
  await t.tap("#vOk");
  const S = await t.S();
  igual([S.post.mvp, S.post.goleador, S.post.rustico], ["Beto", "Dani", ""], "usa los ganadores y deja el empate para elegir");
});

await prueba("F11: un suplente entra desde la banca (tocar o arrastrar) en el lugar del titular", async (abrir) => {
  const t = await abrir(base({ porLado: 3, inscritos: ["Ana", "Beto", "Caro", "Dani", "Eli", "Fede", "Gabi", "Hugo"], equipos: { A: ["Ana", "Beto", "Caro"], B: ["Dani", "Eli", "Fede"] } }));
  await t.ir("equipos");
  await t.tap('[data-banca="Gabi"]');
  await t.toast("toca al jugador");
  await t.tap('.player[data-p="Beto"]');
  let S = await t.S();
  igual([S.equipos.A, S.inscritos.slice(6)], [["Ana", "Gabi", "Caro"], ["Beto", "Hugo"]], "Gabi entra por Beto y Beto va a la banca");
  // Arrastrar a Hugo sobre Dani (el arquero del B)
  await t.page.waitForTimeout(470);
  const de = await t.page.locator('[data-banca="Hugo"]').boundingBox(), a = await t.page.locator('.player[data-p="Dani"]').boundingBox();
  await t.page.mouse.move(de.x + de.width / 2, de.y + de.height / 2); await t.page.mouse.down();
  await t.page.mouse.move(de.x + 30, de.y - 30, { steps: 4 });
  await t.page.mouse.move(a.x + a.width / 2, a.y + a.height / 3, { steps: 6 });
  await t.page.mouse.up();
  S = await t.S();
  igual(S.equipos.B[0], "Hugo", "Hugo entra al arco del B");
  ok(S.inscritos.slice(6).includes("Dani") && !(await t.page.locator(".fantasma").count()), "Dani a la banca y sin fantasma");
  await t.tap("#toast .tbtn");
  igual((await t.S()).equipos.B[0], "Dani", "↩️ Deshacer");
});

await prueba("F11: acompañantes al 🍻 pagan solo el tercer tiempo", async (abrir) => {
  const t = await abrir(base({ porLado: 3, inscritos: J(6), costoCancha: "30000", costoTercer: "9000", tercer: { J01: true, J02: true } }));
  await t.ir("pagos");
  await t.page.click("#acompDet summary");
  await t.page.fill("#acompNombre", "Polola de J01");
  await t.tap("#acompOk");
  ok((await t.txt("#pagosAcomp")).includes("$3.000"), "le toca un tercio del 🍻");
  ok((await t.txt("#porCancha")).startsWith("$5.000"), "la cancha no cambia");
  await t.tap("[data-cerrar]"); await t.tap("#cOk");
  igual((await t.S()).deudas["Polola de J01"], [{ fecha: "2026-10-17", concepto: "🍻 Tercer tiempo", monto: 3000 }], "su 🍻 queda en la libreta");
});

await prueba("F13: editar un partido del historial (marcador, premios y fecha)", async (abrir) => {
  const f = hoyR3();
  const t = await abrir(base({ historial: [PARTIDO(7, f, 1, 0, ["Ana", "Beto"], ["Caro", "Dani"], { mvp: "Ana" })] }));
  await t.ir("post");
  await t.tap("#historial .fecha");
  await t.hoja();
  await t.page.fill("#hGA", "2"); await t.page.fill("#hGB", "3");
  await t.page.selectOption("#hMvp", "Caro"); await t.page.selectOption("#hGol", "Dani");
  await t.tap("#hOk");
  const p = (await t.S()).historial[0];
  igual([p.golesA, p.golesB, p.mvp, p.goleador, p.fecha], [2, 3, "Caro", "Dani", f], "partido corregido");
  ok((await t.txt("#historial")).includes("2 – 3"), "se ve en el historial");
});

await prueba("F14: cuota redondeada y lo que sobra va a la 📦 caja; la caja paga parte de la cancha", async (abrir) => {
  const t = await abrir(base({ porLado: 7, inscritos: J(14), costoCancha: "50000" }));
  await t.ir("pagos");
  await t.page.selectOption("#redondeo", "500");
  ok((await t.txt("#porCancha")).startsWith("$4.000"), "50.000 / 14 = 3.572 → $4.000");
  await t.tap("[data-cerrar]");
  ok((await t.txt("#sheet")).includes("+$6.000 del redondeo"), "el cierre muestra lo que va a la caja");
  await t.tap("#cOk");
  let S = await t.S();
  igual([S.caja, S.deudas.J01[0].monto], [6000, 4000], "caja con $6.000 y cuotas de $4.000");
  // La semana siguiente: la caja paga $6.000 de la cancha
  await t.tap("#mismaLista");
  await t.ir("pagos");
  await t.tap("#cajaBtn"); await t.tap("#cjUsar");
  ok((await t.txt("#porCancha")).startsWith("$3.500"), "44.000 / 14 = 3.143 → $3.500");
  await t.tap("[data-cerrar]"); await t.tap("#cOk");
  S = await t.S();
  igual([S.caja, S.usaCaja], [5000, 0], "usó $6.000 y sobraron $5.000");
});

await prueba("F15: sugiere subir o bajar el nivel según los últimos 30 días", async (abrir) => {
  const d = (n) => { const x = new Date(Date.now() - n * 864e5); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
  const hist = [1, 2, 3].map((i) => PARTIDO(i, d(i * 3), 3, 0, ["Ana", "Beto"], ["Caro", "Dani"]));
  const t = await abrir(base({ inscritos: ["Ana", "Beto", "Caro", "Dani"], niveles: { Ana: 5 }, historial: hist }));
  await t.ir("equipos");
  const txt = await t.txt("#sugerencias");
  ok(txt.includes("Beto ganó 3 de 3") && txt.includes("Caro perdió 3 de 3") && !txt.includes("Ana"), "sugiere a Beto y Caro (Ana ya es 5): " + txt);
  await t.tap('[data-sug="Beto"]');
  await t.page.waitForTimeout(470);
  await t.tap('[data-nosug="Caro"]');
  const S = await t.S();
  igual([S.niveles.Beto, S.niveles.Caro || 3], [4, 3], "Beto sube, Caro queda igual");
  ok(await t.page.isHidden("#sugerencias") || !(await t.txt("#sugerencias")).includes("Beto"), "no lo vuelve a sugerir");
});

await prueba("Inicio: la animación sale al abrir, se salta con un toque y no se repite al volver", async (abrir) => {
  const t = await abrir();
  const { page } = t;
  // Las pruebas automáticas no la ven; aquí se hace pasar por un teléfono y se parte sin aperturas previas
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false });
    if (!sessionStorage.getItem("__intro")) { sessionStorage.setItem("__intro", "1"); localStorage.removeItem("pichanga-v1-intro"); }
  });
  const hay = () => page.evaluate(() => !!document.getElementById("intro") && document.documentElement.classList.contains("con-intro"));
  await page.goto(FILE);
  ok(await hay(), "sale al abrir la app");
  ok(await page.isVisible("#intro .marca"), "se ve el nombre");
  await page.locator("#intro").click();
  await page.waitForSelector("#intro", { state: "detached", timeout: 1500 });
  await t.ir("pagos");
  ok(await page.isVisible("#s-pagos"), "después del toque la app responde");
  await page.goto(FILE);
  ok(!(await hay()), "no se repite al volver al rato (p. ej. desde WhatsApp)");
  const hace20 = () => page.evaluate(() => localStorage.setItem("pichanga-v1-intro", Date.now() - 20 * 60e3));
  await hace20();
  await page.goto(FILE + "#pagos");
  ok(!(await hay()), "no sale al recargar una pestaña");
  await hace20();
  await page.goto(FILE);
  ok(await hay(), "vuelve a salir pasados 15 minutos");
  await page.waitForSelector("#intro", { state: "detached", timeout: 4000 });
  ok(await page.evaluate(() => fetch(document.querySelector('link[rel=icon][type="image/svg+xml"]').href).then((r) => r.ok)), "el ícono SVG existe");
});

await prueba("B12: el SW no guarda páginas de error y abre desde la caché con red lenta o caída", async () => {
  // Servidor local que imita GitHub Pages (/Mi_Pichanga/) con perillas para fallar
  const ctl = { caido: false, demora: 0, status500: false };
  const tipos = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".webmanifest": "application/manifest+json", ".png": "image/png", ".md": "text/markdown" };
  const server = http.createServer((req, res) => {
    if (ctl.caido) return req.socket.destroy();
    const u = new URL(req.url, "http://x");
    if (!u.pathname.startsWith("/Mi_Pichanga/")) { res.writeHead(404); return res.end("404"); }
    let rel = decodeURIComponent(u.pathname.slice("/Mi_Pichanga/".length)) || "index.html";
    const f = path.join(ROOT, rel);
    setTimeout(() => {
      if (ctl.status500 && rel === "index.html") { res.writeHead(500, { "content-type": "text/html" }); return res.end("<title>Error 500</title>caído"); }
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404, { "content-type": "text/html" }); return res.end("<title>404</title>File not found"); }
      res.writeHead(200, { "content-type": tipos[path.extname(f)] || "application/octet-stream", "cache-control": "no-store" });
      fs.createReadStream(f).pipe(res);
    }, rel === "index.html" ? ctl.demora : 0);
  });
  const port = 20000 + Math.floor(Math.random() * 20000);
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  const ctx = await browser.newContext();
  ctx.setDefaultTimeout(5000); ctx.setDefaultNavigationTimeout(15000);
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  try {
    const page = await ctx.newPage();
    const raiz = `http://127.0.0.1:${port}/Mi_Pichanga/`;
    await page.goto(raiz);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    ok(await page.evaluate(() => !!navigator.serviceWorker.controller), "SW controla la página");
    igual(await page.evaluate(() => caches.keys()), ["pichanga-v8"], "caché nueva (pichanga-v7)");
    const copia = () => page.evaluate(() => caches.match("./index.html").then((r) => r && r.text()));
    await page.goto(raiz + "jugadores");
    ok((await page.title()) === "404", "la página 404 se muestra tal cual");
    await page.goto(raiz + "README.md");
    ok((await copia()).includes("<title>Pichanga.app</title>"), "la copia offline sigue siendo la app");
    ctl.status500 = true;
    await page.goto(raiz);
    igual(await page.title(), "Pichanga.app", "con 500 abre la copia guardada");
    ctl.status500 = false;
    ok((await copia()).includes("<title>Pichanga.app</title>"), "el 500 no pisó la copia");
    ctl.caido = true;
    await page.goto(raiz);
    igual(await page.title(), "Pichanga.app", "sin conexión abre la app");
    ctl.caido = false; ctl.demora = 9000;
    const t0 = Date.now();
    await page.goto(raiz, { waitUntil: "domcontentloaded" });
    const ms = Date.now() - t0;
    igual(await page.title(), "Pichanga.app", "con red lenta abre la app");
    ok(ms < 5000, `con red lenta abre en ${ms} ms (< 5 s)`);
  } finally {
    await ctx.close();
    server.closeAllConnections?.();
    server.close();
  }
});

await correrTodas();
await browser.close();
servidor.closeAllConnections?.(); servidor.close();
console.log(`\n${pasan} pasan, ${fallan} fallan`);
process.exit(fallan ? 1 : 0);
