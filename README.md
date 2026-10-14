# ⚽ Pichanga.app

Organizador de pichangas para el celular: convocatoria, armado de equipos y cobros, todo listo para compartir por WhatsApp.

## Pantallas

- **📅 Convocatoria:** fecha, hora y lugar (con enlace a Google Maps), selector de jugadores por lado, botones de "caseros" para sumar a los de siempre con un toque, suplentes automáticos cuando se llena el cupo y mensaje formateado para WhatsApp.
- **👕 Equipos:** cancha táctica con formación según la cantidad de jugadores, color de petos por equipo, mezcla al azar, armado equilibrado según niveles ocultos (1 a 5), arrastrar para intercambiar jugadores e imagen del planteamiento para compartir.
- **💰 Pagos:** datos bancarios con QR o link de cobro, cuota de cancha por persona (acepta montos como "49.000"), división del tercer tiempo 🍻 solo entre los que se quedan, registro de cuánto pagó cada uno ("pagó $X · falta $Y", recaudado del día) y cobranza por WhatsApp con el detalle de cada deuda.
- **⚠️ Libreta de deudas:** lo que cada jugador quedó debiendo, con monto y fecha, juegue o no esa semana. Se puede saldar completo, abonar una parte, ponerle monto a una deuda antigua que no lo tenía o mandarle un recordatorio por WhatsApp, y el monto aparece junto a su nombre en Convocatoria. Si alguien pagó y no jugó (o pagó de más), queda con saldo a favor 💚, que se descuenta solo de su próxima cuota.
- **🏁 Cerrar pichanga:** en un solo paso guarda el resultado (una vez por fecha), anota en la libreta a quienes no pagaron y deja lista la próxima fecha (+7 días, misma hora, lugar y costo). En Convocatoria, "🔁 Misma lista que la semana pasada" inscribe a todos de un toque.
- **🏆 Post-Partido:** marcador del partido, votación por WhatsApp para elegir ⭐ MVP, 👟 Goleador y 🪓 El Rústico, historial de partidos y tabla del mes (victorias del Equipo A vs Equipo B y ranking de premios) para compartir al grupo.

## Cómo usarla

Ábrela en https://tolstoy789.github.io/Mi_Pichanga/ desde el celular y usa **"Agregar a pantalla de inicio"** para instalarla como app. Funciona sin conexión.

Los datos se guardan en el mismo teléfono. En la pestaña 🏆 Post-Partido puedes guardar un respaldo (archivo `.json`) y restaurarlo en otro celular.

Es una sola página (`index.html`) sin dependencias ni paso de compilación; `sw.js` y `manifest.webmanifest` la hacen instalable y usable sin internet.

Pruebas automáticas (Node + Playwright): `node tests/e2e.mjs`.

![Pantalla de equipos](docs/capturas/equipos-pantalla.png)
