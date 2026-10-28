import { COOLDOWN_MS } from './config.js';
import { sleep } from './utils/delay.js';
import { logger } from './utils/logger.js';

/**
 * Cola de tareas secuencial con cooldown obligatorio para proteger la cuenta contra ráfagas.
 */
class MessageQueue {
  constructor() {
    this.queue = [];
    this.isProcessing = false;
    this.lastProcessedTime = 0;
  }

  /**
   * Añade una función asíncrona a la cola de ejecución.
   * @param {() => Promise<void>} taskFn 
   */
  enqueue(taskFn) {
    return new Promise((resolve, reject) => {
      this.queue.push({
        taskFn,
        resolve,
        reject
      });
      this.processNext();
    });
  }

  async processNext() {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;
    const { taskFn, resolve, reject } = this.queue.shift();

    try {
      // Verificar si ha transcurrido el tiempo de cooldown mínimo
      const now = Date.now();
      const elapsed = now - this.lastProcessedTime;
      if (this.lastProcessedTime > 0 && elapsed < COOLDOWN_MS) {
        const waitTime = COOLDOWN_MS - elapsed;
        logger.info({ waitTime }, `[Rate-Limit] Esperando cooldown de ${waitTime}ms para evitar ráfagas...`);
        await sleep(waitTime);
      }

      // Ejecutar la tarea
      const result = await taskFn();
      this.lastProcessedTime = Date.now();
      resolve(result);
    } catch (error) {
      this.lastProcessedTime = Date.now();
      reject(error);
    } finally {
      this.isProcessing = false;
      // Continuar con la siguiente tarea en la cola si existe
      if (this.queue.length > 0) {
        setImmediate(() => this.processNext());
      }
    }
  }
}

export const messageQueue = new MessageQueue();
