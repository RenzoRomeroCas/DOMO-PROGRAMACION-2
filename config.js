// config.js
import {
  obtenerUsuario,
  obtenerConfigTelescopio,
  guardarConfigTelescopio
} from "./api.js";

const TELESCOPIO_ID = 1;

// DOM
const msg = document.getElementById("msg");
const baseHost = document.getElementById("baseHost");
const basePort = document.getElementById("basePort");
const camHost  = document.getElementById("camHost");
const camPort  = document.getElementById("camPort");

// =========================
// Helpers
// =========================
function setMsg(text) {
  if (msg) msg.textContent = text || "";
}

function toPort(v, fallback = 80) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return fallback;
  return Math.trunc(n);
}

function normHost(v) {
  return (v || "").trim();
}

// =========================
// Auth guard
// =========================
async function asegurarSesion() {
  const { data: user, error } = await obtenerUsuario();
  if (error || !user) {
    // No hay cookie de sesión válida
    window.location.href = "registro.html";
    throw new Error("No auth");
  }
  return user;
}

// =========================
// Cargar config
// =========================
async function cargar() {
  try {
    await asegurarSesion();

    setMsg("Cargando configuración...");

    const { data, error } = await obtenerConfigTelescopio(TELESCOPIO_ID);
    if (error) {
      setMsg("Error cargando configuración: " + error.message);
      return;
    }

    // Rellenar inputs si hay data
    if (data?.esp32_base) {
      baseHost.value = data.esp32_base.host ?? "";
      basePort.value = data.esp32_base.puerto ?? 80;
    }

    if (data?.esp32_cam) {
      camHost.value = data.esp32_cam.host ?? "";
      camPort.value = data.esp32_cam.puerto ?? 80;
    }

    setMsg("");
  } catch (e) {
    // asegurarSesion ya redirige si no auth
    console.error(e);
  }
}

// =========================
// Guardar Base
// =========================
window.guardarBase = async () => {
  try {
    await asegurarSesion();

    const host = normHost(baseHost.value);
    const puerto = toPort(basePort.value, 80);

    if (!host) {
      setMsg("⚠️ Host/IP del ESP32 Base es requerido.");
      return;
    }

    setMsg("Guardando ESP32 Base...");

    const { error } = await guardarConfigTelescopio({
      id_telescopio: TELESCOPIO_ID,
      tipo: "esp32_base",
      host,
      puerto
    });

    setMsg(error ? ("Error: " + error.message) : "✅ ESP32 Base guardado.");
  } catch (e) {
    console.error(e);
    setMsg("Error inesperado guardando ESP32 Base.");
  }
};

// =========================
// Guardar Cam
// =========================
window.guardarCam = async () => {
  try {
    await asegurarSesion();

    const host = normHost(camHost.value);
    const puerto = toPort(camPort.value, 80);

    if (!host) {
      setMsg("⚠️ Host/IP del ESP32 Cámara es requerido.");
      return;
    }

    setMsg("Guardando ESP32 Cámara...");

    const { error } = await guardarConfigTelescopio({
      id_telescopio: TELESCOPIO_ID,
      tipo: "esp32_cam",
      host,
      puerto
    });

    setMsg(error ? ("Error: " + error.message) : "✅ ESP32 Cámara guardada.");
  } catch (e) {
    console.error(e);
    setMsg("Error inesperado guardando ESP32 Cámara.");
  }
};

// Init
cargar();
