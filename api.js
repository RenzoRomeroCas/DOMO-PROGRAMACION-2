
async function apiRequest(path, { method = "GET", body = null } = {}) {
  try {
    const res = await fetch(path, {
      method,
      credentials: "include", 
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });

    const out = await res.json().catch(() => ({}));

    if (!res.ok || out.ok === false) {
      return {
        data: null,
        error: { message: out.error || out.message || `HTTP ${res.status}` },
      };
    }
    const data = out.data ?? out.user ?? out;
    return { data, error: null };
  } catch (e) {
    return { data: null, error: { message: e?.message || "Network error" } };
  }
}
// USUARIO
export async function obtenerUsuario() {
  // GET /api/me -> { ok:true, user:{...} }
  return await apiRequest("/api/me");
}
// TELESCOPIO
export async function obtenerTelescopios() {
  // GET /api/telescopios -> { ok:true, data:[...] }
  return await apiRequest("/api/telescopios");
}
// SESIONES

// crear sesión ILIMITADA 
export async function crearSesionIlimitada(id_telescopio) {
  // POST /api/sesion/crear {id_telescopio} -> { ok:true } o { ok:true, data:{...} }
  return await apiRequest("/api/sesion/crear", {
    method: "POST",
    body: { id_telescopio },
  });
}

// obtener sesión activa por telescopio (cualquier usuario)
export async function obtenerSesionActiva(id_telescopio) {
  // GET /api/sesion/activa/<id_telescopio> -> { ok:true, data: {...} } o data:null
  return await apiRequest(`/api/sesion/activa/${encodeURIComponent(id_telescopio)}`);
}

// sesiones del usuario
export async function obtenerSesionesUsuario(id_usuario) {
  // GET /api/sesiones/usuario/<id_usuario> -> { ok:true, data:[...] }
  return await apiRequest(`/api/sesiones/usuario/${encodeURIComponent(id_usuario)}`);
}

// finalizar sesión manual
export async function finalizarSesion(id_sesion) {
  // POST /api/sesion/finalizar {id_sesion} -> { ok:true }
  return await apiRequest("/api/sesion/finalizar", {
    method: "POST",
    body: { id_sesion },
  });
}

// =======================
// COLA FIFO
// =======================

export async function entrarCola(id_telescopio, id_usuario) {
  // POST /api/cola/entrar {id_telescopio, id_usuario} -> { ok:true, data:{...} }
  return await apiRequest("/api/cola/entrar", {
    method: "POST",
    body: { id_telescopio, id_usuario },
  });
}

export async function obtenerColaFIFO(id_telescopio) {
  // GET /api/cola/<id_telescopio> -> { ok:true, data:[...] }
  return await apiRequest(`/api/cola/${encodeURIComponent(id_telescopio)}`);
}

// RPC para asignar siguiente (backend hace la lógica)
export async function asignarSiguienteDeCola(id_telescopio) {
  // POST /api/cola/asignar {id_telescopio} -> { ok:true, data:{...} }
  return await apiRequest("/api/cola/asignar", {
    method: "POST",
    body: { id_telescopio },
  });
}

// borrar usuario de queue
export async function borrarDeColaUsuario(id_usuario) {
  // POST /api/cola/borrar-usuario {id_usuario} -> { ok:true }
  return await apiRequest("/api/cola/borrar-usuario", {
    method: "POST",
    body: { id_usuario },
  });
}

// finalizar sesiones activas del usuario
export async function finalizarSesionUsuario(id_usuario) {
  // POST /api/sesion/finalizar-usuario {id_usuario} -> { ok:true }
  return await apiRequest("/api/sesion/finalizar-usuario", {
    method: "POST",
    body: { id_usuario },
  });
}

// =======================
// OBSERVACIONES
// =======================

export async function registrarObservacion(dataObs) {
  // POST /api/observacion/registrar  body:dataObs -> { ok:true, data:{...} }
  return await apiRequest("/api/observacion/registrar", {
    method: "POST",
    body: dataObs,
  });
}

export async function obtenerObservaciones(id_sesion) {
  // GET /api/observacion/<id_sesion> -> { ok:true, data:[...] }
  return await apiRequest(`/api/observacion/${encodeURIComponent(id_sesion)}`);
}

// Marcar disponibilidad de una sesión
export async function marcarDisponibilidadSesion(id_sesion, disponible) {
  // POST /api/sesion/disponible {id_sesion, disponible} -> { ok:true }
  return await apiRequest("/api/sesion/disponible", {
    method: "POST",
    body: { id_sesion, disponible },
  });
}

// Crear observación "en curso"
export async function crearObservacionEnCurso(data) {
  // POST /api/observacion/en-curso body:data -> { ok:true, data:{...} }
  return await apiRequest("/api/observacion/en-curso", {
    method: "POST",
    body: data,
    
  });
}

export async function solicitarAccesoAPI(id_telescopio) {
  // POST /api/acceso/solicitar {id_telescopio}
  return await apiRequest("/api/acceso/solicitar", {
    method: "POST",
    body: { id_telescopio },
  });
}

export async function obtenerObservacionActiva(id_sesion) {
  return await apiRequest(`/api/observacion/activa/${encodeURIComponent(id_sesion)}`);
}

// Finalizar observación
export async function finalizarObservacionAPI({ id_observacion = null, id_sesion = null } = {}) {
  return await apiRequest("/api/observacion/finalizar", {
    method: "POST",
    body: { id_observacion, id_sesion },
  });
}

// CONFIG TELESCOPIO 

export async function obtenerConfigTelescopio(id_telescopio) {
  // GET /api/telescopio/config/<id_telescopio> -> { ok:true, data:{...} }
  return await apiRequest(`/api/telescopio/config/${encodeURIComponent(id_telescopio)}`);
}

export async function guardarConfigTelescopio({ id_telescopio, tipo, host, puerto }) {
  // POST /api/telescopio/config
  return await apiRequest("/api/telescopio/config", {
    method: "POST",
    body: { id_telescopio, tipo, host, puerto },
  });
}
export async function listarObservaciones(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return apiRequest(`/api/observaciones${qs ? `?${qs}` : ""}`, { method: "GET" });
}
export async function guardarCoordsObservacion(payload) {
  return apiRequest("/api/observacion/coords", {
    method: "POST",
    body: payload, // ✅ sin stringify
  });
}
// Historial personal (mis observaciones)
export async function listarMisObservaciones(params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = qs ? `/api/observaciones/mias?${qs}` : `/api/observaciones/mias`;
  return await apiRequest(url);
}


