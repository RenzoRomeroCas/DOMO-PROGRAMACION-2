import { registrarObservacion } from "./api.js";

export async function registrarDesdeStellarium(data){
  if(!data.id_sesion) throw new Error("Falta id_sesion");
  if(typeof data.coord_azimut !== "number") throw new Error("Azimut inválido");
  if(typeof data.coord_altitud !== "number") throw new Error("Altitud inválida");

  return await registrarObservacion({
    id_sesion: data.id_sesion,
    objeto_celeste: data.objeto_celeste || null,
    coord_azimut: data.coord_azimut,
    coord_altitud: data.coord_altitud,
    descripcion: data.descripcion || null
  });
}
