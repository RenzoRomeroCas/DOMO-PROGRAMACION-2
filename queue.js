import { asignarSiguienteDeCola } from "./api.js";

export async function procesarCola(id_telescopio){
  return await asignarSiguienteDeCola(id_telescopio);
}
