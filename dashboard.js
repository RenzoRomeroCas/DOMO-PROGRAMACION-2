import {
  obtenerUsuario,
  obtenerTelescopios,
  obtenerSesionesUsuario,
  obtenerColaFIFO,
  obtenerSesionActiva,
  crearSesionIlimitada,
  entrarCola,
  finalizarSesion,
  asignarSiguienteDeCola,
  solicitarAccesoAPI // ✅ agregar
} from "./api.js";


async function iniciarDashboard() {
  const local = localStorage.getItem("papudomo_user");
  if (!local) {
    window.location.href = "registro.html";
    return;
  }

  // Usuario (desde sesión Flask)
  const { data: user, error: uErr } = await obtenerUsuario();
  if (uErr || !user) {
    console.error(uErr);
    alert("Error obteniendo usuario. Inicia sesión de nuevo.");
    localStorage.removeItem("papudomo_user");
    window.location.href = "registro.html";
    return;
  }

  const email = user.email || JSON.parse(local).email;

  document.getElementById("nombreUsuario").textContent =
    (user.nombre_usuario || email.split("@")[0]).toLowerCase();

  // Telescopios y cola
  const { data: teles, error: tErr } = await obtenerTelescopios();
  if (tErr) {
    console.error(tErr);
    alert("Error cargando telescopios: " + tErr.message);
    return;
  }

  const contT = document.getElementById("listaTelescopios");
  contT.innerHTML = "";

  for (const t of (teles || [])) {
    const { data: cola } = await obtenerColaFIFO(t.id_telescopio);
    const { data: sesionActiva } = await obtenerSesionActiva(t.id_telescopio);

    contT.innerHTML += `
      <div class="card glass" style="margin-top:12px;">
        <h3 style="margin-bottom:6px;">${t.nombre}</h3>
        <p>Estado: <b>${t.estado}</b></p>
        <p>Cola FIFO: <b>${(cola || []).length}</b> esperando</p>
        <p>Sesión activa: <b>${sesionActiva ? "SÍ" : "NO"}</b></p>

        <button onclick="solicitarAcceso(${t.id_telescopio})"
                style="margin-top:8px; padding:10px 16px; border-radius:10px; border:none; cursor:pointer; font-weight:bold;">
          Solicitar acceso
        </button>
      </div>
    `;
  }

  // Mis sesiones
  const { data: sesiones, error: sErr } = await obtenerSesionesUsuario(user.id_usuario);
  if (sErr) {
    console.error(sErr);
    alert("Error cargando sesiones: " + sErr.message);
    return;
  }

  const contS = document.getElementById("misSesiones");
  contS.innerHTML = "";

  (sesiones || []).forEach(s => {
    contS.innerHTML += `
      <div class="card glass" style="margin-top:12px;">
        <p><strong>Sesión:</strong> ${s.id_sesion}</p>
        <p><strong>Inicio:</strong> ${s.inicio_sesion ? new Date(s.inicio_sesion).toLocaleString() : "-"}</p>
        <p><strong>Fin:</strong> ${s.fin_sesion ? new Date(s.fin_sesion).toLocaleString() : "ILIMITADO"}</p>
        <p><strong>Estado:</strong> ${s.estado}</p>
        <p id="timer-${s.id_sesion}" style="margin-top:6px;font-weight:700;"></p>

        ${s.estado === "activa" ? `
          <button onclick="cerrarSesion('${s.id_sesion}', ${s.id_telescopio})"
                  style="margin-top:8px; padding:8px 14px; border-radius:8px; border:none; cursor:pointer;">
            Finalizar sesión
          </button>` : ""}
      </div>
    `;

    if (s.fin_sesion && s.estado === "activa") {
      iniciarTimer(s.id_sesion, s.fin_sesion, s.id_telescopio);
    }
  });
}

// Regla de acceso
window.solicitarAcceso = async function (id_telescopio) {
  const { data: user, error: uErr } = await obtenerUsuario();
  if (uErr || !user) {
    alert("No autenticado. Inicia sesión.");
    window.location.href = "registro.html";
    return;
  }

  const { data: resp, error } = await solicitarAccesoAPI(id_telescopio);
  if (error) {
    alert("No se pudo solicitar acceso: " + error.message);
    return;
  }

  // El endpoint responde con { ok:true, modo:"ACCESO_DIRECTO"|"EN_COLA", ... }
  if (resp.modo === "ACCESO_DIRECTO") {
    alert("✅ Telescopio libre. Acceso otorgado.");
    location.reload();
    return;
  }

  if (resp.modo === "EN_COLA") {
    alert("⏳ Ingresaste a la cola FIFO. Cuando te toque tendrás 10 minutos.");
    location.reload();
    return;
  }

  alert(resp.msg || "Solicitud procesada");
  location.reload();
};

// Cronómetro
function iniciarTimer(idSesion, finSesion, idTelescopio){
  const el = document.getElementById(`timer-${idSesion}`);
  const fin = new Date(finSesion).getTime();

  const interval = setInterval(async ()=>{
    const now = Date.now();
    const diff = fin - now;

    if(diff <= 0){
      el.textContent = "Tiempo terminado";
      clearInterval(interval);

      await finalizarSesion(idSesion);
      await asignarSiguienteDeCola(idTelescopio);

      location.reload();
      return;
    }

    const min = Math.floor(diff/60000);
    const sec = Math.floor((diff%60000)/1000);
    el.textContent = `Tiempo restante: ${min}m ${sec}s`;
  },1000);
}

// Fin manual
window.cerrarSesion = async function(idSesion, idTelescopio){
  await finalizarSesion(idSesion);
  await asignarSiguienteDeCola(idTelescopio);
  alert("Sesión finalizada. Se asignó el siguiente turno.");
  location.reload();
};


// Antes usabas supabase.channel(...). Ahora hacemos polling cada 5s:
// Si se crea una sesión activa para este usuario, mostramos el modal.
async function activarPollingTurno() {
  const local = localStorage.getItem("papudomo_user");
  if (!local) return;

  const { data: perfil } = await obtenerUsuario();
  if (!perfil) return;

  const idUsuario = perfil.id_usuario;

  // Guarda el último fin_sesion visto por id_sesion
  // key: id_sesion, value: (string fecha ISO) o null
  const lastFinBySesion = new Map();

  setInterval(async () => {
    const { data: sesiones } = await obtenerSesionesUsuario(idUsuario);
    if (!sesiones || !Array.isArray(sesiones)) return;

    // Tomamos la sesión activa más reciente (por si viene más de una por error)
    const activas = sesiones.filter(s => s.estado === "activa");
    if (activas.length === 0) return;

    activas.sort((a, b) => new Date(b.inicio_sesion) - new Date(a.inicio_sesion));
    const activa = activas[0];

    const idSesion = activa.id_sesion;
    const finActual = activa.fin_sesion ?? null;
    const finPrevio = lastFinBySesion.has(idSesion) ? lastFinBySesion.get(idSesion) : undefined;

    // 1) Primera vez que veo esta sesión -> muestro modal
    if (finPrevio === undefined) {
      lastFinBySesion.set(idSesion, finActual);
      mostrarModalTurno(finActual);
      return;
    }

    // 2) Si cambió fin_sesion (por ejemplo de null -> fecha) -> muestro modal otra vez
    if (finPrevio !== finActual) {
      lastFinBySesion.set(idSesion, finActual);
      mostrarModalTurno(finActual);
      return;
    }

    // 3) Si no cambió, no hago nada
  }, 15000);
}

function mostrarModalTurno(finSesion) {
  const modal = document.getElementById("turnoModal");
  const tiempo = document.getElementById("turnoTiempo");
  const btn = document.getElementById("btnTurnoOk");

  if (!modal) return;

  // Si viene finSesion con fecha, significa "limitado"
  tiempo.textContent = finSesion ? "10 minutos" : "tiempo ilimitado";
  modal.classList.remove("hidden");

  btn.onclick = () => {
    modal.classList.add("hidden");
    iniciarDashboard();
  };
}


iniciarDashboard();
activarPollingTurno();
