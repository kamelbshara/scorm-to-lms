import { database, migrate } from '../db.js';
import { createApp } from '../server.js';
import { startupMessage } from '../setup-errors.js';

// Cache initialization within each warm function instance; retry failed cold starts.
export function handlerFor({ connect = () => database(process.env.DATABASE_URL), appOptions = {} } = {}) {
  let ready;
  return async (req, res) => {
    try {
      ready ??= (async () => {
        const db = connect();
        const app = createApp(db, appOptions);
        await migrate(db);
        return app;
      })().catch(error => { ready = undefined; throw error; });
      const app = await ready;
      return app(req, res);
    } catch (error) {
      console.error('Application initialization failed:', error.code || error.sourceError?.code || error.name);
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: startupMessage(error) }));
    }
  };
}
export default handlerFor();
