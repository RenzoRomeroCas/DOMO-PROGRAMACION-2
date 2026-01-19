import os
from datetime import datetime, timezone, timedelta
import requests
from flask import Flask, request, jsonify, session, send_from_directory,redirect
from dotenv import load_dotenv
from supabase import create_client 

# cargar env
load_dotenv()
SUPABASE_URL = os.getenv("SUPABASE_URL")
ANON_KEY = os.getenv("SUPABASE_ANON_KEY")
SERVICE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
if not SUPABASE_URL or not ANON_KEY or not SERVICE_KEY:
    raise RuntimeError(
        "Faltan variables de entorno SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY"
    )
# Cliente admin para backend
supabase = create_client(SUPABASE_URL, SERVICE_KEY)
# Bucket de fotos 
BUCKET_FOTOS = os.getenv("SUPABASE_BUCKET_FOTOS", "observaciones")
# APP
app = Flask(__name__, static_folder="static", static_url_path="")
app.secret_key = os.getenv("SECRET_KEY", "dev-secret")
# Cookies de sesión 
app.config.update(
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=False,
)
# Clientes Supabase
sb_auth = create_client(SUPABASE_URL, ANON_KEY)       
sb_admin = create_client(SUPABASE_URL, SERVICE_KEY)   
def _now_utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

def _require_login():
    if "email" not in session or "user_id" not in session:
        return jsonify({"ok": False, "error": "No auth"}), 401
    return None

def _get_or_create_profile(email: str):
    perfil = sb_admin.table("usuario").select("*").eq("email", email).limit(1).execute()
    if perfil.data:
        return perfil.data[0]

    created = sb_admin.table("usuario").insert({
        "email": email,
        "nombre_usuario": email.split("@")[0]
    }).execute()

    return created.data[0] if created.data else {"email": email, "nombre_usuario": email.split("@")[0]}
def obtener_url_controlador(tipo: str) -> str:
    res = sb_admin.table("telescopio_config") \
        .select("host, puerto") \
        .eq("tipo", tipo) \
        .limit(1) \
        .execute()

    if not res.data:
        raise RuntimeError(f"No existe configuración para tipo='{tipo}' en telescopio_config")

    host = res.data[0].get("host")
    puerto = res.data[0].get("puerto")
    if not host:
        raise RuntimeError(f"Configuración incompleta para tipo='{tipo}' (host)")

    if not puerto:
        puerto = 80

    return f"http://{host}:{puerto}"

def subir_foto_y_guardar_path(id_observacion: str) -> str:
    # 1) URL dinámica desde BD 
    cam_url = obtener_url_controlador("esp32_cam")

    # 2) Descargar la foto actual de la cam
    r = requests.get(f"{cam_url}/photo.jpg", timeout=20)
    if r.status_code != 200:
        raise RuntimeError(f"No se pudo obtener photo.jpg de la cam (HTTP {r.status_code})")

    jpg_bytes = r.content
    if not jpg_bytes or len(jpg_bytes) < 5000:
        raise RuntimeError("La cam devolvió un archivo vacío o muy pequeño (posible error)")

    # 3) Obtener datos de la observación para nombre amigable
    
    obs = sb_admin.table("observacion") \
        .select("objeto_celeste") \
        .eq("id_observacion", id_observacion) \
        .single() \
        .execute()

    objeto = (obs.data.get("objeto_celeste") or "astro") \
        .lower() \
        .replace(" ", "_")


    fecha = datetime.now().strftime("%Y-%m-%d")  # ✅ hora local

    short_id = id_observacion.split("-")[0]

    # 4) Path en Storage con nombre amigable
    foto_path = f"observaciones/{fecha}/{objeto}_{fecha}_obs_{short_id}.jpg"

    # 5) Subir a Supabase Storage (upsert)
    sb_admin.storage.from_(BUCKET_FOTOS).upload(
        path=foto_path,
        file=jpg_bytes,
        file_options={"content-type": "image/jpeg", "upsert": "true"}
    )

    # 6) Guardar ruta en la tabla observacion
    sb_admin.table("observacion") \
        .update({"foto_path": foto_path}) \
        .eq("id_observacion", str(id_observacion)) \
        .execute()

    return foto_path
# STATIC 
@app.get("/")
def root():
    filename = "index.html" if os.path.exists(os.path.join(app.static_folder, "index.html")) else "registro.html"
    return send_from_directory(app.static_folder, filename)

@app.get("/<path:path>")
def static_files(path):
    if path.startswith("api/"):
        return jsonify({"ok": False, "error": "Ruta API inválida"}), 404
    return send_from_directory(app.static_folder, path)
# Inicio de sesión
@app.post("/api/register")
def api_register():
    data = request.get_json(force=True) or {}
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    nombre = (data.get("nombre_usuario") or "").strip()

    if not email or not password:
        return jsonify({"ok": False, "error": "Completa correo y contraseña"}), 400

    # 1) Registrar en Supabase Auth
    try:
        sb_auth.auth.sign_up({"email": email, "password": password})
    except Exception as e:
        return jsonify({"ok": False, "error": f"Error Auth: {str(e)}"}), 400

    # 2) Crear/asegurar perfil en tabla usuario 
    try:
        exist = sb_admin.table("usuario").select("id_usuario").eq("email", email).limit(1).execute()
        if not exist.data:
            sb_admin.table("usuario").insert({
                "email": email,
                "nombre_usuario": nombre or email.split("@")[0]
            }).execute()
    except Exception as e:
        # Auth pudo crear el usuario; el perfil es secundario, pero avisamos
        return jsonify({"ok": False, "error": f"Auth OK pero perfil falló: {str(e)}"}), 400
    return jsonify({"ok": True, "msg": "Cuenta creada. Ahora inicia sesión."})

@app.post("/api/login")
def api_login():
    data = request.get_json(force=True) or {}
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""

    if not email or not password:
        return jsonify({"ok": False, "error": "Completa correo y contraseña"}), 400

    try:
        sb_auth.auth.sign_in_with_password({"email": email, "password": password})
    except Exception:
        return jsonify({"ok": False, "error": "Correo o contraseña incorrectos"}), 401

    #Obtener user_id
    try:
        user = _get_or_create_profile(email)
    except Exception as e:
        return jsonify({"ok": False, "error": f"Login OK pero perfil falló: {str(e)}"}), 500

    session["email"] = email
    session["user_id"] = user.get("id_usuario")

    return jsonify({"ok": True, "user": user})

@app.post("/api/logout")
def api_logout():
    session.clear()
    return jsonify({"ok": True})

@app.get("/api/me")
def api_me():
    if "email" not in session:
        return jsonify({"ok": False}), 401

    email = session["email"]

    perfil = sb_admin.table("usuario").select("*").eq("email", email).limit(1).execute()
    if not perfil.data:
        return jsonify({"ok": False}), 404

    user = perfil.data[0]
    return jsonify({
        "ok": True,
        "user": {
            "id_usuario": user.get("id_usuario"),
            "email": user.get("email"),
            "nombre_usuario": user.get("nombre_usuario")
        }
    })
# TELESCOPIOS
@app.get("/api/telescopios")
def api_telescopios():
    err = _require_login()
    if err:
        return err

    r = sb_admin.table("telescopio").select("*").execute()
    return jsonify({"ok": True, "data": r.data})
# SESIONES

@app.post("/api/sesion/crear")
def api_crear_sesion():
    err = _require_login()
    if err:
        return err

    data = request.get_json(force=True) or {}
    try:
        id_telescopio = int(data.get("id_telescopio"))
    except Exception:
        return jsonify({"ok": False, "error": "id_telescopio inválido"}), 400

    ahora = _now_utc_iso()

    try:
        # Finaliza sesión activa previa del usuario 
        sb_admin.table("telescopio_sesion") \
            .update({"estado": "finalizada", "fin_sesion": ahora, "disponible": True}) \
            .eq("id_usuario", session["user_id"]) \
            .eq("estado", "activa") \
            .execute()

        # Crea nueva sesión
        sb_admin.table("telescopio_sesion").insert({
            "id_telescopio": id_telescopio,
            "id_usuario": session["user_id"],
            "inicio_sesion": ahora,
            "estado": "activa",
            "disponible": True
        }).execute()

        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

@app.get("/api/sesion/activa/<int:id_telescopio>")
def api_sesion_activa(id_telescopio):
    err = _require_login()
    if err:
        return err

    r = sb_admin.table("telescopio_sesion") \
        .select("*") \
        .eq("id_telescopio", id_telescopio) \
        .eq("estado", "activa") \
        .order("inicio_sesion", desc=True) \
        .limit(1) \
        .execute()

    return jsonify({"ok": True, "data": r.data[0] if r.data else None})

@app.post("/api/sesion/finalizar")
def api_sesion_finalizar():
    err = _require_login()
    if err:
        return err

    data = request.get_json(force=True) or {}
    id_sesion = data.get("id_sesion")

    if not id_sesion:
        return jsonify({"ok": False, "error": "Falta id_sesion"}), 400

    ahora = _now_utc_iso()

    try:
        sb_admin.table("telescopio_sesion") \
            .update({"estado": "finalizada", "fin_sesion": ahora, "disponible": True}) \
            .eq("id_sesion", id_sesion) \
            .execute()

        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

@app.get("/api/sesiones/usuario/<uuid:id_usuario>")
def api_sesiones_usuario(id_usuario):
    err = _require_login()
    if err:
        return err

    r = sb_admin.table("telescopio_sesion") \
        .select("*") \
        .eq("id_usuario", str(id_usuario)) \
        .order("inicio_sesion", desc=True) \
        .execute()

    return jsonify({"ok": True, "data": r.data})
# COLA FIFO

@app.get("/api/cola/<int:id_telescopio>")
def api_cola_fifo(id_telescopio):
    err = _require_login()
    if err:
        return err

    r = sb_admin.table("queue") \
        .select("*") \
        .eq("id_telescopio", id_telescopio) \
        .order("timestamp_ingreso", desc=False) \
        .execute()

    return jsonify({"ok": True, "data": r.data})

@app.post("/api/cola/entrar")
def api_cola_entrar():
    if "user_id" not in session:
        return jsonify({"ok": False, "error": "No auth"}), 401

    data = request.get_json(force=True) or {}

    try:
        id_telescopio = int(data.get("id_telescopio"))
    except Exception:
        return jsonify({"ok": False, "error": "id_telescopio inválido"}), 400

    id_usuario = session["user_id"]

    try:
        # Evita duplicados
        exist = sb_admin.table("queue") \
            .select("id_queue") \
            .eq("id_telescopio", id_telescopio) \
            .eq("id_usuario", id_usuario) \
            .limit(1) \
            .execute()

        if exist.data:
            return jsonify({"ok": False, "error": "ux_queue_telescopio_usuario"}), 409

        ahora = datetime.now(timezone.utc).isoformat()

        ins = sb_admin.table("queue").insert({
            "id_telescopio": id_telescopio,
            "id_usuario": id_usuario,
            "timestamp_ingreso": ahora,
            "prioridad": "FIFO"   
        }).execute()

        return jsonify({"ok": True, "data": ins.data[0] if ins.data else None})

    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.post("/api/cola/asignar")
def api_cola_asignar():
    if "email" not in session:
        return jsonify({"ok": False, "error": "No auth"}), 401

    data = request.get_json(force=True) or {}
    id_telescopio = data.get("id_telescopio")

    if not id_telescopio:
        return jsonify({"ok": False, "error": "Falta id_telescopio"}), 400

    try:
        id_telescopio = int(id_telescopio)
    except Exception:
        return jsonify({"ok": False, "error": "id_telescopio inválido"}), 400

    try:
        # 1) Tomar el primero de la cola FIFO
        q = (
            sb_admin.table("queue")
            .select("*")
            .eq("id_telescopio", id_telescopio)
            .order("timestamp_ingreso", desc=False)
            .limit(1)
            .execute()
        )

        if not q.data:
            return jsonify({"ok": True, "data": None, "msg": "Cola vacía"})

        next_item = q.data[0]
        id_usuario = next_item["id_usuario"]
        id_queue = next_item["id_queue"]

        # 2) Sacarlo de la cola
        sb_admin.table("queue").delete().eq("id_queue", id_queue).execute()

        # 3) Ver si la cola quedó vacía (para decidir ILIMITADO vs 10 min)
        resto = (
            sb_admin.table("queue")
            .select("id_queue")
            .eq("id_telescopio", id_telescopio)
            .limit(1)
            .execute()
        )

        ahora = datetime.now(timezone.utc)

        # Si todavía hay cola tiene 10 min, si no hay cola tiene ilimitado
        fin_sesion = (ahora + timedelta(minutes=10)).isoformat() if resto.data else None

        # 4) Crear sesión activa para el usuario asignado
        ins = sb_admin.table("telescopio_sesion").insert({
            "id_telescopio": id_telescopio,
            "id_usuario": id_usuario,
            "inicio_sesion": ahora.isoformat(),
            "fin_sesion": fin_sesion, 
            "estado": "activa",
            "disponible": True         
        }).execute()

        return jsonify({"ok": True, "data": ins.data[0] if ins.data else None})

    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

@app.post("/api/acceso/solicitar")
def api_acceso_solicitar():
    if "user_id" not in session:
        return jsonify({"ok": False, "error": "No auth"}), 401

    data = request.get_json(force=True) or {}
    try:
        id_telescopio = int(data.get("id_telescopio"))
    except Exception:
        return jsonify({"ok": False, "error": "id_telescopio inválido"}), 400

    user_id = session["user_id"]

    # 1) Ver si hay sesión activa en ese telescopio
    activa = (
        sb_admin.table("telescopio_sesion")
        .select("id_sesion,id_usuario,estado,inicio_sesion,fin_sesion")
        .eq("id_telescopio", id_telescopio)
        .eq("estado", "activa")
        .order("inicio_sesion", desc=True)
        .limit(1)
        .execute()
    )

    if not activa.data:
        # Telescopio libre -> crear sesión directa ILIMITADA
        ahora = datetime.now(timezone.utc)

        ins = sb_admin.table("telescopio_sesion").insert({
            "id_telescopio": id_telescopio,
            "id_usuario": user_id,
            "inicio_sesion": ahora.isoformat(),
            "fin_sesion": None,          # Ilimitado mientras no haya cola
            "estado": "activa",
            "disponible": True          
        }).execute()

        return jsonify({
            "ok": True,
            "modo": "ACCESO_DIRECTO",
            "sesion": ins.data[0] if ins.data else None,
            "msg": "Telescopio libre. Acceso otorgado."
        })

    # 2) Si hay sesión activa -> entrar a cola FIFO
    # Evitar duplicados (no dejar que el mismo usuario se meta 2 veces)
    exist = (
        sb_admin.table("queue")
        .select("id_queue")
        .eq("id_telescopio", id_telescopio)
        .eq("id_usuario", user_id)
        .limit(1)
        .execute()
    )

    if exist.data:
        return jsonify({"ok": True, "modo": "EN_COLA", "msg": "Ya estás en la cola FIFO."})

    ahora_iso = datetime.now(timezone.utc).isoformat()

    ins = sb_admin.table("queue").insert({
        "id_telescopio": id_telescopio,
        "id_usuario": user_id,
        "timestamp_ingreso": ahora_iso,
        "prioridad": "FIFO"
    }).execute()

    #Si alguien entra a cola y el activo estaba ILIMITADO (fin_sesion == None),
    # entonces al activo se le asigna 10 minutos desde AHORA.
    ses_activa = activa.data[0]  # ya existe porque entramos por el else
    fin_actual = ses_activa.get("fin_sesion")

    if fin_actual is None:
        ahora_dt = datetime.now(timezone.utc)
        fin_dt = ahora_dt + timedelta(minutes=10)

        sb_admin.table("telescopio_sesion") \
            .update({"fin_sesion": fin_dt.isoformat()}) \
            .eq("id_sesion", ses_activa["id_sesion"]) \
            .execute()

    return jsonify({
        "ok": True,
        "modo": "EN_COLA",
        "queue": ins.data[0] if ins.data else None,
        "msg": "Telescopio ocupado. Entraste a la cola FIFO."
    })

@app.get("/api/observacion/activa/<uuid:id_sesion>")
def api_observacion_activa(id_sesion):
    if "email" not in session:
        return jsonify({"ok": False, "error": "No auth"}), 401

    r = sb_admin.table("observacion") \
        .select("*") \
        .eq("id_sesion", str(id_sesion)) \
        .eq("estado", "en curso") \
        .order("fecha_inicio", desc=True) \
        .limit(1) \
        .execute()

    return jsonify({"ok": True, "data": r.data[0] if r.data else None})
@app.post("/api/observacion/finalizar")
def api_observacion_finalizar():
    # auth
    if "email" not in session or "user_id" not in session:
        return jsonify({"ok": False, "error": "No auth"}), 401
    data = request.get_json(force=True) or {}
    id_observacion = (
        data.get("id_observacion")
        or data.get("idObservacion")
        or data.get("id")
    )

    ahora = datetime.now(timezone.utc).isoformat()

    # si no viene id_observacion, resuelve por id_sesion (observación en curso)
    if not id_observacion:
        id_sesion = data.get("id_sesion")
        if not id_sesion:
            return jsonify({"ok": False, "error": "Falta id_observacion o id_sesion"}), 400

        r = sb_admin.table("observacion") \
            .select("id_observacion") \
            .eq("id_sesion", str(id_sesion)) \
            .eq("estado", "en curso") \
            .order("fecha_inicio", desc=True) \
            .limit(1) \
            .execute()

        if not r.data:
            return jsonify({"ok": False, "error": "No hay observación en curso para esa sesión"}), 404

        id_observacion = r.data[0]["id_observacion"]

    # 1) Finaliza (esto NO debe fallar por la foto)
    sb_admin.table("observacion") \
        .update({"estado": "finalizada", "fecha_fin": ahora}) \
        .eq("id_observacion", id_observacion) \
        .execute()

    # 2) Intentar subir foto
    warning = None
    try:
        foto_path = subir_foto_y_guardar_path(str(id_observacion))
        print("Foto subida OK:", foto_path)
    except Exception as e:
        warning = f"No se pudo subir foto: {str(e)}"
        print(warning)
        sb_admin.table("observacion") \
            .update({"descripcion": warning}) \
            .eq("id_observacion", id_observacion) \
            .execute()

    return jsonify({"ok": True, "id_observacion": id_observacion, "warning": warning})



@app.post("/api/sesion/disponible")
def api_sesion_disponible():
    if "email" not in session:
        return jsonify({"ok": False, "error": "No auth"}), 401

    data = request.get_json(force=True) or {}
    id_sesion = data.get("id_sesion")
    disponible = data.get("disponible")

    if id_sesion is None or disponible is None:
        return jsonify({"ok": False, "error": "Falta id_sesion o disponible"}), 400

    sb_admin.table("telescopio_sesion") \
        .update({"disponible": bool(disponible)}) \
        .eq("id_sesion", id_sesion) \
        .execute()

    return jsonify({"ok": True})
@app.post("/api/observacion/en-curso")
def api_observacion_en_curso():
    if "email" not in session:
        return jsonify({"ok": False, "error": "No auth"}), 401

    data = request.get_json(force=True) or {}

    id_sesion = data.get("id_sesion")
    objeto = data.get("objeto_celeste")

    if not id_sesion or not objeto:
        return jsonify({"ok": False, "error": "Falta id_sesion u objeto_celeste"}), 400

    payload = {
        "id_sesion": str(id_sesion),
        "objeto_celeste": objeto,
        "fecha_inicio": data.get("fecha_inicio") or datetime.now(timezone.utc).isoformat(),
        "estado": "en curso",
        "usuario_control": session["user_id"],

        "descripcion": data.get("descripcion"),
        "fecha_busqueda": data.get("fecha_busqueda"),
        "coord_azimut": data.get("coord_azimut"),
        "coord_altitud": data.get("coord_altitud"),
    }
    payload = {k: v for k, v in payload.items() if v is not None}

    # Insertar
    sb_admin.table("observacion").insert(payload).execute()

    # Reconsultar y devolver la observación activa real
    r = sb_admin.table("observacion") \
        .select("*") \
        .eq("id_sesion", str(id_sesion)) \
        .eq("estado", "en curso") \
        .order("fecha_inicio", desc=True) \
        .limit(1) \
        .execute()

    return jsonify({"ok": True, "data": r.data[0] if r.data else None})


# CONFIGURACIPÓN TELESCOPIO 

@app.get("/api/telescopio/config/<int:id_telescopio>")
def api_telescopio_config_get(id_telescopio):
    err = _require_login()
    if err:
        return err

    r = sb_admin.table("telescopio_config") \
        .select("tipo,host,puerto") \
        .eq("id_telescopio", id_telescopio) \
        .execute()
    data = {}
    for row in (r.data or []):
        data[row["tipo"]] = {"host": row["host"], "puerto": row["puerto"]}

    return jsonify({"ok": True, "data": data})


@app.post("/api/telescopio/config")
def api_telescopio_config_upsert():
    err = _require_login()
    if err:
        return err

    data = request.get_json(force=True) or {}
    try:
        id_telescopio = int(data.get("id_telescopio"))
    except Exception:
        return jsonify({"ok": False, "error": "id_telescopio inválido"}), 400

    tipo = (data.get("tipo") or "").strip()
    host = (data.get("host") or "").strip()
    try:
        puerto = int(data.get("puerto") or 80)
    except Exception:
        return jsonify({"ok": False, "error": "puerto inválido"}), 400

    if tipo not in ("esp32_base", "esp32_cam", "stellarium"):
        return jsonify({"ok": False, "error": "tipo inválido"}), 400

    if not host:
        return jsonify({"ok": False, "error": "host requerido"}), 400

    ahora = _now_utc_iso()
    try:
        sb_admin.table("telescopio_config").upsert({
            "id_telescopio": id_telescopio,
            "tipo": tipo,
            "host": host,
            "puerto": puerto,
            "actualizado_el": ahora
        }, on_conflict="id_telescopio,tipo").execute()

        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.get("/api/observacion/<id_observacion>/foto")
def api_observacion_foto(id_observacion):
    err = _require_login()
    if err:
        return err

    # Traer foto_path + dueño
    r = sb_admin.table("observacion") \
        .select("foto_path,usuario_control") \
        .eq("id_observacion", id_observacion) \
        .limit(1) \
        .execute()

    if not r.data:
        return jsonify({"ok": False, "error": "Observación no encontrada"}), 404

    obs = r.data[0]

    # bloquear si no es del usuario
    if str(obs.get("usuario_control")) != str(session["user_id"]):
        return jsonify({"ok": False, "error": "No autorizado"}), 403

    foto_path = obs.get("foto_path")
    if not foto_path:
        return jsonify({"ok": False, "error": "Sin foto asociada"}), 404

    signed = sb_admin.storage.from_(BUCKET_FOTOS).create_signed_url(foto_path, 60)
    signed_url = signed.get("signedURL") or signed.get("signedUrl")

    if not signed_url:
        return jsonify({"ok": False, "error": "No se pudo generar URL firmada"}), 500

    return redirect(signed_url, code=302)

@app.get("/api/observaciones/mias")
def api_listar_observaciones_mias():
    err = _require_login()
    if err:
        return err

    q = request.args.get("q", "").strip()
    estado = request.args.get("estado", "").strip()
    desde = request.args.get("desde", "").strip()
    hasta = request.args.get("hasta", "").strip()

    query = sb_admin.table("observacion").select(
        "id_observacion,objeto_celeste,fecha_inicio,fecha_fin,estado,coord_azimut,coord_altitud,foto_path"
    ).eq("usuario_control", session["user_id"]) \
     .order("fecha_inicio", desc=True).limit(200)

    if estado:
        query = query.eq("estado", estado)

    if q:
        # búsqueda simple por objeto_celeste
        query = query.ilike("objeto_celeste", f"%{q}%")

    if desde:
        query = query.gte("fecha_inicio", desde)

    if hasta:
        query = query.lte("fecha_inicio", hasta)

    r = query.execute()
    return jsonify({"ok": True, "items": r.data or []})


@app.get("/api/observaciones")
def api_listar_observaciones():

    if "email" not in session or "user_id" not in session:
        return jsonify({"ok": False, "error": "No auth"}), 401

    q = (request.args.get("q") or "").strip().lower()
    estado = (request.args.get("estado") or "").strip()
    desde = (request.args.get("desde") or "").strip()  
    hasta = (request.args.get("hasta") or "").strip()  

    query = sb_admin.table("observacion").select(
    "id_observacion,objeto_celeste,fecha_inicio,fecha_fin,estado,coord_azimut,coord_altitud,foto_path,usuario_control"
).eq("usuario_control", session["user_id"]) \
 .order("fecha_inicio", desc=True).limit(200)

    if estado:
        query = query.eq("estado", estado)

    if desde:
        query = query.gte("fecha_inicio", f"{desde}T00:00:00")

    if hasta:
        query = query.lte("fecha_inicio", f"{hasta}T23:59:59")

    res = query.execute()
    data = res.data or []
    if q:
        data = [o for o in data if (o.get("objeto_celeste") or "").lower().find(q) >= 0]


    return jsonify({"ok": True, "items": data})
@app.route("/api/observacion/coords", methods=["POST"])
def observacion_coords():
    payload = request.get_json(force=True) or {}
    id_obs = payload.get("id_observacion")
    az = payload.get("coord_azimut")
    alt = payload.get("coord_altitud")

    if not id_obs:
        return jsonify(ok=False, error="Falta id_observacion"), 400

    # Actualiza en DB
    try:
        res = supabase.table("observacion").update({
            "coord_azimut": az,
            "coord_altitud": alt
        }).eq("id_observacion", id_obs).execute()

        return jsonify(ok=True, updated=True)
    except Exception as e:
        return jsonify(ok=False, error=str(e)), 500

# ======================
# MAIN
# ======================
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
