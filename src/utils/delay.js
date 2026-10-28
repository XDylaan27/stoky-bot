/**
 * Utilidades para temporizadores y simulación de comportamiento humano
 */

/**
 * Espera una cantidad fija de milisegundos.
 * @param {number} ms 
 * @returns {Promise<void>}
 */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Genera un número entero aleatorio en un rango inclusivo [min, max].
 * @param {number} min 
 * @param {number} max 
 * @returns {number}
 */
export const randomBetween = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

/**
 * Pausa la ejecución por un tiempo aleatorio entre min y max milisegundos.
 * Útil para simular pausas de lectura o escritura humana.
 * @param {number} min 
 * @param {number} max 
 * @returns {Promise<number>} Tiempo efectivamente esperado en ms
 */
export const humanDelay = async (min = 600, max = 1500) => {
  const waitMs = randomBetween(min, max);
  await sleep(waitMs);
  return waitMs;
};
