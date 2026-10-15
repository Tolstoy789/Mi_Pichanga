// Pruebas de regresión de Pichanga.app (Node + Playwright, sin dependencias nuevas).
// Uso: node tests/e2e.mjs   → imprime una línea por prueba y termina con código ≠ 0 si alguna falla.
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILE = "file://" + path.join(ROOT, "index.html");
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
async function prueba(nombre, fn) {
  if (SOLO && !SOLO.test(nombre)) return;
  const abiertas = [];
  try {
    let reloj;
    await Promise.race([
      fn((estado, opts) => abrir(estado, opts).then((t) => (abiertas.push(t), t))),
      new Promise((_, no) => { reloj = setTimeout(() => no(new Error(`la prueba superó ${LIMITE_PRUEBA / 1000} s`)), LIMITE_PRUEBA); }),
    ]).finally(() => clearTimeout(reloj));
    for (const t of abiertas) ok(!t.errores.length, "errores en la página: " + t.errores.join(" | "));
    pasan++; console.log(`✔ ${nombre}`);
  } catch (e) {
    fallan++; console.log(`✘ ${nombre}\n    ${String(e.message || e).split("\n").slice(0, process.env.DEBUG ? 25 : 1).join("\n    ")}`);
  } finally {
    for (const t of abiertas) await t.ctx.close().catch(() => {});
  }
}

// Abre la app con un estado guardado (o vacía). Devuelve helpers para manejarla.
async function abrir(estado, { width = 390, height = 844, url = FILE } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: true });
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
    if (s != null && !sessionStorage.getItem("__sembrado")) { sessionStorage.setItem("__sembrado", "1"); localStorage.setItem(k, typeof s === "string" ? s : JSON.stringify(s)); }
  }, [KEY, estado ?? null]);
  await page.goto(url);
  Object.assign(t, {
    S: () => page.evaluate((k) => JSON.parse(localStorage.getItem(k)), KEY),
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
const BAJA = 500; // pausa entre bajas (protección de doble toque)

/* ================= Migración ================= */
await prueba("Migración: datos con la forma antigua se convierten sin perder nada", async (abrir) => {
  const t = await abrir(VIEJO);
  const S = await t.S();
  igual(S.v, 3, "versión");
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
  const copia = await t.page.evaluate((k) => localStorage.getItem(k + "-antes-v3"), KEY);
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
  igual((await t.S()).v, 3, "estado nuevo");
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
  igual(S.v, 3, "versión");
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
  igual(S.post, { golesA: 0, golesB: 0, mvp: "", goleador: "", rustico: "", guardadoId: null }, "marcador y premios limpios");
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
  await t.tap("#toast .tbtn");
  await t.toast("no se puede deshacer");
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

await prueba("QA B7: el ↩️ de una baja respeta los equipos que se armaron a mano después", async (abrir) => {
  const t = await abrir(base({ porLado: 4, inscritos: J(9), equipos: { A: J(4), B: J(8).slice(4) } }));
  await t.tap('[data-del="J02"]');
  await t.toast("J02 se bajó");
  await t.ir("equipos");
  await t.page.evaluate(() => { swap("J01", "J05"); renderEquipos(); }); // arrastre a mano (sin aviso)
  const armados = (await t.S()).equipos;
  await t.tap("#toast .tbtn");
  await t.toast("J02 volvió");
  const S = await t.S();
  igual(S.inscritos, J(9), "J02 vuelve a su lugar");
  ok(S.equipos.A[0] === armados.A[0] && S.equipos.B[0] === armados.B[0] && armados.A[0] === "J05", "se mantienen los arcos elegidos a mano");
  ok(S.equipos.A.concat(S.equipos.B).includes("J02") && !S.equipos.A.concat(S.equipos.B).includes("J09"), "J02 en la cancha y J09 de nuevo a la banca");
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

await prueba("Migración v2 → v3: un estado v2 se conserva entero (con copia)", async (abrir) => {
  const v2 = Object.assign(base(), { v: 2, inscritos: ["Ana", "Beto"], pagos: { Ana: { monto: 5000, fecha: "2026-10-16", previo: 2000 }, Beto: { monto: null, fecha: "" } },
    deudas: { Caro: [{ fecha: "", concepto: "Deuda anterior", monto: null }], Dani: [{ fecha: "2026-10-03", concepto: "Cancha", monto: 7000 }] }, costoCancha: "10000" });
  const t = await abrir(v2);
  const S = await t.S();
  igual(S.v, 3, "versión");
  igual([S.pagos, S.deudas, S.inscritos], [v2.pagos, v2.deudas, v2.inscritos], "pagos, deudas e inscritos intactos");
  igual(JSON.parse(await t.page.evaluate((k) => localStorage.getItem(k + "-antes-v3"), KEY)), v2, "copia de los datos v2");
});

/* ================= Pantallas ================= */
await prueba("Pantallas: sin scroll horizontal, toques ≥ 44px e inputs ≥ 16px a 320 y 390", async (abrir) => {
  const estado = base({ porLado: 7, inscritos: [...J(14), "Supl"], caseros: [...J(14), "Pablo", "Supl"], costoCancha: "49000", costoTercer: "20000", tercer: { J01: true },
    pagos: { J02: { monto: 1000, fecha: "" } }, deudas: { Pablo: [{ fecha: "2026-10-10", concepto: "Cancha + 🍻", monto: 19000 }], J03: [{ fecha: "", concepto: "Deuda anterior (monto por confirmar)", monto: null }] },
    ultimaLista: ["Otro"], post: { golesA: 10, golesB: 12, mvp: "", goleador: "", rustico: "", guardadoId: null } });
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
      convocatoria: [".x", ".chip:not(.in)", "#mismaLista", "#menos", "#mas", "#agregar"],
      equipos: ["#azar", "#equilibrar", "#colorA", "#colorB", ".levels summary", ".levels .seg button"],
      pagos: [".beer", ".state", ".pname", "[data-saldar]", "#waCobrar", "[data-cerrar]", "#s-pagos summary", "#copiarBanco"],
      post: ["[data-gol]", "#guardarPartido", "[data-cerrar]", "#mesAnt", "#mesSig", "#aMvp", "#waStats"],
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

/* ================= B12: service worker ================= */
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
    igual(await page.evaluate(() => caches.keys()), ["pichanga-v4"], "caché nueva (pichanga-v4)");
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

await browser.close();
console.log(`\n${pasan} pasan, ${fallan} fallan`);
process.exit(fallan ? 1 : 0);
