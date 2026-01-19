import {
  obtenerObservacionActiva,
  finalizarObservacionAPI,
  obtenerUsuario,
  obtenerTelescopios,
  obtenerSesionActiva,
  marcarDisponibilidadSesion,
  crearObservacionEnCurso,
  obtenerConfigTelescopio,
  guardarCoordsObservacion,
  listarMisObservaciones,
} from "./api.js";
const TELESCOPIO_ID = 1;
let ESP32_CONTROLLER_BASE = null;
let ESP32_CAM_BASE = null;

let usuarioActual = null;
let sesionActiva = null;
let telescopioActual = null;
let observacionActual = null;
const estadoSpan      = document.getElementById("estadoSesion");
const telescopioSpan  = document.getElementById("nombreTelescopio");
const mensajeEstado   = document.getElementById("mensajeEstado");
const btnApuntar      = document.getElementById("btnApuntar");
const btnFinalizar    = document.getElementById("btnFinalizar");
const imgCam          = document.getElementById("camStream");
const objetoInput = document.getElementById("objetoInput");

// Botón de descarga 
const btnDescargarFoto = document.getElementById("btnDescargarFoto");

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

//  INIT

async function init() {
  const local = localStorage.getItem("papudomo_user");
  if (!local) {
    window.location.href = "registro.html";
    return;
  }
  const { email } = JSON.parse(local);

  const { data: user, error: uErr } = await obtenerUsuario();

  if (uErr || !user) {
    console.error(uErr);
    localStorage.removeItem("papudomo_user");
    window.location.href = "registro.html";
    return;
  }

  usuarioActual = user;
  document.getElementById("nombreUsuario").textContent =
    (user.nombre_usuario || email.split("@")[0]).toLowerCase();

  // Telescopios
  const { data: teles, error: tErr } = await obtenerTelescopios();
  if (tErr) {
    console.error(tErr);
    estadoSpan.textContent = "Error obteniendo telescopios.";
    return;
  }

  telescopioActual = teles.find(t => t.id_telescopio === TELESCOPIO_ID) || teles[0];

  if (!telescopioActual) {
    estadoSpan.textContent = "Sin telescopios registrados.";
    btnApuntar.disabled = true;
    btnFinalizar.disabled = true;
    return;
  }

  telescopioSpan.textContent = telescopioActual.nombre;

  // Sesión activa
  const { data: sesion, error: sErr } = await obtenerSesionActiva(telescopioActual.id_telescopio);
  if (sErr) console.error(sErr);
  sesionActiva = sesion || null;
  // ==========================
  // Cargar config de hardware (Opción D)
  // ==========================
  const { data: cfg, error: cfgErr } = await obtenerConfigTelescopio(telescopioActual.id_telescopio);
  if (cfgErr) console.error("obtenerConfigTelescopio:", cfgErr);

  // Esperamos al menos esp32_base y esp32_cam para operar
  const base = cfg?.esp32_base;
  const cam  = cfg?.esp32_cam;

  if (!base || !base.host) {
    estadoSpan.textContent = "Falta configurar ESP32 Base.";
    mensajeEstado.textContent = "Configura host/puerto del controlador en la sección Configuración.";
    btnApuntar.disabled = true;
    btnFinalizar.disabled = true;
    return;
  }

  // puerto default 80 si no viene
  ESP32_CONTROLLER_BASE = `http://${base.host}:${base.puerto ?? 80}`;

  if (cam && cam.host) {
    ESP32_CAM_BASE = `http://${cam.host}:${cam.puerto ?? 80}`;
  } else {
    // cámara opcional: no bloquea apuntar, solo bloquea foto/descarga
    ESP32_CAM_BASE = null;
    console.warn("ESP32-CAM no configurada. Se deshabilita foto.");
  }


  await evaluarDisponibilidad();
  setInterval(evaluarDisponibilidad, 5000);
}

//  ESTADO ESP32

async function obtenerEstadoHardware() {
  try {  if (!ESP32_CONTROLLER_BASE) {
    return { online: false, data: null };
  }

    const res = await fetch(`${ESP32_CONTROLLER_BASE}/status`, { method: "GET" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    return { online: true, data };
  } catch (e) {
    console.warn("ESP32 no responde:", e.message);
    return { online: false, data: null };
  }
}


//  EVALUAR DISPONIBILIDAD 

async function evaluarDisponibilidad() {
  if (!telescopioActual) {
    estadoSpan.textContent = "Sin telescopio configurado.";
    btnApuntar.disabled = true;
    btnFinalizar.disabled = true;
    return;
  }

  // Estado administrativo (tabla telescopio)
  if (telescopioActual.estado && telescopioActual.estado !== "disponible") {
    estadoSpan.textContent = `Telescopio en estado "${telescopioActual.estado}".`;
    mensajeEstado.textContent = "No disponible (mantenimiento / fuera de servicio).";
    btnApuntar.disabled = true;
    btnFinalizar.disabled = true;
    return;
  }

  // Estado físico hardware
  const hw = await obtenerEstadoHardware();
  if (!hw.online) {
    estadoSpan.textContent = "Telescopio apagado o sin conexión.";
    mensajeEstado.textContent = "Enciende el ESP32 controlador o revisa la red.";
    btnApuntar.disabled = true;
    btnFinalizar.disabled = true;
    return;
  }

  // 🔄 Refrescar sesión activa REAL desde backend (primero)
  const { data: sesionNueva, error: sErr } = await obtenerSesionActiva(telescopioActual.id_telescopio);
  if (sErr) console.error("obtenerSesionActiva:", sErr);
  sesionActiva = sesionNueva || null;

  // Estado sesión
  if (!sesionActiva) {
    estadoSpan.textContent = "No hay sesión activa sobre este telescopio.";
    mensajeEstado.textContent = "Obtén una sesión activa en el dashboard.";
    btnApuntar.disabled = true;
    btnFinalizar.disabled = true;
    observacionActual = null;
    return;
  }

  const soyDuenoSesion = sesionActiva.id_usuario === usuarioActual.id_usuario;
  const disponible = sesionActiva.disponible === true;

  if (!soyDuenoSesion) {
    estadoSpan.textContent = "Sesión activa de otro usuario.";
    mensajeEstado.textContent = "Espera tu turno en la cola FIFO.";
    btnApuntar.disabled = true;
    btnFinalizar.disabled = true;
    observacionActual = null;
    return;
  }

  // Si está en uso, intenta recuperar la observación activa (para poder finalizar bien)
  if (!disponible) {
    estadoSpan.textContent = "Sesión activa en uso (observación en curso).";
    mensajeEstado.textContent = "Finaliza la observación actual para iniciar otra.";
    btnApuntar.disabled = true;
    btnFinalizar.disabled = false;

    // ✅ Traer observación en curso desde BD (si existe)
    const { data: obsAct, error: obsErr } = await obtenerObservacionActiva(sesionActiva.id_sesion);
    if (obsErr) {
      console.error("obtenerObservacionActiva:", obsErr);
    }
    observacionActual = obsAct || null;

    return;
  }

  // Disponible
  estadoSpan.textContent = "Sesión activa disponible.";
  mensajeEstado.textContent = "Puedes apuntar el domo a un planeta.";
  btnApuntar.disabled = false;
  btnFinalizar.disabled = true;
  observacionActual = null;
}



//  TOMAR 1 FOTO + MOSTRAR + PREPARAR DESCARGA

async function tomarUnaFoto(planetaLabel) {
  try {
      if (!ESP32_CAM_BASE) {
    mensajeEstado.textContent = "ESP32-CAM no configurada. No se puede tomar foto.";
    return;
  }

    await fetch(`${ESP32_CAM_BASE}/disparar`);

    const ts = Date.now();
    const fotoURL = `${ESP32_CAM_BASE}/photo.jpg?ts=${ts}`;
    imgCam.src = fotoURL;

    if (btnDescargarFoto) {
  btnDescargarFoto.href = "#";
  btnDescargarFoto.style.pointerEvents = "none";
  btnDescargarFoto.style.opacity = "0.6";
}

  } catch (e) {
    console.error("Error tomando foto:", e);
    mensajeEstado.textContent = "Error al tomar la foto desde la cámara.";
  }
}


//  APUNTAR DOMO

btnApuntar.addEventListener("click", async () => {
  if (!sesionActiva || !usuarioActual) return;

const objetoRaw = (objetoInput?.value || "").trim();

if (!objetoRaw) {
  mensajeEstado.textContent = "Escribe un objeto antes de apuntar.";
  return;
}

// Normalización leve (quita espacios repetidos)
const objeto = objetoRaw.replace(/\s+/g, " ");
const objetoLabel = objeto;


  try {
    btnApuntar.disabled = true;
    btnFinalizar.disabled = true;

    if (btnDescargarFoto) {
      btnDescargarFoto.href = "#";
      btnDescargarFoto.download = "";
      btnDescargarFoto.style.pointerEvents = "none";
      btnDescargarFoto.style.opacity = "0.6";
    }

   mensajeEstado.textContent = `Apuntando domo a ${objetoLabel}...`;


    // 1) sesión no disponible
    await marcarDisponibilidadSesion(sesionActiva.id_sesion, false);
    sesionActiva.disponible = false;

    // 2) crear observación
    const { data: obs, error: oErr } = await crearObservacionEnCurso({
      id_sesion: sesionActiva.id_sesion,
      objeto_celeste: objetoLabel,


      fecha_inicio: new Date().toISOString(),
      estado: "en curso",
      usuario_control: usuarioActual.id_usuario,
    });

    if (oErr) {
      console.error(oErr);
      mensajeEstado.textContent = "Error creando observación en BD.";
      await marcarDisponibilidadSesion(sesionActiva.id_sesion, true);
      sesionActiva.disponible = true;
      btnApuntar.disabled = false;
      return;
    }

    observacionActual = Array.isArray(obs) ? obs[0] : obs;

observacionActual.id_observacion =
  observacionActual.id_observacion || observacionActual.id_obs || observacionActual.id;


    console.log("DEBUG observacionActual:", observacionActual);

    // 3) mandar orden al controlador
 try {
  const resp = await fetch(
    `${ESP32_CONTROLLER_BASE}/apuntar?objeto=${encodeURIComponent(objeto)}`
  );

  if (!resp.ok) {
    throw new Error("Respuesta HTTP no OK del controlador");
  }

  const dataCtrl = await resp.json();

  const az = dataCtrl.azimut;
  const alt = dataCtrl.altitud;

  // Guardar coordenadas en la observación
  if (observacionActual?.id_observacion && az != null && alt != null) {
  await guardarCoordsObservacion({
    id_observacion: observacionActual.id_observacion,
    coord_azimut: az,
    coord_altitud: alt,
  });
}
// --- Validacion de horizonte ---
if (alt == null || Number.isNaN(Number(alt))) {
  mensajeEstado.textContent = "Error: no se obtuvo la altitud del objeto.";
  btnApuntar.disabled = false;
  return;
}

if (Number(alt) < 0) {
  mensajeEstado.textContent =
    `⚠️ El objeto está debajo del horizonte (altitud ${Number(alt).toFixed(1)}°). Solicitud de foto denegada.`;

  mensajeEstado.classList.remove("success", "info");
  mensajeEstado.classList.add("warning");

  const azSpan = document.getElementById("coordAzimut");
  const altSpan = document.getElementById("coordAltitud");
  if (azSpan) azSpan.textContent = (az != null ? Number(az).toFixed(2) : "—");
  if (altSpan) altSpan.textContent = Number(alt).toFixed(2);

  btnApuntar.disabled = false;
  return;
}





  // Mensaje según visibilidad
  if (dataCtrl.mueve === false) {
    mensajeEstado.textContent =
      `⚠️ ${dataCtrl.razon} (Az: ${az.toFixed(2)}, Alt: ${alt.toFixed(2)})`;
  } else {
    mensajeEstado.textContent =
      `Domo moviéndose... (Az: ${az.toFixed(2)}, Alt: ${alt.toFixed(2)})`;
  }

} catch (e) {
  console.error("Error llamando al ESP32 controlador:", e);
  mensajeEstado.textContent = "Error: no se pudo contactar al ESP32 controlador.";
  await marcarDisponibilidadSesion(sesionActiva.id_sesion, true);
  btnApuntar.disabled = false;
  return;
}


    // 4) esperar 8 segundos
    mensajeEstado.textContent = `Domo moviéndose... estabilizando (8 segundos)`;
    await delay(8000);

    // 5) foto
    await tomarUnaFoto(objetoLabel);

estadoSpan.textContent = `Observando ${objetoLabel}`;
mensajeEstado.textContent = `Foto capturada apuntando a ${objetoLabel}.`;

    btnFinalizar.disabled = false;

  } catch (e) {
    console.error(e);
    mensajeEstado.textContent = "Error general al iniciar la observación.";
    btnApuntar.disabled = false;
    await marcarDisponibilidadSesion(sesionActiva.id_sesion, true);
  }
});

btnFinalizar.addEventListener("click", async () => {
  //debe existir sesión y usuario
  if (!sesionActiva || !usuarioActual) {
    console.warn("No hay sesionActiva o usuarioActual. Cancelando finalizar.");
    return;
  }

  //Refrescar sesion antes de finalizar
  const { data: sesionNueva, error: sErr } =
    await obtenerSesionActiva(telescopioActual.id_telescopio);

  if (sErr) console.error("obtenerSesionActiva:", sErr);

  sesionActiva = sesionNueva || null;

  if (!sesionActiva) {
    mensajeEstado.textContent = "No hay sesión activa. No se puede finalizar.";
    return;
  }

  if (sesionActiva.id_usuario !== usuarioActual.id_usuario) {
    mensajeEstado.textContent = "No eres el dueño de la sesión. No puedes finalizar.";
    return;
  }

  btnFinalizar.disabled = true;
  mensajeEstado.textContent = "Finalizando observación...";

  let id_obs = null;
  try {
    const { data: obsAct, error: obsErr } =
      await obtenerObservacionActiva(sesionActiva.id_sesion);
    if (obsErr) console.error("obtenerObservacionActiva:", obsErr);

    if (obsAct) observacionActual = obsAct;
  } catch (e) {
    console.warn("No se pudo consultar observación activa (best-effort):", e);
  }
  id_obs =
    observacionActual?.id_observacion ??
    observacionActual?.id ??
    observacionActual?.id_obs ??
    null;
  const payload = { id_sesion: sesionActiva.id_sesion };
  if (id_obs) payload.id_observacion = id_obs;

  console.log("DEBUG payload finalizar:", payload);

  const { data: finData, error: fErr } = await finalizarObservacionAPI(payload);

  if (fErr) {
    console.error("finalizarObservacionAPI:", fErr);

    const msg = fErr.message || "Error al finalizar.";
    mensajeEstado.textContent = `Error al finalizar: ${msg}`;

    // Si no había observación en curso, igual liberamos sesión y normalizamos UI
    const msgLow = msg.toLowerCase();
    if (msgLow.includes("no hay observación") || msgLow.includes("no hay observacion")) {
      await marcarDisponibilidadSesion(sesionActiva.id_sesion, true);
      sesionActiva.disponible = true;
      observacionActual = null;

      // descarga no aplica
      if (btnDescargarFoto) {
        btnDescargarFoto.href = "javascript:void(0)";
        btnDescargarFoto.style.pointerEvents = "none";
        btnDescargarFoto.style.opacity = "0.6";
      }

      await evaluarDisponibilidad();
      mensajeEstado.textContent = "No había observación en curso. Sesión liberada.";
      btnApuntar.disabled = false;
      return;
    }

    btnFinalizar.disabled = false;
    return;
  }

  // Validación extra: a veces llega respuesta rara (HTML 200, etc.) y finData viene vacío
  const idObsFinal = finData?.id_observacion || id_obs || null;
  if (!idObsFinal) {
    console.warn("Respuesta inválida al finalizar (sin id_observacion):", finData);
    mensajeEstado.textContent =
      "Finalización recibida, pero sin ID de observación. Revisa si estás logueado (401) o si hay 404 en consola.";

    // deja UI usable
    btnFinalizar.disabled = false;
    return;
  }

  // Si el backend manda warning (ej. no pudo subir foto), avisa y maneja descarga
  const warning = finData?.warning || null;
  if (warning) {
    console.warn("WARNING finalizar:", warning);
    mensajeEstado.textContent = `Observación finalizada, pero: ${warning}`;
  }

  // Habilitar / deshabilitar descarga según warning
  // Si hubo warning de foto, lo más probable es que /foto dé 404 "Sin foto asociada"
  const fotoDisponible = !warning; // simple: si quieres, aquí puedes afinar con includes("subir foto")
  if (btnDescargarFoto && fotoDisponible) {
    btnDescargarFoto.href = `/api/observacion/${encodeURIComponent(idObsFinal)}/foto`;
    btnDescargarFoto.removeAttribute("download");
    btnDescargarFoto.style.pointerEvents = "auto";
    btnDescargarFoto.style.opacity = "1";
  } else if (btnDescargarFoto) {
    btnDescargarFoto.href = "javascript:void(0)";
    btnDescargarFoto.style.pointerEvents = "none";
    btnDescargarFoto.style.opacity = "0.6";
  }

  //liberar sesión SIEMPRE 
  const { error: dErr } =
    await marcarDisponibilidadSesion(sesionActiva.id_sesion, true);

  if (dErr) {
    console.error("marcarDisponibilidadSesion:", dErr);
    mensajeEstado.textContent =
      `Finalizó observación, pero no liberó sesión: ${dErr.message}`;
    btnFinalizar.disabled = false;
    return;
  }

  estadoSpan.textContent = "Sesión activa disponible.";
  if (!warning) {
    mensajeEstado.textContent = "Observación finalizada. Puedes iniciar otra.";
  }
  btnApuntar.disabled = false;
  observacionActual = null;

  await evaluarDisponibilidad();
});




const histBuscar = document.getElementById("histBuscar");
const histEstado = document.getElementById("histEstado");
const histDesde = document.getElementById("histDesde");
const histHasta = document.getElementById("histHasta");
const btnHistActualizar = document.getElementById("btnHistActualizar");
const tablaHistorial = document.getElementById("tablaHistorial")?.querySelector("tbody");

function fmtFecha(iso) {
  if (!iso) return "-";
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

function fmtNum(n) {
  if (n === null || n === undefined) return "-";
  return Number(n).toFixed(2);
}

async function cargarHistorial() {
  if (!tablaHistorial) return;

  const params = {};
  const q = histBuscar?.value?.trim();
  const estado = histEstado?.value;
  const desde = histDesde?.value;
  const hasta = histHasta?.value;

  if (q) params.q = q;
  if (estado) params.estado = estado;
  if (desde) params.desde = desde;
  if (hasta) params.hasta = hasta;

  const { data, error } = await listarMisObservaciones(params);
  if (error) {
    console.error("listarObservaciones:", error);
    return;
  }

  const items = data?.items || [];
  tablaHistorial.innerHTML = "";

  for (const o of items) {
    const tr = document.createElement("tr");

    const tdFecha = document.createElement("td");
    tdFecha.textContent = fmtFecha(o.fecha_inicio);
    tr.appendChild(tdFecha);

    const tdAstro = document.createElement("td");
    tdAstro.textContent = o.objeto_celeste || "-";
    tr.appendChild(tdAstro);

    const tdAz = document.createElement("td");
    tdAz.textContent = fmtNum(o.coord_azimut);
    tr.appendChild(tdAz);

    const tdAlt = document.createElement("td");
    tdAlt.textContent = fmtNum(o.coord_altitud);
    tr.appendChild(tdAlt);

    const tdEstado = document.createElement("td");
    tdEstado.textContent = o.estado || "-";
    tr.appendChild(tdEstado);

    // ERROR HORIZONTE
    const tdFoto = document.createElement("td");

    const altNum =
      o.coord_altitud !== null && o.coord_altitud !== undefined
        ? Number(o.coord_altitud)
        : null;

    const fueraHorizonte =
      altNum !== null && !Number.isNaN(altNum) && altNum < 0;

    if (fueraHorizonte) {
      tdFoto.textContent = "Fuera del horizonte";
      // opcional: si quieres estilo visual rapido
      tdFoto.style.fontWeight = "600";
      tdFoto.style.color = "#b00020";
    } else if (o.foto_path) {
      const a = document.createElement("a");
      a.href = `/api/observacion/${o.id_observacion}/foto`;
      a.target = "_blank";
      a.textContent = "Descargar";
      tdFoto.appendChild(a);
    } else {
      tdFoto.textContent = "—";
    }

    tr.appendChild(tdFoto);
    tablaHistorial.appendChild(tr);
  }
}

btnHistActualizar?.addEventListener("click", cargarHistorial);

// opcional: cargar al iniciar
cargarHistorial();

//  ARRANQUE

init();
